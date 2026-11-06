'use strict';
// The service's work, step by step:
//   1. Gmail tells Pub/Sub a mailbox changed ({ emailAddress, historyId }); Pub/Sub pushes it here.
//   2. The messages added to its Inbox since the last change are fetched (raw, as received).
//   3. Each is read (engine/mime) and judged (engine/analyze) like the extension judges an opened
//      email, and the policy (policy.js) decides: move to Spam, record only, or nothing.
//   4. The decision is carried out and recorded for the dashboard (nothing of the email's text is kept:
//      sender, subject and the checks' findings only; see docs/PRIVACY.md).
// Every step is safe to repeat: a message already analyzed is skipped, so a repeated notification does
// nothing twice.
const crypto = require('crypto');
const { readMessage } = require('./engine/mime');
const { analyze } = require('./engine/analyze');
const { decide, isAllowed } = require('./policy');
const { GoogleApiError } = require('./gmail/client');

const DAY = 24 * 60 * 60 * 1000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// Sender addresses are remembered as a hash only (as the extension's senderHistoryKey).
const senderHash = (address) => crypto.createHash('sha256').update(String(address || '').toLowerCase()).digest('hex').slice(0, 16);
const recordKey = (user, messageId) => `${user}|${messageId}`;

// Emails of one campaign share a sender domain and a subject once numbers, the recipient's name and
// spacing are taken out ("Invoice 4471 for alex" ~ "Invoice 9920 for sam").
function campaignOf(senderDomain, subject, user) {
    const local = String(user || '').split('@')[0].toLowerCase();
    let s = String(subject || '').toLowerCase().normalize('NFKC');
    // The recipient's mailbox name and its parts ("rowan.ibarra", "rowan", "ibarra").
    for (const part of [local, ...local.split(/[._-]+/)].filter(p => p.length >= 3)) s = s.split(part).join('');
    s = s.replace(/^(re|fw|fwd)\s*:\s*/g, '').replace(/[0-9]+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim().slice(0, 120);
    const key = crypto.createHash('sha256').update(`${senderDomain}|${s}`).digest('hex').slice(0, 12);
    return { key, label: `${senderDomain}: ${s || '(no subject)'}`.slice(0, 160) };
}

class Service {
    constructor({ cfg, store, gmail, intel = null, now = () => Date.now(), log = console }) {
        this.cfg = cfg; this.store = store; this.gmail = gmail; this.intel = intel; this.now = now; this.log = log;
    }

    async inScope(user) {
        if (this.cfg.pilotUsers.includes(user)) return true;
        const u = await this.store.getUser(user);
        return !!(u && u.watched);
    }

    // A Pub/Sub notification. Returns a summary (for logs and tests).
    async handleNotification({ emailAddress, historyId }) {
        const user = String(emailAddress || '').toLowerCase();
        if (!user || !historyId) return { ignored: 'malformed' };
        if (!(await this.inScope(user))) return { ignored: 'not watched' };
        const u = (await this.store.getUser(user)) || {};
        await this.store.putUser(user, { lastNotification: this.now() });
        if (!u.historyId) { await this.store.putUser(user, { historyId: String(historyId) }); return { started: true }; }
        let added;
        try { added = await this.gmail.addedSince(user, u.historyId); }
        catch (e) {
            if (e instanceof GoogleApiError && e.status === 404) {
                // Too long since the last change we know of (Gmail keeps about a week): start again from now.
                const p = await this.gmail.profile(user);
                await this.store.putUser(user, { historyId: String(p.historyId) });
                await this.store.addEvent({ kind: 'gap', user, text: `Changes to ${user}'s mailbox were missed (history too old); checking resumed from now.` });
                return { resynced: true };
            }
            throw e;
        }
        const results = [];
        // Emails the service moved that the user took back to the Inbox. (One judged in this same batch is
        // skipped: its Inbox label came before the move.)
        const judgedNow = new Set(added.ids);
        for (const id of added.inboxed || []) {
            if (judgedNow.has(id)) continue;
            try { await this.userReleased(user, id); } catch (e) { this.log.error(`user release ${user} ${id}:`, e); }
        }
        for (const id of added.ids) {
            try { results.push(await this.processMessage(user, id)); }
            catch (e) {
                await this.store.incStat(dayOf(this.now()), 'errors');
                await this.store.addEvent({ kind: 'error', user, text: `A message couldn't be checked: ${String(e && e.message || e).slice(0, 300)}` });
                this.log.error(`process ${user} ${id}:`, e);
            }
        }
        if (String(added.historyId) !== String(u.historyId)) await this.store.putUser(user, { historyId: String(added.historyId) });
        return { processed: results.filter(Boolean).length, results };
    }

    async processMessage(user, id) {
        if (await this.store.seen(user, id)) return null;
        const msg = await this.gmail.raw(user, id);
        await this.store.markSeen(user, id);
        // Only mail that arrived in the Inbox: not the user's own sent mail or drafts, nor what Gmail already put in Spam.
        if (!msg.labelIds.includes('INBOX') || msg.labelIds.some(l => l === 'SENT' || l === 'DRAFT' || l === 'SPAM')) return null;
        const facts = await readMessage(msg.raw);
        return this.judge(user, msg, facts);
    }

    // Analysis, decision, action and record for one message (also used by the tests and the demo).
    async judge(user, msg, facts) {
        const now = this.now();
        const day = dayOf(now);
        await this.store.incStat(day, 'scanned');
        const installedAt = (await this.store.getState('installedAt')) || (await this.store.setState('installedAt', now), now);
        const first = facts.senderAddress ? await this.store.senderFirstSeen(senderHash(facts.senderAddress), now) : now;
        const learning = now - installedAt < this.cfg.firstSeenLearningDays * DAY;
        const result = await analyze(facts, { mailbox: user, orgDomains: this.cfg.orgDomains, trusted: isAllowed(this.cfg, facts.senderAddress), firstTime: !learning && now - first < DAY, intel: this.intel });
        const brake = await this.brakeOn(now);
        const decision = decide(result, this.cfg, { brake });
        if (decision.action === 'none') return { user, messageId: msg.id, action: 'none', status: result.status, ai: result.ai && result.ai.probability };

        let state = 'inbox';
        if (decision.action === 'move') {
            const moved = await this.gmail.labelId(user, this.cfg.movedLabel);
            await this.gmail.modify(user, msg.id, ['SPAM', moved], ['INBOX']);
            state = 'moved';
        } else if (decision.action === 'would-move' && this.cfg.monitorLabel) {
            await this.gmail.modify(user, msg.id, [await this.gmail.labelId(user, this.cfg.monitorLabel)], []);
        }
        const senderDomain = (facts.senderAddress.split('@')[1] || '').toLowerCase();
        const campaign = campaignOf(senderDomain, facts.subject, user);
        const rec = {
            key: recordKey(user, msg.id), user, messageId: msg.id, threadId: msg.threadId || '',
            receivedAt: msg.internalDate || facts.date || now, processedAt: now,
            sender: { name: facts.senderName.slice(0, 200), address: facts.senderAddress.slice(0, 320), domain: senderDomain },
            subject: this.cfg.storeSubjects ? facts.subject.slice(0, 300) : '',
            campaign: campaign.key, campaignLabel: this.cfg.storeSubjects ? campaign.label : senderDomain,
            status: result.status, score: result.score, signals: result.signals.slice(0, 20), links: result.links.slice(0, 10), checks: result.checks || null,
            ai: result.ai ? { probability: result.ai.probability, model: result.ai.model,
                              reasons: this.cfg.storeAiQuotes ? (result.ai.reasons || []).map(r => ({ sentence: String(r.sentence).slice(0, 160), facts: !!r.facts })) : [] } : null,
            auth: facts.auth ? { dmarc: facts.auth.dmarc, spf: facts.auth.spf, dkim: facts.auth.dkim } : null,
            attachments: facts.attachments.slice(0, 10).map(a => ({ name: a.name.slice(0, 120), type: a.type })),
            action: decision.action, trigger: decision.trigger, why: decision.why, braked: !!decision.braked, mode: this.cfg.mode,
            state, releasedBy: null, releasedAt: null, falseAlarm: null, markedBy: null
        };
        await this.store.saveRecord(rec);
        await this.store.incStat(day, decision.action === 'move' ? 'moved' : decision.action === 'would-move' ? 'wouldMove' : 'flagged');
        if (decision.action === 'move') await this.checkBrake(now);
        return rec;
    }

    async brakeOn() { return !!(await this.store.getState('brake')); }
    // More moves in the last hour than BRAKE_PER_HOUR: stop moving until an admin resumes.
    async checkBrake(now) {
        if (await this.brakeOn()) return;
        const n = await this.store.countActions(now - 60 * 60 * 1000, 'move');
        if (n >= this.cfg.brakePerHour) {
            await this.store.setState('brake', { at: now, moves: n });
            await this.store.addEvent({ kind: 'brake', text: `${n} emails were moved in the last hour (limit ${this.cfg.brakePerHour}). Moving has stopped; suspicious mail is only recorded until an admin resumes in the dashboard.` });
        }
    }
    async resume(by) {
        await this.store.setState('brake', null);
        await this.store.addEvent({ kind: 'resume', text: `Moving resumed by ${by}.` });
    }

    // Puts a moved email back in the Inbox (and records who did it).
    async release(key, by) {
        const rec = await this.store.getRecord(key);
        if (!rec) return { error: 'not found' };
        if (rec.state !== 'moved') return { error: `it is ${rec.state === 'released' ? 'already released' : 'still in the Inbox'}` };
        const released = await this.gmail.labelId(rec.user, this.cfg.releasedLabel);
        const moved = await this.gmail.labelId(rec.user, this.cfg.movedLabel);
        // Noted first: the Inbox label this adds comes back in the history, and must not read as the user's.
        await this.store.updateRecord(key, { releasingAt: this.now() });
        await this.gmail.modify(rec.user, rec.messageId, ['INBOX', released], ['SPAM', moved]);
        const now = this.now();
        const out = await this.store.updateRecord(key, { state: 'released', releasedBy: by, releasedByUser: false, releasedAt: now, falseAlarm: rec.falseAlarm === null ? true : rec.falseAlarm, markedBy: rec.markedBy || by });
        await this.store.incStat(dayOf(now), 'released');
        await this.store.addEvent({ kind: 'release', user: rec.user, text: `${by} released an email from ${rec.sender.address} to ${rec.user}.` });
        return { record: out };
    }
    // The user moved an email the service had put in Spam back to the Inbox (or marked it "Not spam"). The
    // service never moves it again; the record says so, counts as a false alarm (an admin can still mark
    // it phishing, which matters: a user who rescued real phishing may be about to click it).
    async userReleased(user, messageId) {
        const key = recordKey(user, messageId);
        const rec = await this.store.getRecord(key);
        if (!rec || rec.state !== 'moved') return null;
        const now = this.now();
        if (rec.releasingAt && now - rec.releasingAt < 10 * 60 * 1000) return null; // an admin's release under way
        const out = await this.store.updateRecord(key, { state: 'released', releasedBy: user, releasedByUser: true, releasedAt: now,
            falseAlarm: rec.falseAlarm === null || rec.falseAlarm === undefined ? true : rec.falseAlarm, markedBy: rec.markedBy || null });
        await this.store.incStat(dayOf(now), 'released');
        await this.store.incStat(dayOf(now), 'userReleased');
        const strong = rec.score >= 5 && rec.trigger !== 'ai';
        await this.store.addEvent({ kind: 'user-release', user, key,
            text: strong ? `${user} moved an email from ${rec.sender.address} back to the Inbox, though the checks flagged it (score ${rec.score}). Make sure it's safe, or mark it phishing and warn them.`
                         : `${user} moved an email from ${rec.sender.address} back to the Inbox (counted as a false alarm).` });
        return out;
    }

    // An admin's judgment of a record: a false alarm (genuine) or right (phishing or spam).
    async mark(key, falseAlarm, by) {
        const rec = await this.store.getRecord(key);
        if (!rec) return { error: 'not found' };
        const out = await this.store.updateRecord(key, { falseAlarm: !!falseAlarm, markedBy: by });
        if (falseAlarm && rec.falseAlarm !== true) await this.store.incStat(dayOf(this.now()), 'falseAlarms');
        return { record: out };
    }

    // Cloud Scheduler, daily: watch every pilot mailbox again (a watch lasts 7 days) and forget
    // mailboxes that left the pilot.
    async renewWatches() {
        const users = new Set(this.cfg.pilotUsers);
        if (this.cfg.pilotOu) for (const u of await this.gmail.usersInOu(this.cfg.directoryAdmin, this.cfg.pilotOu)) users.add(u);
        let ok = 0, failed = 0;
        for (const user of users) {
            try {
                const w = await this.gmail.watch(user, this.cfg.pubsubTopic);
                const known = await this.store.getUser(user);
                await this.store.putUser(user, Object.assign({ watched: true, watchExpiration: Number(w.expiration) || null }, known && known.historyId ? {} : { historyId: String(w.historyId) }));
                ok++;
            } catch (e) {
                failed++;
                await this.store.addEvent({ kind: 'error', user, text: `Couldn't watch ${user}'s mailbox: ${String(e.message).slice(0, 200)}` });
            }
        }
        for (const u of await this.store.listUsers()) {
            if (u.watched && !users.has(u.email)) {
                try { await this.gmail.stop(u.email); } catch (e) { /* already stopped */ }
                await this.store.putUser(u.email, { watched: false });
            }
        }
        return { watched: ok, failed };
    }

    // Switching the service off: Gmail stops notifying for every watched mailbox. (Also remove the
    // Scheduler job that renews watches, or it starts them again; docs/DEPLOY.md.)
    async stopAll() {
        let stopped = 0;
        for (const u of await this.store.listUsers()) {
            if (!u.watched) continue;
            try { await this.gmail.stop(u.email); } catch (e) { /* already stopped */ }
            await this.store.putUser(u.email, { watched: false });
            stopped++;
        }
        await this.store.addEvent({ kind: 'mode', text: `All ${stopped} mailbox watches were stopped.` });
        return { stopped };
    }

    // Cloud Scheduler, daily: records older than RETENTION_DAYS are deleted.
    purge() { return this.store.purge(this.now() - this.cfg.retentionDays * DAY); }

    // Cloud Scheduler, daily: the phishing lists are downloaded once for everyone (src/intel/feeds.js).
    async syncFeeds() {
        if (!this.intel || !this.intel.feeds) return { skipped: 'phishing lists are off' };
        return this.intel.feeds.sync();
    }
}

module.exports = { Service, campaignOf, senderHash, recordKey, dayOf };
