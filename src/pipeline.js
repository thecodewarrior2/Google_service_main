'use strict';
// The service's work, step by step:
//   1. Gmail tells Pub/Sub a mailbox changed ({ emailAddress, historyId }); Pub/Sub pushes it here.
//   2. The messages added to its Inbox since the last change are fetched (raw, as received).
//   3. Each is read (engine/mime) and judged (engine/analyze) like the extension judges an opened
//      email, and the policy (policy.js) decides: move to Spam, record only, or nothing.
//   4. The decision is carried out and recorded for the dashboard (nothing of the email's text is kept:
//      sender, subject and the checks' findings only; see docs/PRIVACY.md).
// Every step is safe to repeat: a message already analyzed is skipped, so a repeated notification does
// nothing twice. One instance at a time judges a message (it claims it first). A message whose check
// failed is tried again (MAX_TRIES in all) when Pub/Sub delivers the notification again: until every
// listed message is done, the mailbox's sync position stays where it was, and it only ever moves forward.
const crypto = require('crypto');
const { readMessage } = require('./engine/mime');
const { analyze, senderVerified } = require('./engine/analyze');
const { decide, isAllowed } = require('./policy');
const { GoogleApiError } = require('./gmail/client');
const { compareHistoryIds } = require('./store/history');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MAX_TRIES = 3;
// How long a claim keeps other instances off a message: longer than a request may run (the worker's
// timeout is 120 s), so only a claim left by an instance that stopped is taken over.
const CLAIM_LEASE_MS = 5 * 60 * 1000;
// How long a notification waits for messages another instance is judging before it keeps the place.
const WAIT_FOR_OTHERS_MS = 5000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);
// The address in a From header ("Name <a@b>" or "a@b").
const addressOf = (from) => { const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(String(from || '')); return (m ? m[1] : String(from || '').trim()).toLowerCase(); };
// Runs fn over items, n at a time, until stop() says so.
async function pool(items, n, fn, stop = () => false) {
    let i = 0;
    const worker = async () => { while (i < items.length && !stop()) { const item = items[i++]; await fn(item); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
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

// "Watching 3 mailboxes. spruce-pilot@…: 5 entries, 3 people watched; left out: 1 not active, 1 outside
// your domains (elsewhere.example). 1 couldn't be watched (see the error)."
function watchSummary({ ok, failed, stopped, groups, extra, ou, orgDomains }) {
    const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    const parts = [`Watching ${n(ok, 'mailbox', 'mailboxes')}.`];
    for (const g of groups) {
        const out = [];
        if (g.inactive) out.push(`${g.inactive} not active (suspended or archived)`);
        if (g.outside) out.push(`${g.outside} outside your domains (${g.outsideDomains.join(', ')}; ORG_DOMAINS is ${orgDomains.join(', ')})`);
        if (g.everyone) out.push(`${n(g.everyone, '"all users in the organization" entry', '"all users in the organization" entries')}, which ${g.everyone === 1 ? "isn't" : "aren't"} expanded: add people or groups instead`);
        parts.push(`${g.group}: ${n(g.entries, 'entry', 'entries')}${g.groups ? ` (${n(g.groups, 'group')} inside it, whose members are listed too)` : ''}, ${n(g.people, 'person', 'people')} to watch${out.length ? `; left out: ${out.join(', ')}` : ''}.`);
    }
    if (ou) parts.push(`Plus the users of ${ou}.`);
    if (extra) parts.push(`Plus ${n(extra, 'address', 'addresses')} from PILOT_USERS.`);
    if (failed) parts.push(`${n(failed, 'mailbox', 'mailboxes')} couldn't be watched (see the errors).`);
    if (stopped) parts.push(`Stopped watching ${n(stopped, 'mailbox', 'mailboxes')} no longer in the pilot.`);
    return parts.join(' ');
}

class Service {
    constructor({ cfg, store, gmail, intel = null, now = () => Date.now(), log = console, waitForOthersMs = WAIT_FOR_OTHERS_MS }) {
        this.cfg = cfg; this.store = store; this.gmail = gmail; this.intel = intel; this.now = now; this.log = log;
        this.waitForOthersMs = waitForOthersMs;
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
        if (!u.historyId) { await this.store.raiseHistoryId(user, String(historyId)); return { started: true }; }
        let added;
        try { added = await this.gmail.addedSince(user, u.historyId); }
        catch (e) {
            if (e instanceof GoogleApiError && e.status === 404) {
                // Too long since the last change we know of (Gmail keeps about a week): start again from now.
                // Checking goes on from now, and the Inbox mail since the last notification (at most a
                // week) is caught up on, a little with each later notification (backfillStep).
                const p = await this.gmail.profile(user);
                const after = Math.max(Number(u.lastNotification) || 0, this.now() - 7 * DAY);
                await this.store.putUser(user, { historyId: String(p.historyId), backfill: { after, pageToken: null, checked: 0 } });
                await this.store.addEvent({ kind: 'gap', user, text: `Changes to ${user}'s mailbox were missed (history too old). Checking resumed from now, and the Inbox mail since ${new Date(after).toISOString().slice(0, 16).replace('T', ' ')} UTC is being checked too.` });
                return { resynced: true };
            }
            throw e;
        }
        const results = [];
        // Anything left to do (a failed try, a message another instance is still on): the sync position
        // stays, so this part of the history is read again (held: the server asks Pub/Sub to deliver the
        // notification again later).
        let hold = false;
        // Emails the service moved that the user took back to the Inbox.
        const listedAsNew = new Set(added.ids);
        const inboxedAt = added.inboxedAt || {};
        for (const id of added.inboxed || []) {
            try {
                const r = await this.userReleased(user, id, { at: inboxedAt[id], listedAsNew: listedAsNew.has(id) });
                // Not one the service recorded: maybe one it never checked (the user took it out of Spam).
                if (r && r.noRecord && !listedAsNew.has(id)) await this.checkUnseenInbox(user, id);
            } catch (e) { this.log.error(`user release ${user} ${id}:`, e); }
        }
        const busy = [];
        for (const id of added.ids) {
            let r;
            try { r = await this.processMessage(user, id); }
            catch (e) {
                if (!e.gaveUp) hold = true;
                const why = String(e && e.message || e).slice(0, 300);
                await this.store.incStat(dayOf(this.now()), 'errors');
                await this.store.addEvent({ kind: 'error', user, text: e.gaveUp
                    ? `A message couldn't be checked after ${MAX_TRIES} tries and was left where it is: ${why}`
                    : `A message couldn't be checked (try ${e.tries || 1} of ${MAX_TRIES}; it is tried again in a minute or so): ${why}` });
                this.log.error(`process ${user} ${id}:`, e);
                continue;
            }
            if (r && r.busy) busy.push(id);
            else if (r) results.push(r);
        }
        if (busy.length && !(await this.othersDone(user, busy))) hold = true;
        if (!hold) await this.store.raiseHistoryId(user, String(added.historyId));
        if (u.backfill) { try { await this.backfillStep(user, u.backfill); } catch (e) { this.log.error(`backfill ${user}:`, e); } }
        if (this.log.info) this.log.info(`notification: ${added.ids.length} new in the Inbox, ${results.length} checked${hold ? ', some left to try again' : ''}`);
        return Object.assign({ processed: results.length, results }, hold ? { held: true } : {}, added.more ? { more: true } : {});
    }

    // Messages another instance had: done within WAIT_FOR_OTHERS_MS? (Two notifications for one email
    // usually come together, and each would otherwise keep the place for the other.)
    async othersDone(user, ids) {
        const until = Date.now() + this.waitForOthersMs;
        let left = ids;
        for (;;) {
            const done = await Promise.all(left.map(id => this.store.seen(user, id)));
            left = left.filter((id, i) => !done[i]);
            if (!left.length) return true;
            if (Date.now() >= until) return false;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // One message: claimed, judged, then marked done. A failed try lets it go to be tried again (up to
    // MAX_TRIES), and throws with e.tries and e.gaveUp. { busy: true }: another instance has it.
    async processMessage(user, id) {
        const claim = await this.store.claim(user, id, this.now(), CLAIM_LEASE_MS);
        if (claim.done) return null;
        if (claim.busy) return { busy: true };
        let out;
        try { out = await this.checkMessage(user, id, claim.tries); }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.tries = claim.tries;
            err.gaveUp = claim.tries >= MAX_TRIES;
            try {
                if (err.gaveUp) await this.store.markSeen(user, id, { failed: true });
                else await this.store.unclaim(user, id);
            } catch (e2) { /* the claim runs out by itself (CLAIM_LEASE_MS) */ }
            throw err;
        }
        await this.store.markSeen(user, id);
        return out;
    }

    // An email that came into the Inbox other than by arriving there (the user took it out of Spam, or
    // moved it from another folder) and that the service never checked: checked now and recorded, never
    // moved (the user put it there), with an alert when the checks flag it. Older mail moved back from an
    // archive (over 7 days) is left alone.
    async checkUnseenInbox(user, id) {
        const claim = await this.store.claim(user, id, this.now(), CLAIM_LEASE_MS);
        if (claim.done || claim.busy) return null;
        try {
            let msg;
            try { msg = await this.gmail.raw(user, id); }
            catch (e) { if (e instanceof GoogleApiError && e.status === 404) { await this.store.markSeen(user, id); return null; } throw e; }
            const recent = msg.internalDate && this.now() - msg.internalDate < 7 * DAY;
            let out = null;
            if (recent && msg.labelIds.includes('INBOX') && !msg.labelIds.some(l => l === 'SENT' || l === 'DRAFT' || l === 'SPAM')) {
                out = await this.judge(user, msg, await readMessage(msg.raw), { userPlaced: true });
            }
            await this.store.markSeen(user, id);
            return out;
        } catch (e) { await this.store.unclaim(user, id).catch(() => {}); throw e; }
    }

    // After a gap in a mailbox's history: its Inbox mail since b.after is checked, 25 at a time with each
    // notification, until done (messages already checked are skipped by their claim).
    async backfillStep(user, b) {
        const { ids, next } = await this.gmail.search(user, `in:inbox after:${Math.floor(b.after / 1000)}`, { max: 25, pageToken: b.pageToken || null });
        let checked = b.checked || 0;
        for (const id of ids) {
            try { const r = await this.processMessage(user, id); if (r && !r.busy) checked++; }
            catch (e) { this.log.error(`backfill ${user} ${id}:`, e); }
        }
        if (next) { await this.store.putUser(user, { backfill: Object.assign({}, b, { pageToken: next, checked }) }); return { more: true, checked }; }
        await this.store.putUser(user, { backfill: null });
        await this.store.addEvent({ kind: 'gap', user, text: `Caught up on ${user}'s Inbox after the gap: ${checked} emails checked.` });
        return { more: false, checked };
    }

    async checkMessage(user, id, tries) {
        let msg;
        try { msg = await this.gmail.raw(user, id); }
        catch (e) { if (e instanceof GoogleApiError && e.status === 404) return null; throw e; } // deleted before it was read
        // An earlier try that moved it and failed before its record was written: write the record now,
        // without moving it again (it has the service's own label, which only the service adds).
        if (tries > 1 && !(await this.store.getRecord(recordKey(user, id)))
            && msg.labelIds.includes(await this.gmail.labelId(user, this.cfg.movedLabel))) {
            return this.judge(user, msg, await readMessage(msg.raw), { alreadyMoved: true });
        }
        // Only mail that arrived in the Inbox: not the user's own sent mail or drafts, nor what Gmail already put in Spam.
        if (!msg.labelIds.includes('INBOX') || msg.labelIds.some(l => l === 'SENT' || l === 'DRAFT' || l === 'SPAM')) return null;
        const facts = await readMessage(msg.raw);
        return this.judge(user, msg, facts);
    }

    // Analysis, decision, action and record for one message (also used by the tests and the demo).
    // alreadyMoved: an earlier try moved it (and was counted); only the record is written.
    // userPlaced: the user moved it into the Inbox themselves (checkUnseenInbox): never moved.
    async judge(user, msg, facts, { alreadyMoved = false, userPlaced = false } = {}) {
        const now = this.now();
        const day = dayOf(now);
        if (!alreadyMoved) await this.store.incStat(day, 'scanned');
        const installedAt = (await this.store.getState('installedAt')) || (await this.store.setState('installedAt', now), now);
        const first = facts.senderAddress ? await this.store.senderFirstSeen(senderHash(facts.senderAddress), now) : now;
        const learning = now - installedAt < this.cfg.firstSeenLearningDays * DAY;
        // Allowlisted only with DMARC passing for the address (policy.js).
        const allowlisted = isAllowed(this.cfg, facts.senderAddress), verified = senderVerified(facts);
        const result = await analyze(facts, { mailbox: user, orgDomains: this.cfg.orgDomains, trusted: allowlisted && verified, firstTime: !learning && now - first < DAY, intel: this.intel });
        result.allowlistedUnverified = allowlisted && !verified;
        const brake = alreadyMoved ? false : await this.brakeOn(now);
        let decision = decide(result, this.cfg, { brake });
        if (alreadyMoved) decision = { action: 'move', trigger: decision.trigger, why: `${decision.why || 'moved'} (moved by an earlier try)` };
        if (userPlaced && (decision.action === 'move' || decision.action === 'would-move')) {
            decision = { action: 'flag', trigger: decision.trigger, why: `${decision.why}; the user moved it into the Inbox themselves (out of Spam or another folder), so it isn't moved` };
        }
        if (decision.action === 'none') return { user, messageId: msg.id, action: 'none', status: result.status, ai: result.ai && result.ai.probability };
        const senderDomain = (facts.senderAddress.split('@')[1] || '').toLowerCase();
        const campaign = campaignOf(senderDomain, facts.subject, user);
        const campaignLabel = this.cfg.storeSubjects ? campaign.label : senderDomain;
        // The brake was already on (decide): held for the admin's resume.
        let held = decision.braked ? 'brake' : null;
        if (decision.action === 'move' && !alreadyMoved) ({ decision, held } = await this.brakes(decision, result, campaign.key, campaignLabel, now));

        let state = 'inbox';
        if (decision.action === 'move') {
            if (!alreadyMoved) {
                const moved = await this.gmail.labelId(user, this.cfg.movedLabel);
                await this.gmail.modify(user, msg.id, ['SPAM', moved], ['INBOX']);
            }
            state = 'moved';
        } else if (decision.action === 'would-move' && this.cfg.monitorLabel) {
            await this.gmail.modify(user, msg.id, [await this.gmail.labelId(user, this.cfg.monitorLabel)], []);
        }
        const rec = {
            key: recordKey(user, msg.id), user, messageId: msg.id, threadId: msg.threadId || '',
            // The message's history id when it was read: an Inbox label added after it is the user's.
            readHistoryId: msg.historyId ? String(msg.historyId) : null,
            receivedAt: msg.internalDate || facts.date || now, processedAt: now,
            sender: { name: facts.senderName.slice(0, 200), address: facts.senderAddress.slice(0, 320), domain: senderDomain },
            subject: this.cfg.storeSubjects ? facts.subject.slice(0, 300) : '',
            campaign: campaign.key, campaignLabel,
            status: result.status, score: result.score, signals: result.signals.slice(0, 20), links: result.links.slice(0, 10), checks: result.checks || null,
            ai: result.ai ? { probability: result.ai.probability, model: result.ai.model,
                              reasons: this.cfg.storeAiQuotes ? (result.ai.reasons || []).map(r => ({ sentence: String(r.sentence).slice(0, 160), facts: !!r.facts })) : [] } : null,
            auth: facts.auth ? { dmarc: facts.auth.dmarc, spf: facts.auth.spf, dkim: facts.auth.dkim } : null,
            attachments: facts.attachments.slice(0, 10).map(a => ({ name: a.name.slice(0, 120), type: a.type })),
            action: decision.action, trigger: decision.trigger, why: decision.why, braked: held === 'brake', held, mode: this.cfg.mode,
            // How sure: strong = the rules flagged it and something outside the email confirms it.
            evidence: result.strong ? 'strong' : 'weak', confirmedBy: result.confirmedBy || [],
            ownAddressUnverified: !!(result.ownAddress && !result.inside), userPlaced: userPlaced || undefined,
            state, releasedBy: null, releasedAt: null, falseAlarm: null, markedBy: null
        };
        await this.store.saveRecord(rec);
        await this.store.incStat(day, decision.action === 'move' ? 'moved' : decision.action === 'would-move' ? 'wouldMove' : 'flagged');
        if (decision.action === 'move') {
            const moves = await this.store.campaignMoved(campaign.key, now);
            if (moves === this.cfg.campaignAlertAfter) await this.alert('campaign', `A large campaign: ${moves} copies of "${campaignLabel}" moved to Spam so far (${rec.evidence} evidence). The dashboard's Campaigns page lists who received it.`, { campaign: campaign.key });
        }
        if (userPlaced && result.status === 'flagged') {
            await this.alert('user-inbox', `${user} moved an email from ${rec.sender.address} into their Inbox (it didn't arrive there), and the checks flag it (score ${rec.score}). Make sure it's safe, or confirm it as phishing and warn them.`, { user, key: rec.key });
        }
        return rec;
    }

    // The brakes, for a move about to be made (enforce mode). In order:
    //   - an admin's decision on the campaign: released (a false alarm) is never moved; confirmed is;
    //   - the campaign hold: on weak evidence (nothing outside the email confirms it), copies of one
    //     campaign beyond CAMPAIGN_HOLD_AFTER are held until an admin confirms or releases it. Strong
    //     evidence is never held, so a clear phishing campaign reaches every mailbox;
    //   - the domain-wide brake, a last resort against a misfire: more than brakeLimit() moves in the
    //     clock hour (counted exactly, a slot reserved before each move) stops moving everywhere.
    // Held copies are recorded as "would move" and can be moved later (moveHeld).
    async brakes(decision, result, campaignKey, campaignLabel, now) {
        const cs = await this.store.getCampaign(campaignKey);
        const released = (d) => ({ decision: { action: 'flag', trigger: d.trigger, why: `${d.why}; an admin released this campaign (a false alarm), so its copies aren't moved` }, held: null });
        if (cs && cs.decision === 'released') return released(decision);
        if (!result.strong && !(cs && cs.decision === 'confirmed')) {
            const h = await this.store.campaignHold(campaignKey, this.cfg.campaignHoldAfter, now, campaignLabel);
            if (h.decision === 'released') return released(decision);
            if (h.held) {
                if (h.first) await this.alert('campaign-held', `Copies of "${campaignLabel}" are held: more than ${this.cfg.campaignHoldAfter} were moved on evidence nothing outside the email confirms. Confirm it as phishing (every copy is moved) or release it, on the dashboard's Messages page for the campaign.`, { campaign: campaignKey });
                return { decision: { action: 'would-move', trigger: decision.trigger, why: `${decision.why} (held: over ${this.cfg.campaignHoldAfter} copies of this campaign on evidence nothing outside the email confirms; an admin confirms or releases it)` }, held: 'campaign' };
            }
        }
        const resumedAt = Number(await this.store.getState('brakeResumedAt')) || 0;
        const limit = await this.brakeLimit();
        const slot = await this.store.reserveMove(`${hourOf(now)}|${resumedAt}`, limit, now);
        if (!slot.ok) {
            await this.tripBrake(now, slot.count, limit);
            return { decision: { action: 'would-move', trigger: decision.trigger, why: `${decision.why} (brake on: not moved)`, braked: true }, held: 'brake' };
        }
        return { decision, held: null };
    }
    // The domain-wide limit: BRAKE_PER_HOUR, or half the watched mailboxes (at least 100).
    async brakeLimit() {
        if (this.cfg.brakePerHour > 0) return this.cfg.brakePerHour;
        return Math.max(100, Math.ceil((Number(await this.store.getState('watchedCount')) || 0) / 2));
    }
    async tripBrake(now, count, limit) {
        if (!(await this.store.setStateIfUnset('brake', { at: now, moves: count, limit }))) return;
        await this.alert('brake', `${count} emails were moved within the hour (limit ${limit}). Moving has stopped in every mailbox: suspicious mail is held until an admin resumes on the dashboard, which can also move the held mail.`);
    }

    // An alert: in Recent activity, and a log line Cloud Monitoring emails to ALERT_EMAIL (install.sh).
    async alert(kind, text, extra = {}) {
        await this.store.addEvent(Object.assign({ kind, text, alert: true }, extra));
        if (this.log.warn) this.log.warn(JSON.stringify({ severity: 'WARNING', spruceAlert: kind, message: text }));
    }

    async brakeOn() { return !!(await this.store.getState('brake')); }
    // The admin resumes: the hour's count starts again (a new counter), and with moveHeld the copies the
    // brake held since it came on are moved now (those still in the Inbox).
    async resume(by, { moveHeld = false } = {}) {
        const brake = await this.store.getState('brake');
        await this.store.setState('brakeResumedAt', this.now());
        await this.store.setState('brake', null);
        const out = moveHeld && brake ? await this.moveHeld(r => r.held === 'brake' && r.processedAt >= brake.at, by, 'resumed moving') : null;
        await this.store.addEvent({ kind: 'resume', text: `Moving resumed by ${by}${out ? (out.monitor ? '' : `; ${out.moved} held emails moved to Spam${out.gone ? `, ${out.gone} no longer in the Inbox` : ''}`) : ''}.` });
        return { ok: true, held: out };
    }

    // Moves held or recorded copies now, those still in the Inbox (an admin's resume or confirmation;
    // not counted by the brake). Enforce mode only. { moved, gone, failed, left }.
    async moveHeld(match, by, how, { budgetMs = 200000, max = 5000 } = {}) {
        if (this.cfg.mode !== 'enforce') return { moved: 0, gone: 0, failed: 0, left: 0, monitor: true };
        const recs = (await this.store.listRecords({ sinceMs: this.now() - 14 * DAY, limit: 20000 }))
            .filter(r => r.state === 'inbox' && r.action !== 'move' && match(r)).slice(0, max);
        const start = Date.now();
        const out = { moved: 0, gone: 0, failed: 0, left: 0 };
        await pool(recs, 10, async (r) => {
            try {
                let labels = null;
                try { labels = await this.gmail.labels(r.user, r.messageId); } catch (e) { if (!(e instanceof GoogleApiError && e.status === 404)) throw e; }
                if (!labels || !labels.includes('INBOX')) { out.gone++; return; }
                await this.gmail.modify(r.user, r.messageId, ['SPAM', await this.gmail.labelId(r.user, this.cfg.movedLabel)], ['INBOX']);
                const now = this.now();
                await this.store.updateRecord(r.key, { action: 'move', state: 'moved', held: null, braked: false, why: `${r.why}; moved when ${by} ${how}`, heldMovedBy: by, heldMovedAt: now });
                await this.store.incStat(dayOf(now), 'moved');
                out.moved++;
            } catch (e) { out.failed++; this.log.error(`move held ${r.key}:`, e); }
        }, () => Date.now() - start > budgetMs);
        out.left = recs.length - out.moved - out.gone - out.failed;
        return out;
    }

    // --- Campaigns: an admin's decision for every copy -----------------------------------------
    async campaignRecords(key) { return (await this.store.listRecords({ sinceMs: this.now() - 90 * DAY, limit: 20000 })).filter(r => r.campaign === key); }
    // Confirmed as phishing: every recorded copy still in the Inbox is moved (enforce mode), every copy
    // is marked phishing, later copies are moved without being held, and with search the watched
    // mailboxes are searched for copies the service didn't record (findCopies).
    async confirmCampaign(key, by, { search = false } = {}) {
        const recs = await this.campaignRecords(key);
        if (!recs.length) return { error: 'not found', status: 404 };
        // Within the dashboard's request time (5 minutes): moving first, then searching with what is left.
        const start = Date.now();
        await this.store.setCampaign(key, { decision: 'confirmed', decidedBy: by, decidedAt: this.now(), label: recs[0].campaignLabel });
        const moved = await this.moveHeld(r => r.campaign === key, by, 'confirmed the campaign as phishing', { budgetMs: 150000 });
        for (const r of recs) if (r.falseAlarm !== false) await this.store.updateRecord(r.key, { falseAlarm: false, markedBy: by });
        const found = search ? await this.findCopies(key, by, { budgetMs: Math.max(30000, 240000 - (Date.now() - start)) }) : null;
        await this.store.addEvent({ kind: 'campaign', campaign: key, text: `${by} confirmed "${recs[0].campaignLabel}" as phishing${moved.monitor ? ' (monitor mode: nothing moved)' : `: ${moved.moved} copies moved to Spam`}${found ? `; a search of ${found.searched} mailboxes found ${found.found} more${found.moved ? `, ${found.moved} moved` : ''}` : ''}.` });
        return { moved, found };
    }
    // A false alarm: every moved copy is released, every copy marked a false alarm, and later copies
    // aren't moved.
    async releaseCampaign(key, by) {
        const recs = await this.campaignRecords(key);
        if (!recs.length) return { error: 'not found', status: 404 };
        await this.store.setCampaign(key, { decision: 'released', decidedBy: by, decidedAt: this.now(), label: recs[0].campaignLabel });
        let released = 0, failed = 0;
        await pool(recs, 10, async (r) => {
            try {
                if (r.state === 'moved') { const out = await this.release(r.key, by, { quiet: true }); if (out.record) released++; }
                else if (r.falseAlarm !== true) await this.store.updateRecord(r.key, { falseAlarm: true, markedBy: by });
            } catch (e) { failed++; this.log.error(`release ${r.key}:`, e); }
        });
        await this.store.addEvent({ kind: 'campaign', campaign: key, text: `${by} released "${recs[0].campaignLabel}" as a false alarm: ${released} copies back in the Inbox${failed ? `, ${failed} couldn't be released` : ''}. Later copies aren't moved.` });
        return { released, failed };
    }
    // Copies of a campaign the service didn't record (judged clean when they came, or before the pilot):
    // each watched mailbox's Inbox of the last 7 days is searched for mail from the campaign's senders,
    // and a message counts when its sender's domain and subject make the same campaign. Confirmed
    // campaigns' copies are moved (enforce mode); others are recorded as "would move".
    async findCopies(key, by, { budgetMs = 200000 } = {}) {
        const recs = await this.campaignRecords(key);
        const senders = [...new Set(recs.map(r => r.sender && r.sender.address).filter(Boolean))].slice(0, 5);
        const users = (await this.store.listUsers()).filter(u => u.watched).map(u => u.email);
        const out = { searched: 0, of: users.length, found: 0, moved: 0, failed: 0 };
        if (!senders.length) return out;
        const cs = await this.store.getCampaign(key);
        const moving = !!(cs && cs.decision === 'confirmed') && this.cfg.mode === 'enforce';
        const known = new Set(recs.map(r => r.key));
        const q = `in:inbox newer_than:7d from:(${senders.join(' OR ')})`;
        const start = Date.now();
        await pool(users, 20, async (user) => {
            try {
                const { ids } = await this.gmail.search(user, q, { max: 50 });
                out.searched++;
                for (const id of ids) {
                    if (known.has(recordKey(user, id))) continue;
                    const m = await this.gmail.headers(user, id);
                    const address = addressOf(m.from), domain = address.split('@')[1] || '';
                    if (campaignOf(domain, m.subject, user).key !== key || !m.labelIds.includes('INBOX')) continue;
                    out.found++;
                    if (moving) await this.gmail.modify(user, id, ['SPAM', await this.gmail.labelId(user, this.cfg.movedLabel)], ['INBOX']);
                    const now = this.now();
                    await this.store.saveRecord({
                        key: recordKey(user, id), user, messageId: id, threadId: m.threadId || '', readHistoryId: null,
                        receivedAt: m.internalDate || now, processedAt: now,
                        sender: { name: '', address: address.slice(0, 320), domain }, subject: this.cfg.storeSubjects ? String(m.subject).slice(0, 300) : '',
                        campaign: key, campaignLabel: recs[0].campaignLabel, status: 'flagged', score: null,
                        signals: [{ weight: 0, kind: 'campaign-copy', text: `A copy of a campaign ${by} confirmed as phishing.` }], links: [], checks: null, ai: null, auth: null, attachments: [],
                        action: moving ? 'move' : 'would-move', trigger: 'admin', why: `found by ${by}'s search for copies of the campaign${moving ? '' : this.cfg.mode === 'enforce' ? ' (not moved: the campaign isn\'t confirmed)' : ' (monitor mode: not moved)'}`,
                        braked: false, held: null, mode: this.cfg.mode, evidence: 'admin', confirmedBy: [],
                        state: moving ? 'moved' : 'inbox', releasedBy: null, releasedAt: null, falseAlarm: false, markedBy: by
                    });
                    await this.store.incStat(dayOf(now), moving ? 'moved' : 'wouldMove');
                    if (moving) out.moved++;
                }
            } catch (e) { out.failed++; this.log.error(`find copies ${user}:`, e); }
        }, () => Date.now() - start > budgetMs);
        return out;
    }

    // Puts a moved email back in the Inbox (and records who did it).
    async release(key, by, { quiet = false } = {}) {
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
        if (!quiet) await this.store.addEvent({ kind: 'release', user: rec.user, text: `${by} released an email from ${rec.sender.address} to ${rec.user}.` });
        return { record: out };
    }
    // The user moved an email the service had put in Spam back to the Inbox (or marked it "Not spam"). The
    // service never moves it again; the record says so, counts as a false alarm (an admin can still mark
    // it phishing, which matters: a user who rescued real phishing may be about to click it).
    // at: the history id of the Inbox label; listedAsNew: the same history lists the message as new.
    async userReleased(user, messageId, { at, listedAsNew = false } = {}) {
        const key = recordKey(user, messageId);
        const rec = await this.store.getRecord(key);
        if (!rec) return { noRecord: true };
        if (rec.state !== 'moved') return null;
        // Only an Inbox label added after the service read the message can be the user's: the label it
        // arrived with can show in the same history. Where the order isn't known, a message the history
        // lists as new is taken to have arrived with it.
        const order = compareHistoryIds(at, rec.readHistoryId);
        if (order !== null ? order <= 0 : listedAsNew) return null;
        const now = this.now();
        if (rec.releasingAt && now - rec.releasingAt < 10 * 60 * 1000) return null; // an admin's release under way
        const out = await this.store.updateRecord(key, { state: 'released', releasedBy: user, releasedByUser: true, releasedAt: now,
            falseAlarm: rec.falseAlarm === null || rec.falseAlarm === undefined ? true : rec.falseAlarm, markedBy: rec.markedBy || null });
        await this.store.incStat(dayOf(now), 'released');
        await this.store.incStat(dayOf(now), 'userReleased');
        const strong = rec.score >= 5 && rec.trigger !== 'ai';
        const text = strong ? `${user} moved an email from ${rec.sender.address} back to the Inbox, though the checks flagged it (score ${rec.score}). Make sure it's safe, or mark it phishing and warn them.`
                            : `${user} moved an email from ${rec.sender.address} back to the Inbox (counted as a false alarm).`;
        if (strong) await this.alert('user-release', text, { user, key });
        else await this.store.addEvent({ kind: 'user-release', user, key, text });
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
        const groups = [];
        // A failed directory read stops here, before any watch is stopped by mistake, and says so.
        try {
            for (const g of this.cfg.pilotGroups) {
                const found = {};
                const members = await this.gmail.groupMembers(this.cfg.directoryAdmin, g, this.cfg.orgDomains, found);
                for (const u of members) users.add(u);
                groups.push(Object.assign({ group: g, people: members.length, entries: members.length, inactive: 0, outside: 0, outsideDomains: [], everyone: 0, groups: 0 }, found));
            }
            if (this.cfg.pilotOu) for (const u of await this.gmail.usersInOu(this.cfg.directoryAdmin, this.cfg.pilotOu)) users.add(u);
        } catch (e) {
            await this.alert('error', `Couldn't read who is in the pilot (${[...this.cfg.pilotGroups, this.cfg.pilotOu].filter(Boolean).join(', ')}) as ${this.cfg.directoryAdmin}: ${String(e.message).slice(0, 200)}. Check the admin's role and the domain-wide delegation scopes.`);
            throw e;
        }
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
        let stopped = 0;
        for (const u of await this.store.listUsers()) {
            if (u.watched && !users.has(u.email)) {
                try { await this.gmail.stop(u.email); } catch (e) { /* already stopped */ }
                await this.store.putUser(u.email, { watched: false });
                stopped++;
            }
        }
        await this.store.setState('watchedCount', ok);
        // What was found, for Recent activity (and the log, without addresses): so a count that looks
        // wrong says why.
        const text = watchSummary({ ok, failed, stopped, groups, extra: this.cfg.pilotUsers.length, ou: this.cfg.pilotOu, orgDomains: this.cfg.orgDomains });
        await this.store.addEvent({ kind: 'watch', text });
        if (this.log.info) this.log.info(`renew-watches: ${text}`);
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

    // Cloud Scheduler, hourly (the spruce-sync-feeds job): the health check, then the phishing lists,
    // downloaded once a day for everyone (src/intel/feeds.js; a failed download is tried again the next
    // day, not every hour).
    async syncFeeds() {
        let health;
        try { health = await this.health(); } catch (e) { health = { error: String(e.message || e).slice(0, 200) }; }
        if (!this.intel || !this.intel.feeds) return { health, skipped: 'phishing lists are off' };
        const last = Number(await this.store.getState('feedsAttemptedAt')) || 0;
        if (this.now() - last < 20 * HOUR) return { health, skipped: 'checked within the day' };
        await this.store.setState('feedsAttemptedAt', this.now());
        return Object.assign({ health }, await this.intel.feeds.sync());
    }

    // Whether the service is getting Gmail's notifications at all, and its watches are renewed. Each
    // problem is alerted once a day: no notification for QUIET_HOURS for any watched mailbox (they may be
    // refused before reaching the service), or watches ending within a day (the daily re-read failing).
    async health() {
        const now = this.now();
        const users = (await this.store.listUsers()).filter(u => u.watched);
        const out = { watched: users.length };
        if (!users.length) return out;
        const once = async (name, kind, text) => {
            if (now - (Number(await this.store.getState(name)) || 0) < DAY) return;
            await this.store.setState(name, now);
            await this.alert(kind, text);
        };
        const last = Math.max(0, ...users.map(u => Number(u.lastNotification) || 0));
        const since = last || Number(await this.store.getState('installedAt')) || now;
        out.lastNotification = last || null;
        if (now - since > this.cfg.quietHours * HOUR) {
            out.quiet = true;
            await once('quietAlertAt', 'quiet', `No notification from Gmail for ${Math.round((now - since) / HOUR)} hours, for any of the ${users.length} watched mailboxes. Gmail's notifications may be refused before they reach the service: docs/INSTALL.md, Troubleshooting, "The jobs and notifications are refused".`);
        }
        out.expiring = users.filter(u => u.watchExpiration && u.watchExpiration < now + DAY).length;
        if (out.expiring) await once('expiringAlertAt', 'watch-expiring', `${out.expiring} mailbox watches end within a day and weren't renewed: the daily re-read of the group (spruce-renew-watches) may be failing. Settings → Mailboxes watched says when it last reached the service.`);
        return out;
    }
}

module.exports = { Service, campaignOf, senderHash, recordKey, dayOf };
