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
const { analyze, aiReading, senderVerified, platformNotification, shareSource } = require('./engine/analyze');
const { MASS_SHARE } = require('./engine/notifications');
const { decide, isAllowed } = require('./policy');
const { GoogleApiError } = require('./gmail/client');
const { compareHistoryIds, movesForward } = require('./store/history');
const { buildDigest, mime, isSummary, localParts } = require('./digest');
const A = require('./dashboard/aggregate');
const training = require('./training');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const LIST_RETRY_MS = 3 * HOUR;
const ERRORS_ALERT = 25;   // errors in an hour that make an alert (0.5.29)   // a phishing list that missed its download is tried again this often (0.5.22)
const MAX_TRIES = 3;
// How long a claim keeps other instances off a message: longer than a request may run (the worker's
// timeout is 120 s), so only a claim left by an instance that stopped is taken over.
const CLAIM_LEASE_MS = 5 * 60 * 1000;
// How long a notification waits for messages another instance is judging before it keeps the place.
const WAIT_FOR_OTHERS_MS = 5000;
// The daily renewal of the watches (Gmail stops notifying for a mailbox whose watch isn't renewed for 7
// days): 10 at a time (users.watch costs 100 quota units: about 400,000 a minute, a third of the
// project's 1,200,000), within RENEW_BUDGET_MS so the run ends before the worker's 120-second timeout,
// the mailboxes renewed longest ago first. Those left are the first of the next run: 10,000 mailboxes are
// each renewed every two days or so, well within the 7 days. One renewed less than RENEW_FRESH_MS ago is
// left for the next run.
// How often a mailbox's "last notification" time is written when its history position doesn't move (it
// is written with the position otherwise): the Status page and the quiet-mailbox alert (12 hours) need no more.
const NOTED_EVERY_MS = 10 * 60 * 1000;
// How long a mailbox's sync position may wait when its notifications bring nothing new (see above).
const QUIET_POSITION_MS = 30 * 60 * 1000;
// Senders remembered per instance (about 100 bytes each).
const SENDERS_KEPT = 100000;
// How often the worker writes the day's counters it added up (src/server.js; see Service.count).
const STAT_FLUSH_MS = 5000;
const RENEW_PARALLEL = 10, RENEW_BUDGET_MS = 95 * 1000, RENEW_FRESH_MS = 12 * 60 * 60 * 1000, WATCH_MS = 7 * 24 * 60 * 60 * 1000;
// A day in the organization's time zone (0.5.27; UTC before): the daily counters' key. Kept for callers
// outside the service, in UTC; the service itself uses this.dayOf.
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);
// The Message-ID header without its angle brackets: what Google Workspace's Email log search and the
// security investigation tool look an email up by.
const messageIdOf = (v) => String(v || '').trim().replace(/^<|>$/g, '').slice(0, 300);
// The address in a From header ("Name <a@b>" or "a@b").
const addressOf = (from) => { const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(String(from || '')); return (m ? m[1] : String(from || '').trim()).toLowerCase(); };
// At most n at once; the others wait their turn, first come first served.
// The AI's answer as a record keeps it: the score, the model, the sentences that weighed most (unless
// STORE_AI_QUOTES=off), and why there is no score (an email in a language the model doesn't read).
function aiRecord(ai, cfg) {
    if (!ai) return null;
    const out = { probability: ai.probability, model: ai.model,
        reasons: cfg.storeAiQuotes ? (ai.reasons || []).map(r => ({ sentence: String(r.sentence).slice(0, 160), facts: !!r.facts })) : [] };
    if (ai.skipped) { out.skipped = ai.skipped; out.language = ai.language || null; }
    return out;
}

class Slots {
    constructor(n) { this.free = n; this.waiting = []; }
    async run(fn) {
        if (this.free > 0) this.free--; else await new Promise(r => this.waiting.push(r));
        try { return await fn(); } finally { const next = this.waiting.shift(); if (next) next(); else this.free++; }
    }
}
// Emails downloaded and checked at once per instance (the worker takes 32 requests at once, most of them
// notifications with nothing new), and of those, how many over LARGE_BYTES (attachments): 12 downloads
// of the largest Gmail sends plus 2 being read fit in the worker's 1 GiB.
const EMAIL_SLOTS = 12, LARGE_SLOTS = 2, LARGE_BYTES = 4 * 1024 * 1024;
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
function watchSummary({ ok, failed, stopped, groups, extra, ou, orgDomains, renewed = null, left = 0 }) {
    const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    const parts = [`Watching ${n(ok, 'mailbox', 'mailboxes')}.`];
    if (renewed !== null && left) parts.push(`Renewed now: ${renewed}${left ? `; ${left} more at the next run (a watch lasts 7 days; the oldest are renewed first)` : ''}.`);
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

// --- The policy settings an admin can change on the dashboard (Settings, with the project ID) ----------
// mode, aiThreshold, aiSuspicious, brakePerHour (0: automatic), timeZone, the allowlists and retentionDays
// (how long records are kept) come from deploy/settings.env (the services'
// environment). A change on the dashboard is kept in Firestore (state/policy-<key>: { value, env, before,
// by, at }) and applies to every instance within POLICY_REFRESH_MS. It records the settings.env value it
// replaced (env): when settings.env later has another value for the same setting (changed, then
// install.sh), that one is newer and applies. The most recent change wins, wherever it was made.
const POLICY_KEYS = ['mode', 'aiThreshold', 'aiSuspicious', 'aiScansInside', 'aiMovesInside', 'safeBrowsing', 'brakePerHour', 'timeZone', 'allowDomains', 'allowAddresses', 'retentionDays'];
const LIST_KEYS = ['allowDomains', 'allowAddresses'];
const MAX_ALLOWED = 500;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// A list as kept: lower case, no repeats, sorted (from a list, or text with one per line or commas).
// (one per line, or separated by commas or semicolons: an entry with a space in it is reported whole)
const asList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\r\n,;]+/)).map(x => String(x).trim().toLowerCase()).filter(Boolean))].sort();
const POLICY_REFRESH_MS = 30 * 1000;
const MIN_KEEP_DAYS = 14, MAX_KEEP_DAYS = 365;   // retentionDays (config.js says the same)
const OWN_ENV = Symbol('envPolicy of this configuration');
const sameSetting = (a, b) => (Array.isArray(a) || Array.isArray(b) ? asList(a).join(',') === asList(b).join(',')
    : typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a) === String(b));
function validTimeZone(z) { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (e) { return false; } }
// The value as stored, or an error (status 400) saying what is allowed. now: the settings in force, for
// the checks between them: orgDomains (the organization's own domains, which can't be allowlisted, or a
// staff account taken over would never be moved), and the two AI lines (the suspicious line is never
// above the move threshold).
function policyValue(key, v, now = {}) {
    const orgDomains = Array.isArray(now) ? now : now.orgDomains || [];
    const bad = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
    if (LIST_KEYS.includes(key)) {
        const items = asList(v);
        if (items.length > MAX_ALLOWED) bad(`At most ${MAX_ALLOWED} entries.`);
        for (const x of items) {
            const domain = key === 'allowDomains' ? x : x.split('@')[1] || '';
            if (key === 'allowAddresses' && !/^[^\s@]+@[^\s@]+$/.test(x)) bad(`"${x.slice(0, 80)}" isn't an email address.`);
            if (!DOMAIN_RE.test(domain)) bad(`"${x.slice(0, 80)}" isn't a domain${key === 'allowAddresses' ? ' at the end of an address' : ''}.`);
            if (key === 'allowDomains' && orgDomains.some(d => x === d || x.endsWith(`.${d}`) || d.endsWith(`.${x}`))) bad(`${x} is your organization's own domain: it can't be allowlisted, or a staff account taken over would never be moved. Allowlist single addresses instead.`);
        }
        return items;
    }
    if (key === 'mode') return v === 'monitor' || v === 'enforce' ? v : bad('The mode is monitor or enforce.');
    const pc = (x) => `${Math.round(Number(x) * 1000) / 10}%`;
    if (key === 'aiThreshold') {
        const n = Number(v), floor = typeof now.aiSuspicious === 'number' ? now.aiSuspicious : 0.5;
        return Number.isFinite(n) && n > 0.5 && n >= floor && n <= 1 ? Math.round(n * 1000) / 1000
            : bad(`The AI move threshold is from the suspicious line (${pc(floor)}) to 100%. To go lower, lower the suspicious line first.`);
    }
    if (key === 'aiSuspicious') {
        const n = Number(v), ceiling = typeof now.aiThreshold === 'number' ? now.aiThreshold : 1;
        return Number.isFinite(n) && n >= 0.5 && n <= ceiling ? Math.round(n * 1000) / 1000
            : bad(`The AI suspicious line is from 50% to the move threshold (${pc(ceiling)}). To go higher, raise the move threshold first.`);
    }
    if (key === 'aiScansInside' || key === 'aiMovesInside' || key === 'safeBrowsing') {
        if (v === true || v === false) return v;
        const t = String(v).trim().toLowerCase();
        return ['on', 'true', 'yes', '1'].includes(t) ? true : ['off', 'false', 'no', '0'].includes(t) ? false
            : bad({ aiScansInside: 'Whether the AI reads mail from inside is on or off.', aiMovesInside: 'Whether the AI alone moves mail from inside is on or off.', safeBrowsing: 'Google Safe Browsing is on or off.' }[key]);
    }
    if (key === 'brakePerHour') { const n = Number(v); return n === 0 || (Number.isInteger(n) && n >= 10 && n <= 100000) ? n : bad('The brake is automatic, or a whole number of moves an hour from 10 to 100,000.'); }
    if (key === 'timeZone') { const z = String(v || '').trim(); return z && validTimeZone(z) ? z : bad('The time zone is an IANA name, for example America/New_York.'); }
    if (key === 'retentionDays') { const n = Number(v); return Number.isInteger(n) && n >= MIN_KEEP_DAYS && n <= MAX_KEEP_DAYS ? n : bad(`Records are kept a whole number of days, from ${MIN_KEEP_DAYS} to ${MAX_KEEP_DAYS}.`); }
    return bad('That setting can\'t be changed on the dashboard.');
}
function policyWords(key, v) {
    if (LIST_KEYS.includes(key)) { const l = asList(v); return l.length ? (l.length > 5 ? `${l.length} entries` : l.join(', ')) : 'none'; }
    if (key === 'mode') return v === 'enforce' ? 'enforce' : 'monitor';
    if (key === 'aiThreshold' || key === 'aiSuspicious') return `${Math.round(Number(v) * 1000) / 10}%`;
    if (key === 'brakePerHour') return Number(v) ? `${Number(v).toLocaleString('en-US')} moves an hour` : 'automatic (half the watched mailboxes, at least 100)';
    if (key === 'retentionDays') return `${Number(v)} days`;
    if (key === 'aiScansInside' || key === 'aiMovesInside' || key === 'safeBrowsing') return v ? 'on' : 'off';
    return String(v);
}

class Service {
    // statFlushMs: the day's counters of checked emails are added up here and written at most this often
    // (one write for all of them; 0, as in the tests: each at once). The worker uses STAT_FLUSH_MS.
    constructor({ cfg, store, gmail, intel = null, now = () => Date.now(), log = console, waitForOthersMs = WAIT_FOR_OTHERS_MS, statFlushMs = 0 }) {
        this.cfg = cfg; this.store = store; this.gmail = gmail; this.intel = intel; this.now = now; this.log = log;
        this.waitForOthersMs = waitForOthersMs;
        this.statFlushMs = statFlushMs; this.statBuf = new Map(); this.statFlushedAt = Date.now();
        // What deploy/settings.env says (the environment), before any change made on the dashboard
        // (loadConfig keeps it; a configuration made by hand, as in the tests, gets it here).
        // A plain copy (Object.assign({}, cfg, { mode })) takes its own values, not the original's.
        if (!Object.isFrozen(cfg) && !cfg[OWN_ENV]) {
            cfg.envPolicy = Object.fromEntries(POLICY_KEYS.map(k => [k, cfg[k]]));
            Object.defineProperty(cfg, OWN_ENV, { value: true });
        }
        this.policyState = {}; this.policyReadAt = 0;
        // Kept per instance, as they never change once known: when each sender was first seen (a hash, as
        // in Firestore), and the campaigns whose alert has been sent.
        this.installedAt = null; this.senderSeen = new Map(); this.alerted = new Set();
        this.emailSlots = new Slots(EMAIL_SLOTS); this.largeSlots = new Slots(LARGE_SLOTS);
    }
    // The day an instant falls on in the organization's time zone (TIME_ZONE, Settings → Policy).
    dayOf(ms) { return A.dayIn(ms, this.cfg.timeZone); }
    // A large email (over LARGE_BYTES) is read and judged LARGE_SLOTS at a time.
    readAndJudge(user, msg, opts) {
        const go = async () => this.judge(user, msg, await readMessage(msg.raw), opts);
        return msg.raw && msg.raw.length > LARGE_BYTES ? this.largeSlots.run(go) : go();
    }
    // A day's counter of checked emails (scanned, moved, …): written at once, or added up and written with
    // the others every statFlushMs (a busy instance writes once every few seconds, not once per email, and
    // a campaign makes no counter document hot). Counts are written on the next email after that, and when
    // the instance stops (flushStats, from server.js).
    async count(day, field) {
        if (!this.statFlushMs) return this.store.incStat(day, field);
        const k = `${day}|${field}`;
        this.statBuf.set(k, (this.statBuf.get(k) || 0) + 1);
        if (Date.now() - this.statFlushedAt >= this.statFlushMs) await this.flushStats();
    }
    async flushStats() {
        if (!this.statBuf.size) return;
        const buf = this.statBuf;
        this.statBuf = new Map(); this.statFlushedAt = Date.now();
        const byDay = new Map();
        for (const [k, n] of buf) { const [day, field] = k.split('|'); byDay.set(day, Object.assign(byDay.get(day) || {}, { [field]: n })); }
        for (const [day, counts] of byDay) {
            try { await this.store.incStats(day, counts); }
            catch (e) {   // kept for the next try
                for (const [f, n] of Object.entries(counts)) this.statBuf.set(`${day}|${f}`, (this.statBuf.get(`${day}|${f}`) || 0) + n);
                this.log.error('writing the day\'s counters:', e);
            }
        }
    }
    // When a sender was first seen: Firestore's answer (a transaction on senders/{hash}) the first time on
    // this instance, then this instance's copy.
    async firstSeen(hash, now) {
        if (this.senderSeen.has(hash)) return this.senderSeen.get(hash);
        const first = await this.store.senderFirstSeen(hash, now);
        if (this.senderSeen.size >= SENDERS_KEPT) this.senderSeen.delete(this.senderSeen.keys().next().value);
        this.senderSeen.set(hash, first);
        return first;
    }

    // Reads the dashboard's changes (at most every POLICY_REFRESH_MS, or now with force) and applies the
    // ones still in force to this.cfg, which every check reads when it runs.
    async refreshPolicy({ force = false } = {}) {
        if (!force && Date.now() - this.policyReadAt < POLICY_REFRESH_MS) return this.policyState;
        this.policyReadAt = Date.now();
        let rows;
        try { rows = await Promise.all(POLICY_KEYS.map(k => this.store.getState(`policy-${k}`))); }
        catch (e) { this.log.error('reading the policy changed on the dashboard:', e); return this.policyState; }
        this.policyState = Object.fromEntries(POLICY_KEYS.map((k, i) => [k, rows[i] || null]));
        this.applyPolicy();
        return this.policyState;
    }
    // The values in force: the dashboard's where still in force, settings.env's otherwise.
    applyPolicy() {
        const env = this.cfg.envPolicy;
        const values = Object.fromEntries(POLICY_KEYS.map(k => { const o = this.policyState[k]; return [k, o && sameSetting(o.env, env[k]) ? o.value : env[k]]; }));
        if (typeof this.cfg.setPolicyValues === 'function') this.cfg.setPolicyValues(values);   // (loadConfig's)
        else Object.assign(this.cfg, values);
    }
    // For Settings: each setting's value in force, and where it comes from.
    policyInfo() {
        return Object.fromEntries(POLICY_KEYS.map(k => {
            const o = this.policyState[k], kept = !!(o && sameSetting(o.env, this.cfg.envPolicy[k]));
            return [k, { value: this.cfg[k], env: this.cfg.envPolicy[k], changed: kept ? { by: o.by, at: o.at, before: o.before } : null,
                replaced: o && !kept ? { by: o.by, at: o.at, value: o.value } : null }];
        }));
    }
    // A change made on the dashboard (the server checks the project ID, and the agreement for enforce mode).
    // In force at once here, everywhere within POLICY_REFRESH_MS; noted in Activity → What admins did (not
    // emailed, 0.5.28: an alert is a problem).
    async setPolicy(key, raw, by) {
        if (!POLICY_KEYS.includes(key)) throw Object.assign(new Error('That setting can\'t be changed on the dashboard.'), { status: 400 });
        const value = policyValue(key, raw, { orgDomains: this.cfg.orgDomains, aiThreshold: this.cfg.aiThreshold, aiSuspicious: this.cfg.aiSuspicious });
        await this.refreshPolicy({ force: true });
        const before = this.cfg[key];
        if (sameSetting(before, value)) return { key, value, unchanged: true };
        const rec = { value, env: this.cfg.envPolicy[key], before, by, at: this.now() };
        await this.store.setState(`policy-${key}`, rec);
        this.policyState[key] = rec; this.applyPolicy();
        const how = key === 'mode' && value === 'enforce' ? 'confirmed with the project ID, and agreed' : 'confirmed with the project ID';
        const listChange = () => {
            const was = asList(before), now = asList(value);
            const added = now.filter(x => !was.includes(x)), removed = was.filter(x => !now.includes(x));
            const part = (verb, l) => (l.length ? `${verb} ${l.length > 10 ? `${l.length} entries` : l.join(', ')}` : '');
            return `${by} changed the allowlisted ${key === 'allowDomains' ? 'domains' : 'addresses'} on the dashboard (${how}): ${[part('added', added), part('removed', removed)].filter(Boolean).join('; ')}. Mail from them is never moved when Gmail's DMARC check passes for it.`;
        };
        const text = LIST_KEYS.includes(key) ? listChange()
            : key === 'aiScansInside' ? `${by} turned ${value ? 'on' : 'off'} the AI for mail from inside the organization on the dashboard (${how}): ${value ? `the AI reads it too now; its score alone ${this.cfg.aiMovesInside ? `moves it at ${policyWords('aiThreshold', this.cfg.aiThreshold)} or more ("AI alone moves inside mail" is on)` : 'still doesn\'t move it'}` : this.cfg.aiMovesInside ? 'but "AI alone moves inside mail" is on and needs it, so the AI keeps reading inside mail until that is off' : 'the rule checks alone read it now (its links, its headers and the rest)'}.`
            : key === 'aiMovesInside' ? (value
                ? `${by} turned on "AI alone moves inside mail" on the dashboard (${how}): an email from inside the organization that the AI scores ${policyWords('aiThreshold', this.cfg.aiThreshold)} or more is ${this.cfg.mode === 'enforce' ? 'moved to Spam' : 'recorded as "would move" (monitor mode)'} on the AI score alone, as outside mail is. The AI reads inside mail for it.`
                : `${by} turned off "AI alone moves inside mail" on the dashboard (${how}): the AI score alone no longer moves mail from inside the organization; the rules still can (a staff account taken over).${this.cfg.aiScansInside ? '' : ' The AI stops reading inside mail ("AI on inside mail" is off).'}`)
            : key === 'safeBrowsing' ? (value
                ? `${by} turned on Google Safe Browsing on the dashboard (${how}): the addresses of the links in each email are now also looked up with Google (without the part after "#", and one-time links without their query), within 30 seconds everywhere.`
                : `${by} turned off Google Safe Browsing on the dashboard (${how}): links are no longer sent to Google. The saved key stays in Secret Manager until it is removed.`)
            : key === 'mode'
            ? (value === 'enforce' ? `${by} switched to enforce mode on the dashboard (${how}): from now on, emails the policy flags are moved to Spam.`
                : `${by} switched to monitor mode on the dashboard (${how}): nothing is moved from now on, and emails already moved stay in Spam.`)
            : `${by} changed ${({ aiThreshold: 'the AI move threshold', aiSuspicious: 'the AI suspicious line', aiScansInside: 'whether the AI reads mail from inside the organization', aiMovesInside: 'whether the AI alone moves mail from inside the organization', brakePerHour: 'the brake', timeZone: 'the time zone', retentionDays: 'how long records are kept' })[key]} from ${policyWords(key, before)} to ${policyWords(key, value)} on the dashboard (${how}).`
              + (key === 'timeZone' ? ' The weekly summary uses it now; the nightly jobs move to it the next time deploy/install.sh runs.' : '')
              + (key === 'retentionDays' ? (value < before ? ` Records older than ${value} days are deleted over the next hours, the oldest first.`
                  : ` Records saved from now on are kept ${value} days; the ones already saved keep the date they had (${before} days after they arrived).`) : '');
        await this.adminNotice('settings', text, { policy: key });
        return { key, value, before };
    }

    // A Pub/Sub notification. Returns a summary (for logs and tests).
    async handleNotification({ emailAddress, historyId }) {
        await this.refreshPolicy();
        const user = String(emailAddress || '').toLowerCase();
        if (!user || !historyId) return { ignored: 'malformed' };
        // The mailbox's state, read once (whether it is watched, and where its history was read up to).
        const u = (await this.store.getUser(user)) || {};
        if (!this.cfg.pilotUsers.includes(user) && !u.watched) return { ignored: 'not watched' };
        // When Gmail last notified: written with the sync position (one write, not two); when that doesn't
        // move, at most every NOTED_EVERY_MS.
        const noted = { lastNotification: this.now() };
        const note = async () => { if (this.now() - (Number(u.lastNotification) || 0) >= NOTED_EVERY_MS) await this.store.putUser(user, noted); };
        if (!u.historyId) { await this.store.raiseHistoryId(user, String(historyId), noted); return { started: true }; }
        let added;
        try { added = await this.gmail.addedSince(user, u.historyId); }
        catch (e) {
            if (e instanceof GoogleApiError && e.status === 404) {
                // Too long since the last change we know of (Gmail keeps about a week): start again from now.
                // Checking goes on from now, and the Inbox mail since the last notification (at most a
                // week) is caught up on, a little with each later notification (backfillStep).
                const p = await this.gmail.profile(user);
                const after = Math.max(Number(u.lastNotification) || 0, this.now() - 7 * DAY);
                await this.store.putUser(user, Object.assign({ historyId: String(p.historyId), backfill: { after, pageToken: null, checked: 0 } }, noted));
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
                await this.store.incStat(this.dayOf(this.now()), 'errors');
                await this.store.addEvent({ kind: 'error', user, text: e.gaveUp
                    ? `A message couldn't be checked after ${MAX_TRIES} tries and was left where it is: ${why}`
                    : `A message couldn't be checked (try ${e.tries || 1} of ${MAX_TRIES}; it is tried again in a minute or so): ${why}` });
                this.log.error(`process ${user} ${id}:`, e);
                // An email left unchecked is a gap in the protection: the admins are told (0.5.29, once a day).
                if (e.gaveUp) await this.alertDaily('unchecked-mail', `An email to ${user} couldn't be checked after ${MAX_TRIES} tries and was left in the mailbox unchecked (${why.slice(0, 160)}). Any more today are listed in Status → Activity → Errors and gaps.`).catch(() => {});
                await this.gmailTrouble(e, user);
                continue;
            }
            if (r && r.busy) busy.push(id);
            else if (r) results.push(r);
        }
        if (busy.length && !(await this.othersDone(user, busy))) hold = true;
        // Nothing new for the Inbox (the user read or archived something; two thirds of notifications): the
        // sync position can wait up to QUIET_POSITION_MS, as the next notification reads the history from
        // where it is (2 quota units). No write, no transaction.
        const nothingNew = !added.ids.length && !(added.inboxed || []).length && !added.more && !u.backfill;
        if (hold || !movesForward(String(added.historyId), u.historyId)) await note();
        else if (nothingNew && this.now() - (Number(u.lastNotification) || 0) < QUIET_POSITION_MS) { /* written later */ }
        else await this.store.raiseHistoryId(user, String(added.historyId), noted);
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

    // A share from outside (a platform's notification for a person outside, or an outside email linking a
    // document, form or signature request: notifications.js shareSource): how many of the organization's
    // people the same outside account reached this hour (store.shareReach, by hashes). Reaching MASS_SHARE
    // is the usual sign of an account taken over elsewhere: an alert, once per account and hour.
    async countShare(facts, user, now) {
        const src = shareSource(facts, this.cfg.orgDomains);
        if (!src) return 0;
        try {
            const r = await this.store.shareReach(senderHash(src.address), senderHash(user), now, MASS_SHARE);
            if (r.crossed) {
                await this.alert('mass-share', `${src.address} (outside your organization) sent the same ${src.relay ? `${src.relay.via} share` : 'share or signature request'} to ${r.count} of your people within the hour. If it's phishing, Email → Campaigns → open it → Confirm phishing moves every copy.`);
            }
            return r.count;
        } catch (e) {
            this.log.error(JSON.stringify({ message: `Couldn't count an outside share: ${String(e && e.message || e).slice(0, 200)}` }));
            return 0;
        }
    }

    // "Check an email" (dashboard): an email an admin pasted (its original, from Gmail's "Show original")
    // or uploaded, judged as on arrival with the same lookups, in the current mode, brakes aside.
    // Nothing is stored, moved or counted. The answer has a record's shape, for the same view.
    async checkPasted(raw, { by = '' } = {}) {
        const facts = await readMessage(Buffer.from(String(raw), 'utf8'));
        const allowlisted = isAllowed(this.cfg, facts.senderAddress), verified = senderVerified(facts);
        // Judged for the recipient in the organization, if the email names one; else for the admin.
        const mailbox = (facts.to || []).find(a => this.cfg.orgDomains.includes(a.split('@')[1])) || by;
        const result = await analyze(facts, { mailbox, orgDomains: this.cfg.orgDomains, trusted: allowlisted && verified, firstTime: false, intel: this.intel, colleagues: await this.colleagueNames(), selfNameHash: this.selfNameHash(mailbox), aiInside: this.aiReadsInside() });
        result.allowlistedUnverified = allowlisted && !verified;
        const decision = decide(result, this.cfg, {});
        const domain = (facts.senderAddress.split('@')[1] || '').toLowerCase();
        return {
            pasted: true, key: null, messageId: null, rfc822MessageId: messageIdOf(facts.messageIdHeader), user: mailbox,
            receivedAt: facts.date || null, processedAt: this.now(),
            sender: { name: facts.senderName.slice(0, 200), address: facts.senderAddress.slice(0, 320), domain }, subject: facts.subject.slice(0, 300),
            status: result.status, score: result.score, signals: result.signals.slice(0, 30), links: result.links.slice(0, 20), checks: result.checks || null,
            ai: result.ai ? { probability: result.ai.probability, model: result.ai.model, reasons: (result.ai.reasons || []).map(r => ({ sentence: String(r.sentence).slice(0, 160), facts: !!r.facts })) } : null,
            auth: facts.auth ? { dmarc: facts.auth.dmarc, spf: facts.auth.spf, dkim: facts.auth.dkim } : null,
            attachments: facts.attachments.slice(0, 10).map(a => ({ name: a.name.slice(0, 120), type: a.type })),
            action: decision.action, trigger: decision.trigger, why: decision.why, mode: this.cfg.mode,
            evidence: decision.action === 'none' ? null : result.strong ? 'strong' : 'weak', confirmedBy: result.confirmedBy || []
        };
    }

    // An email re-scanned (Review, Messages: Re-scan): read again from its mailbox and judged as it would be
    // now, with today's checks and model, exactly as "Check an email" does. Its scores, AI opinion and signs
    // become the new ones (the email's page shows the newest scan); what they were on arrival is kept once
    // (arrival), and what happened to it (moved, flagged...) stays: nothing is moved, and the admin decides
    // with the usual buttons. Noted in Activity.
    // The colleague-name check's list: the full name of everyone in the directory, kept only as one-way hashes
    // (the extension's colleagueNameHash: "Smith, John" = "John Smith"), in memory, read again every 12 hours
    // (after a failure, every hour). Off (null) without DIRECTORY_ADMIN or with COLLEAGUE_NAMES=off; a
    // failed read (no Users → Read privilege or no admin.directory.user.readonly scope) keeps the last list
    // and is noted in state/colleagueNames for Status, never alerted.
    async colleagueNames() {
        if (!this.cfg.colleagueNames || !this.cfg.directoryAdmin || !this.gmail || typeof this.gmail.userNames !== 'function') return null;
        const now = this.now(), c = this.colleagues;
        if (c && now - c.at < (c.error ? HOUR : 12 * HOUR)) return c.hashes;
        if (this.colleaguesLoading) return this.colleaguesLoading;
        this.colleaguesLoading = (async () => {
            try {
                const E = require('./engine/spruce').load();
                const names = await this.gmail.userNames(this.cfg.directoryAdmin);
                // Each { name, email } (or a name alone): only one-way hashes are kept, in memory.
                const people = names.map(n => (typeof n === 'string' ? { name: n, email: '' } : n || {}));
                const hashes = new Set(people.map(p => E.colleagueNameHash(p.name)).filter(Boolean));
                const byEmail = new Map(people.filter(p => p.email).map(p => [String(p.email).toLowerCase(), E.colleagueNameHash(p.name)]).filter(([, h]) => h));
                this.colleagues = { hashes, byEmail, at: now, error: null };
                await this.store.setState('colleagueNames', { at: now, names: hashes.size, error: null }).catch(() => {});
            } catch (e) {
                const error = String(e && e.message || e).slice(0, 300);
                this.colleagues = { hashes: c ? c.hashes : null, byEmail: c ? c.byEmail : null, at: now, error };
                await this.store.setState('colleagueNames', { at: now, names: c && c.hashes ? c.hashes.size : 0, error }).catch(() => {});
                if (!c || !c.error) this.log.warn(JSON.stringify({ message: `Couldn't read the directory's names for the colleague-name check: ${error}` }));
            } finally { this.colleaguesLoading = null; }
            return this.colleagues.hashes;
        })();
        return this.colleaguesLoading;
    }

    // The recipient's own name's hash (colleagueNames), or ''.
    selfNameHash(user) { const c = this.colleagues; return (c && c.byEmail && c.byEmail.get(String(user || '').toLowerCase())) || ''; }

    // Whether the AI model reads mail from inside the organization (verified: your domains, DMARC passing):
    // AI_SCANS_INSIDE (Settings → Policy), off by default; AI_MOVES_INSIDE needs it, so it counts too.
    aiReadsInside() { return !!(this.cfg.aiScansInside || this.cfg.aiMovesInside); }

    // "Show more" on an email's AI opinion: what the model reads of it, sentence by sentence, each with how far
    // it leans toward phishing, so an admin can decide with the surrounding text. Read from Gmail now (the
    // service stores no email text), with addresses, phone numbers and long numbers already replaced as the
    // model sees them; nothing is stored or moved, and Activity notes who looked.
    async aiContext(key, by) {
        const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
        const rec = await this.store.getRecord(key);
        if (!rec || !rec.user || !rec.messageId) fail(404, 'That email isn\'t recorded.');
        let msg;
        try { msg = await this.gmail.raw(rec.user, rec.messageId); }
        catch (e) { if (e && e.status === 404) fail(404, 'The email is no longer in the mailbox (deleted for good): its text can\'t be read.'); throw e; }
        if (!msg || !msg.raw || !msg.raw.length) fail(404, 'The email is no longer in the mailbox: its text can\'t be read.');
        const facts = await readMessage(msg.raw);
        const allowlisted = isAllowed(this.cfg, facts.senderAddress), verified = senderVerified(facts);
        const result = await analyze(facts, { mailbox: rec.user, orgDomains: this.cfg.orgDomains, trusted: allowlisted && verified, firstTime: false, intel: this.intel, keepAiFacts: true, aiInside: this.aiReadsInside() });
        const skipped = result.ai && result.ai.skipped;
        const reading = !skipped && result.language.english ? await aiReading(result.aiFacts) : null;
        await this.store.addEvent({ kind: 'check', user: rec.user,
            text: `${by} opened what the AI reads of an email to ${rec.user} from ${(rec.sender && rec.sender.domain) || 'an unknown sender'} (read from Gmail just now; nothing stored).` });
        return { language: result.language, reading, skipped: skipped || null };
    }

    async rescan(key, by) {
        const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
        const rec = await this.store.getRecord(key);
        if (!rec || !rec.user || !rec.messageId) fail(404, 'That email isn\'t recorded.');
        let msg;
        try { msg = await this.gmail.raw(rec.user, rec.messageId); }
        catch (e) { if (e && e.status === 404) fail(404, 'The email is no longer in the mailbox (deleted for good): it can\'t be re-scanned.'); throw e; }
        if (!msg || !msg.raw || !msg.raw.length) fail(404, 'The email is no longer in the mailbox: it can\'t be re-scanned.');
        const facts = await readMessage(msg.raw);
        const allowlisted = isAllowed(this.cfg, facts.senderAddress), verified = senderVerified(facts);
        // The sender counts as new if it was on arrival (by now it isn't, and that would change the rules'
        // score, not the model or the checks): from the arrival's signs, kept with them after a re-scan.
        const firstTime = rec.arrival ? !!rec.arrival.firstTime : (rec.signals || []).some(x => x && x.kind === 'first-time');
        const result = await analyze(facts, { mailbox: rec.user, orgDomains: this.cfg.orgDomains, trusted: allowlisted && verified, firstTime, intel: this.intel, colleagues: await this.colleagueNames(), selfNameHash: this.selfNameHash(rec.user), aiInside: this.aiReadsInside() });
        result.allowlistedUnverified = allowlisted && !verified;
        const decision = decide(result, this.cfg, {});
        const ai = aiRecord(result.ai, this.cfg);
        // What it was on arrival: kept from the first re-scan on (a record re-scanned by 0.5.3 still has it in ai).
        const arrival = rec.arrival || { at: rec.processedAt, score: rec.score, status: rec.status, firstTime,
            ai: rec.ai && typeof rec.ai.probability === 'number' ? { probability: rec.ai.probability, model: rec.ai.model || null } : null };
        const rescan = {
            at: this.now(), by, mode: this.cfg.mode,
            model: ai ? ai.model : null, ai: ai && typeof ai.probability === 'number' ? ai.probability : null,
            score: result.score, status: result.status, action: decision.action, trigger: decision.trigger, why: decision.why
        };
        const patch = { rescan, arrival, ai, score: result.score, status: result.status, signals: result.signals.slice(0, 20), links: result.links.slice(0, 10), checks: result.checks || null, inside: !!result.inside };
        const record = await this.store.updateRecord(key, patch);
        const pc = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : 'none');
        const was = arrival.ai ? arrival.ai.probability : null;
        const now = { move: 'it would be moved to Spam', 'would-move': 'it would be recorded as "would move"', flag: 'it would be recorded as suspicious', none: 'nothing would happen' }[decision.action] || decision.action;
        await this.store.addEvent({ kind: 'check', user: rec.user,
            text: `${by} re-scanned an email to ${rec.user} from ${(rec.sender && rec.sender.domain) || 'an unknown sender'}: AI ${pc(rescan.ai)} with ${rescan.model || 'no model'} (${pc(was)} on arrival${arrival.ai && arrival.ai.model && arrival.ai.model !== rescan.model ? ` with ${arrival.ai.model}` : ''}), rules score ${rescan.score} (${arrival.score} on arrival); now ${now}. Nothing was moved.` });
        return { record, rescan };
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
                out = await this.emailSlots.run(() => this.readAndJudge(user, msg, { userPlaced: true }));
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

    checkMessage(user, id, tries) { return this.emailSlots.run(() => this.checkMessageNow(user, id, tries)); }
    async checkMessageNow(user, id, tries) {
        let msg;
        try { msg = await this.gmail.raw(user, id); }
        catch (e) { if (e instanceof GoogleApiError && e.status === 404) return null; throw e; } // deleted before it was read
        // The service's own weekly summary (put in an admin's Inbox): never judged.
        if (isSummary(msg.raw)) return null;
        // An earlier try that moved it and failed before its record was written: write the record now,
        // without moving it again (it has the service's own label, which only the service adds).
        if (tries > 1 && !(await this.store.getRecord(recordKey(user, id)))
            && msg.labelIds.includes(await this.gmail.labelId(user, this.cfg.movedLabel))) {
            return this.readAndJudge(user, msg, { alreadyMoved: true });
        }
        // Only mail that arrived in the Inbox: not the user's own sent mail or drafts, nor what Gmail already put in Spam.
        if (!msg.labelIds.includes('INBOX') || msg.labelIds.some(l => l === 'SENT' || l === 'DRAFT' || l === 'SPAM')) return null;
        return this.readAndJudge(user, msg);
    }

    // Analysis, decision, action and record for one message (also used by the tests and the demo).
    // alreadyMoved: an earlier try moved it (and was counted); only the record is written.
    // userPlaced: the user moved it into the Inbox themselves (checkUnseenInbox): never moved.
    async judge(user, msg, facts, { alreadyMoved = false, userPlaced = false } = {}) {
        const now = this.now();
        const day = this.dayOf(now);
        if (!alreadyMoved) await this.count(day, 'scanned');
        // Both never change once set, so each instance asks Firestore once: when the service was installed,
        // and when each sender was first seen (a campaign's 10,000 copies cost one look, not 10,000).
        const installedAt = this.installedAt || (this.installedAt = (await this.store.getState('installedAt')) || (await this.store.setState('installedAt', now), now));
        // A platform's notification for a person (a Drive share, DocuSign…) is first seen by the person's own
        // address, not the platform's, which every share comes from (0.5.16).
        const relay = platformNotification(facts, this.cfg.orgDomains);
        const who = relay ? relay.address : facts.senderAddress;
        const first = who ? await this.firstSeen(senderHash(who), now) : now;
        const learning = now - installedAt < this.cfg.firstSeenLearningDays * DAY;
        const shareReach = alreadyMoved ? 0 : await this.countShare(facts, user, now);
        // Allowlisted only with DMARC passing for the address (policy.js).
        const allowlisted = isAllowed(this.cfg, facts.senderAddress), verified = senderVerified(facts);
        const result = await analyze(facts, { mailbox: user, orgDomains: this.cfg.orgDomains, trusted: allowlisted && verified, firstTime: !!who && !learning && now - first < DAY, intel: this.intel,
            colleagues: await this.colleagueNames(), selfNameHash: this.selfNameHash(user), shareReach, aiInside: this.aiReadsInside() });
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
            rfc822MessageId: messageIdOf(facts.messageIdHeader),
            receivedAt: msg.internalDate || facts.date || now, processedAt: now,
            sender: { name: facts.senderName.slice(0, 200), address: facts.senderAddress.slice(0, 320), domain: senderDomain },
            subject: this.cfg.storeSubjects ? facts.subject.slice(0, 300) : '',
            campaign: campaign.key, campaignLabel,
            status: result.status, score: result.score, signals: result.signals.slice(0, 20), links: result.links.slice(0, 10), checks: result.checks || null,
            ai: aiRecord(result.ai, this.cfg),
            auth: facts.auth ? { dmarc: facts.auth.dmarc, spf: facts.auth.spf, dkim: facts.auth.dkim } : null,
            attachments: facts.attachments.slice(0, 10).map(a => ({ name: a.name.slice(0, 120), type: a.type })),
            action: decision.action, trigger: decision.trigger, why: decision.why, braked: held === 'brake', held, mode: this.cfg.mode,
            // How sure: strong = the rules flagged it and something outside the email confirms it.
            evidence: result.strong ? 'strong' : 'weak', confirmedBy: result.confirmedBy || [],
            ownAddressUnverified: !!(result.ownAddress && !result.inside), userPlaced: userPlaced || undefined,
            // From inside the organization (your domains, DMARC passing), as the policy judged it (Model health).
            inside: !!result.inside,
            state, releasedBy: null, releasedAt: null, falseAlarm: null, markedBy: null
        };
        await this.store.saveRecord(rec);
        await this.count(day, decision.action === 'move' ? 'moved' : decision.action === 'would-move' ? 'wouldMove' : 'flagged');
        if (decision.action === 'move' && !this.alerted.has(campaign.key)) {
            // (counted until the campaign's alert is sent; after that this instance writes nothing more)
            if (await this.store.campaignMoved(campaign.key, this.cfg.campaignAlertAfter, now, () => this.alerted.add(campaign.key))) {
                await this.alert('campaign', `A large campaign: ${this.cfg.campaignAlertAfter} copies of "${campaignLabel}" moved to Spam so far (${rec.evidence} evidence). The dashboard's Email → Campaigns page lists who received it.`, { campaign: campaign.key });
            }
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
        const released = (d) => ({ decision: { action: 'flag', trigger: d.trigger, why: `${d.why}; an admin dismissed this campaign as a false alarm, so its copies aren't moved` }, held: null });
        if (cs && cs.decision === 'released') return released(decision);
        if (!result.strong && !(cs && cs.decision === 'confirmed')) {
            const h = await this.store.campaignHold(campaignKey, this.cfg.campaignHoldAfter, now, campaignLabel);
            if (h.decision === 'released') return released(decision);
            if (h.held) {
                if (h.first) await this.alert('campaign-held', `Moving copies of "${campaignLabel}" is paused: more than ${this.cfg.campaignHoldAfter} were moved on evidence nothing outside the email confirms, so the next ones stay in the Inbox, like any email not moved. Confirm it as phishing (every copy is moved to Spam) or dismiss it as a false alarm (the moved ones go back to the Inbox): on the dashboard, Email → Campaigns, then open the campaign.`, { campaign: campaignKey });
                return { decision: { action: 'would-move', trigger: decision.trigger, why: `${decision.why} (not moved: moving this campaign is paused after ${this.cfg.campaignHoldAfter} copies on evidence nothing outside the email confirms, until an admin confirms it or dismisses it)` }, held: 'campaign' };
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
        await this.alert('brake', `${count} emails were moved within the hour (limit ${limit}). Moving has stopped in every mailbox: from now on, emails that would be moved stay in the Inbox, like any other email, until an admin resumes on the dashboard (Overview), which can also move them then.`);
    }

    // An alert: in Recent activity, and a log line Cloud Monitoring emails to ALERT_EMAIL (install.sh).
    async alert(kind, text, extra = {}) {
        await this.store.addEvent(Object.assign({ kind, text, alert: true }, extra));
        if (this.log.warn) this.log.warn(JSON.stringify({ severity: 'WARNING', spruceAlert: kind, message: text }));
    }
    // Alerts are the problems the admins are emailed about (0.5.28): a list that missed its download, a
    // service or the AI model that stopped working, the brake, a campaign paused… An admin's own action (a
    // policy change, an update started, a Safe Browsing key) isn't one: it is recorded in Activity → What
    // admins did, and not emailed.
    async adminNotice(kind, text, extra = {}) { await this.store.addEvent(Object.assign({ kind, text, admin: true }, extra)); }
    // Gmail refusing the service (0.5.29): domain-wide delegation removed or its scopes changed, the service
    // account's token refused. Every email then goes unchecked, while Gmail's notifications keep coming (so
    // the "quiet" alert never fires): the admins are told at once, then once a day while it lasts.
    static isGmailAccessError(e) {
        const m = String((e && e.message) || e || '');
        return /^token for .*: HTTP 4\d\d/.test(m) || /unauthorized_client|invalid_grant|Delegation denied|domain-wide delegation/i.test(m)
            || (e && (e.status === 401 || (e.status === 403 && !/rateLimitExceeded|userRateLimitExceeded/i.test(m))));
    }
    async gmailTrouble(e, user) {
        if (!Service.isGmailAccessError(e)) return false;
        return this.alertDaily('gmail-access', `Gmail refused the service for ${user} (${String((e && e.message) || e).slice(0, 200)}): new mail there isn't checked. Usually the domain-wide delegation was removed or its scopes changed (Admin console → Security → API controls → Domain-wide delegation; docs/INSTALL.md, step 3). bash deploy/doctor.sh checks the rest.`).catch(() => false);
    }
    // An alert at most once a day (per kind and UTC day, whichever instance sees it first): for a problem that
    // lasts (a lookup service down, the AI model not loading).
    async alertDaily(kind, text, extra = {}) {
        if (!(await this.store.setStateIfUnset(`alert-${kind}-${new Date(this.now()).toISOString().slice(0, 10)}`, { at: this.now() }))) return false;
        await this.alert(kind, text, extra);
        return true;
    }

    async brakeOn() { return !!(await this.store.getState('brake')); }
    // The admin resumes: the hour's count starts again (a new counter), and with moveHeld the copies the
    // brake held since it came on are moved now (those still in the Inbox).
    async resume(by, { moveHeld = false } = {}) {
        const brake = await this.store.getState('brake');
        await this.store.setState('brakeResumedAt', this.now());
        await this.store.setState('brake', null);
        const out = moveHeld && brake ? await this.moveHeld(r => r.held === 'brake' && r.processedAt >= brake.at, by, 'resumed moving', { sinceMs: brake.at }) : null;
        await this.store.addEvent({ kind: 'resume', text: `Moving resumed by ${by}${out ? (out.monitor ? '' : `; ${out.moved} emails left in the Inbox while the brake was on were moved to Spam${out.gone ? `, ${out.gone} no longer in the Inbox` : ''}`) : ''}.` });
        return { ok: true, held: out };
    }

    // Moves held or recorded copies now, those still in the Inbox (an admin's resume or confirmation;
    // not counted by the brake). Enforce mode only. { moved, gone, failed, left }.
    // records: the candidates when the caller has them (a campaign's), else the last 14 days' (or sinceMs on).
    async moveHeld(match, by, how, { budgetMs = 200000, max = 5000, records = null, sinceMs = null } = {}) {
        if (this.cfg.mode !== 'enforce') return { moved: 0, gone: 0, failed: 0, left: 0, monitor: true };
        const recs = (records || await this.store.listRecords({ sinceMs: sinceMs !== null ? sinceMs : this.now() - 14 * DAY, limit: 100000 }))
            .filter(r => r.state === 'inbox' && r.action !== 'move' && match(r)).slice(0, max);
        const start = Date.now();
        const out = { moved: 0, gone: 0, failed: 0, left: 0 };
        await pool(recs, 10, async (r) => {
            try { out[await this.moveRecord(r, by, how)]++; } catch (e) { out.failed++; this.log.error(`move held ${r.key}:`, e); }
        }, () => Date.now() - start > budgetMs);
        out.left = recs.length - out.moved - out.gone - out.failed;
        return out;
    }
    // One recorded email still in the Inbox, moved to Spam because an admin decided so (the caller checks
    // enforce mode). 'moved', or 'gone' when it isn't in the Inbox any more (deleted, archived, moved by
    // the user), and then it is left where it is.
    async moveRecord(r, by, how) {
        let labels = null;
        try { labels = await this.gmail.labels(r.user, r.messageId); } catch (e) { if (!(e instanceof GoogleApiError && e.status === 404)) throw e; }
        if (!labels || !labels.includes('INBOX')) return 'gone';
        await this.gmail.modify(r.user, r.messageId, ['SPAM', await this.gmail.labelId(r.user, this.cfg.movedLabel)], ['INBOX']);
        const now = this.now();
        await this.store.updateRecord(r.key, { action: 'move', state: 'moved', held: null, braked: false, why: `${r.why}; moved when ${by} ${how}`, heldMovedBy: by, heldMovedAt: now });
        await this.store.incStat(this.dayOf(now), 'moved');
        return 'moved';
    }

    // --- Campaigns: an admin's decision for every copy -----------------------------------------
    // A campaign's records (of the last 90 days): asked of the store by campaign, not found among the newest.
    async campaignRecords(key) { return this.store.listCampaignRecords(key, this.now() - 90 * DAY); }
    // Confirmed as phishing: every recorded copy still in the Inbox is moved (enforce mode), every copy
    // is marked phishing, later copies are moved without being held, and with search the watched
    // mailboxes are searched for copies the service didn't record (findCopies).
    async confirmCampaign(key, by, { search = false } = {}) {
        const recs = await this.campaignRecords(key);
        if (!recs.length) return { error: 'not found', status: 404 };
        // Within the dashboard's request time (5 minutes): moving first, then searching with what is left.
        const start = Date.now();
        await this.store.setCampaign(key, { decision: 'confirmed', decidedBy: by, decidedAt: this.now(), label: recs[0].campaignLabel });
        const moved = await this.moveHeld(r => r.campaign === key, by, 'confirmed the campaign as phishing', { budgetMs: 150000, records: recs });
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
        await this.store.addEvent({ kind: 'campaign', campaign: key, text: `${by} dismissed "${recs[0].campaignLabel}" as a false alarm: ${released} copies moved back to the Inbox${failed ? `, ${failed} couldn't be moved back` : ''}. Later copies aren't moved.` });
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
                        key: recordKey(user, id), user, messageId: id, threadId: m.threadId || '', readHistoryId: null, rfc822MessageId: messageIdOf(m.messageId),
                        receivedAt: m.internalDate || now, processedAt: now,
                        sender: { name: '', address: address.slice(0, 320), domain }, subject: this.cfg.storeSubjects ? String(m.subject).slice(0, 300) : '',
                        campaign: key, campaignLabel: recs[0].campaignLabel, status: 'flagged', score: null,
                        signals: [{ weight: 0, kind: 'campaign-copy', text: `A copy of a campaign ${by} confirmed as phishing.` }], links: [], checks: null, ai: null, auth: null, attachments: [],
                        action: moving ? 'move' : 'would-move', trigger: 'admin', why: `found by ${by}'s search for copies of the campaign${moving ? '' : this.cfg.mode === 'enforce' ? ' (not moved: the campaign isn\'t confirmed)' : ' (monitor mode: not moved)'}`,
                        braked: false, held: null, mode: this.cfg.mode, evidence: 'admin', confirmedBy: [],
                        state: moving ? 'moved' : 'inbox', releasedBy: null, releasedAt: null, falseAlarm: false, markedBy: by
                    });
                    await this.store.incStat(this.dayOf(now), moving ? 'moved' : 'wouldMove');
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
        if (rec.state !== 'moved') return { error: `it is ${rec.state === 'released' ? 'already back in the Inbox' : 'still in the Inbox'}` };
        const released = await this.gmail.labelId(rec.user, this.cfg.releasedLabel);
        const moved = await this.gmail.labelId(rec.user, this.cfg.movedLabel);
        // Noted first: the Inbox label this adds comes back in the history, and must not read as the user's.
        await this.store.updateRecord(key, { releasingAt: this.now() });
        await this.gmail.modify(rec.user, rec.messageId, ['INBOX', released], ['SPAM', moved]);
        const now = this.now();
        const out = await this.store.updateRecord(key, { state: 'released', releasedBy: by, releasedByUser: false, releasedAt: now, falseAlarm: rec.falseAlarm === null ? true : rec.falseAlarm, markedBy: rec.markedBy || by });
        await this.store.incStat(this.dayOf(now), 'released');
        if (!quiet) await this.store.addEvent({ kind: 'release', user: rec.user, text: `${by} moved an email from ${rec.sender.address} to ${rec.user} back to the Inbox.` });
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
        await this.store.incStat(this.dayOf(now), 'released');
        await this.store.incStat(this.dayOf(now), 'userReleased');
        const strong = rec.score >= 5 && rec.trigger !== 'ai';
        const text = strong ? `${user} moved an email from ${rec.sender.address} back to the Inbox, though the checks flagged it (score ${rec.score}). Make sure it's safe, or mark it phishing and warn them.`
                            : `${user} moved an email from ${rec.sender.address} back to the Inbox (counted as a false alarm).`;
        if (strong) await this.alert('user-release', text, { user, key });
        else await this.store.addEvent({ kind: 'user-release', user, key, text });
        return out;
    }

    // An admin's judgment of a record: a false alarm (genuine) or right (phishing or spam).
    // An admin's verdict on one email: a false alarm (not phishing), or phishing. With move, phishing that
    // is still in the Inbox is also moved to Spam, in enforce mode only (Review's "Phishing: move to
    // Spam"). moved: 'moved'; 'gone' (no longer in the Inbox); 'monitor' (nothing is moved in monitor
    // mode); 'not-in-inbox' (already in Spam, or moved back by an admin, whose decision stands); or null.
    async mark(key, falseAlarm, by, { move = false, quiet = false } = {}) {
        const rec = await this.store.getRecord(key);
        if (!rec) return { error: 'not found' };
        let out = await this.store.updateRecord(key, { falseAlarm: !!falseAlarm, markedBy: by });
        if (falseAlarm && rec.falseAlarm !== true) await this.store.incStat(this.dayOf(this.now()), 'falseAlarms');
        let moved = null;
        if (!falseAlarm && move) {
            await this.refreshPolicy();
            moved = this.cfg.mode !== 'enforce' ? 'monitor' : rec.state !== 'inbox' || rec.action === 'move' ? 'not-in-inbox' : await this.moveRecord(out, by, 'confirmed it as phishing');
            if (moved === 'moved') {
                out = await this.store.getRecord(key);
                if (!quiet) await this.store.addEvent({ kind: 'mark', user: rec.user, text: `${by} confirmed an email from ${rec.sender.address} to ${rec.user} as phishing and moved it to Spam.` });
            }
        }
        return { record: out, moved };
    }

    // Cloud Scheduler, daily: watch every pilot mailbox again (a watch lasts 7 days) and forget
    // mailboxes that left the pilot.
    async renewWatches({ budgetMs = RENEW_BUDGET_MS, parallel = RENEW_PARALLEL } = {}) {
        const started = Date.now();
        await this.refreshPolicy();
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
        // Every mailbox's state in one read (not one read per mailbox).
        const known = new Map((await this.store.listUsers()).map(u => [u.email, u]));
        const now = this.now();
        const expiry = (u) => { const k = known.get(u); return k && k.watched && Number(k.watchExpiration) || 0; };
        // New members and the watches renewed longest ago first; one renewed in the last RENEW_FRESH_MS waits.
        const todo = [...users].filter(u => expiry(u) < now + WATCH_MS - RENEW_FRESH_MS).sort((a, b) => expiry(a) - expiry(b));
        const out = new Map();   // user → new expiration
        let failed = 0;
        const over = () => Date.now() - started > budgetMs;
        await pool(todo, parallel, async (user) => {
            try {
                const w = await this.gmail.watch(user, this.cfg.pubsubTopic);
                const k = known.get(user);
                const exp = Number(w.expiration) || null;
                await this.store.putUser(user, Object.assign({ watched: true, watchExpiration: exp }, k && k.historyId ? {} : { historyId: String(w.historyId) }));
                out.set(user, exp || now + WATCH_MS);
            } catch (e) {
                failed++;
                await this.store.addEvent({ kind: 'error', user, text: `Couldn't watch ${user}'s mailbox: ${String(e.message).slice(0, 200)}` });
            }
        }, over);
        let stopped = 0;
        const gone = [...known.values()].filter(u => u.watched && !users.has(u.email));
        await pool(gone, parallel, async (u) => {
            try { await this.gmail.stop(u.email); } catch (e) { /* already stopped */ }
            await this.store.putUser(u.email, { watched: false, watchExpiration: null });
            stopped++;
        }, over);
        // (Stopped before 0.4.1, their watches' end left behind: cleared, so "watches ending" counts only
        // the watched.)
        await pool([...known.values()].filter(u => !u.watched && u.watchExpiration && !users.has(u.email)), parallel, (u) => this.store.putUser(u.email, { watchExpiration: null }), over);
        // Watched now: every member whose watch (renewed now, or before) hasn't ended. The automatic brake
        // is half of these.
        const ok = [...users].filter(u => (out.get(u) || expiry(u)) > now).length;
        const left = todo.length - out.size - failed;
        await this.store.setState('watchedCount', ok);
        // What was found, for Recent activity (and the log, without addresses): so a count that looks
        // wrong says why.
        const text = watchSummary({ ok, failed, stopped, groups, extra: this.cfg.pilotUsers.length, ou: this.cfg.pilotOu, orgDomains: this.cfg.orgDomains, renewed: out.size, left });
        await this.store.addEvent({ kind: 'watch', text });
        if (this.log.info) this.log.info(`renew-watches: ${text}`);
        return { watched: ok, renewed: out.size, left, failed };
    }

    // Switching the service off: Gmail stops notifying for every watched mailbox. (Also remove the
    // Scheduler job that renews watches, or it starts them again; docs/DEPLOY.md.)
    async stopAll() {
        let stopped = 0;
        for (const u of await this.store.listUsers()) {
            if (!u.watched) continue;
            try { await this.gmail.stop(u.email); } catch (e) { /* already stopped */ }
            await this.store.putUser(u.email, { watched: false, watchExpiration: null });
            stopped++;
        }
        await this.store.addEvent({ kind: 'mode', text: `All ${stopped} mailbox watches were stopped.` });
        return { stopped };
    }

    // Cloud Scheduler, daily: records older than RETENTION_DAYS are deleted.
    // Records after RETENTION_DAYS; Activity (what admins did, alerts) after AUDIT_DAYS (0.5.29, a year by default).
    purge(opts = {}) { return this.store.purge(this.now() - this.cfg.retentionDays * DAY, Object.assign({ eventsBeforeMs: this.now() - (this.cfg.auditDays || 365) * DAY }, opts)); }

    // Cloud Scheduler, hourly (the spruce-sync-feeds job): the health check, then the phishing lists,
    // downloaded once a day for everyone (src/intel/feeds.js; a failed download is tried again the next
    // day, not every hour).
    // Since 0.4.1 it also deletes what Firestore's TTL policies don't (documents written before 0.4.0),
    // last, with what is left of the request's time (at most 30 s): no daily job of its own, so the
    // installation keeps to Cloud Scheduler's 3 free jobs.
    async syncFeeds() {
        const started = Date.now();
        await this.refreshPolicy();
        let health, digest = null, out;
        try { health = await this.health(); } catch (e) { health = { error: String(e.message || e).slice(0, 200) }; }
        try { digest = await this.maybeDigest(); } catch (e) { digest = { error: String(e.message || e).slice(0, 200) }; this.log.error('weekly summary:', e); }
        if (digest) health.digest = digest;
        if (!this.intel || !this.intel.feeds) out = { health, skipped: 'phishing lists are off' };
        else {
            const last = Number(await this.store.getState('feedsAttemptedAt')) || 0;
            const retried = Number(await this.store.getState('feedsRetriedAt')) || 0;
            if (this.now() - last >= 20 * HOUR) { await this.store.setState('feedsAttemptedAt', this.now()); out = Object.assign({ health }, await this.intel.feeds.sync()); }
            // A list that missed its download is tried again every 3 hours (only that one), not a day later.
            else if (this.now() - Math.max(last, retried) >= LIST_RETRY_MS && (await this.intel.feeds.status()).some(l => l.missed === 'failed')) {
                await this.store.setState('feedsRetriedAt', this.now());
                out = Object.assign({ health, retry: true }, await this.intel.feeds.sync({ retryFailed: true }));
            } else out = { health, skipped: 'checked within the day' };
            if (out.feeds) { try { await this.listsAlert(out.feeds); } catch (e) { this.log.error('phishing lists, alert:', e); } }
        }
        // An update from Settings → Update that failed, or stopped (0.5.28): the build records it in Activity;
        // the admins are emailed here, once (the build itself can't send the email).
        try { await this.updateProblems(); } catch (e) { this.log.error('the last update\'s outcome:', e); }
        // An approved version that needs a manual install (0.5.24): noted, and the admins alerted once.
        if (this.releases) {
            try { const m = await require('./update').checkManualInstall({ cfg: this.cfg, store: this.store, releases: this.releases, cloudrun: this.cloudrun || null, alert: (t) => this.alert('update-manual', t) }); if (m) out.manualInstall = m.manual.version; }
            catch (e) { /* GitHub not reachable: the page says so */ }
        }
        const budgetMs = Math.min(30 * 1000, 90 * 1000 - (Date.now() - started));
        if (budgetMs > 0) { try { out.purged = await this.purge({ budgetMs }); } catch (e) { out.purged = { error: String(e.message || e).slice(0, 200) }; } }
        return out;
    }

    // A list that missed its download (0.5.22): an alert (Recent activity, and emailed to ALERT_EMAIL, the
    // admins by default), when a list newly fails, and once a day while one keeps failing; the overview says
    // so until it downloads again. (A list downloading again is noted in Activity by feeds.js.)
    async listsAlert(results) {
        const failed = (results || []).filter(r => r.error);
        if (!failed.length) return false;
        const last = Number(await this.store.getState('listsAlertAt')) || 0;
        if (!failed.some(r => r.newly) && this.now() - last < DAY) return false;
        await this.store.setState('listsAlertAt', this.now());
        const n = failed.length;
        await this.alert('list-download', `${n === 1 ? 'A phishing list' : `${n} phishing lists`} missed ${n === 1 ? 'its' : 'their'} download: ${failed.map(r => `${r.name} (${r.error})`).join('; ')}. `
            + `The previous copy is still used, and the download is tried again every 3 hours. Dashboard: Settings → About shows each list's state, with a Re-check button.`);
        return true;
    }
    async updateProblems() {
        const up = await this.store.getState('update');
        if (!up || !up.at) return null;
        const stalled = ['requested', 'building'].includes(up.phase) && this.now() - up.at > require('./update').RUNNING_MS;
        if (up.phase !== 'failed' && !stalled) return null;
        if (!(await this.store.setStateIfUnset(`updateProblemEmailed-${up.at}`, { at: this.now() }))) return null;
        const text = up.phase === 'failed'
            ? `The update from ${up.from || 'the installed version'} to ${up.version} failed: ${up.message || 'it stopped'}. Nothing changed, unless the deploy stopped half-way (then bash deploy/rollback.sh goes back). Cloud Build's history has the log (tag spruce-update).`
            : `The update to ${up.version} asked for by ${up.by || 'an admin'} didn't finish within 45 minutes. Cloud Build's history (tag spruce-update) says why; Settings → Update shows it too.`;
        // (a failed one is already in Activity, recorded by the build: emailed only; a stalled one is recorded too)
        if (up.phase === 'failed') { if (this.log.warn) this.log.warn(JSON.stringify({ severity: 'WARNING', spruceAlert: 'update-failed', message: text })); }
        else await this.alert('update-failed', text);
        return text;
    }
    // An admin's "Re-check" (Settings → About): every list that missed its download, or isn't up to date, is
    // downloaded again now; one downloaded within the day is left as it is (the projects publish them for free).
    async recheckLists(by) {
        if (!this.intel || !this.intel.feeds) return { error: 'The phishing lists are off (PHISHING_LISTS=off).', status: 400 };
        const out = await this.intel.feeds.sync({ retryFailed: true });
        const got = out.feeds.filter(r => r.count != null), failed = out.feeds.filter(r => r.error);
        await this.store.addEvent({ kind: 'lists', admin: true, text: `${by} re-checked the phishing lists: ${got.length ? `${got.map(r => r.name).join(', ')} downloaded` : 'none needed a download'}${failed.length ? `; ${failed.map(r => r.name).join(', ')} still missed ${failed.length === 1 ? 'its' : 'their'} download` : ''}.` });
        return { feeds: out.feeds, recovered: out.recovered || [], lists: await this.intel.feeds.status() };
    }

    // --- The weekly summary email (dashboard Settings; off by default) --------------------------------
    // To the dashboard's admins in the organization: ADMIN_EMAILS and the members of ADMIN_GROUP.
    async digestRecipients() {
        const out = new Set(this.cfg.adminEmails);
        for (const g of this.cfg.adminGroups) for (const u of await this.gmail.groupMembers(this.cfg.directoryAdmin, g, this.cfg.orgDomains)) out.add(u);
        return [...out].filter(a => this.cfg.orgDomains.includes(a.split('@')[1]));
    }
    async digestContent(now = this.now()) {
        const records = await this.store.listRecords({ sinceMs: now - 8 * DAY, limit: 100000 });
        const stats = await this.store.getStats(this.dayOf(now - 7 * DAY), this.dayOf(now));
        const events = await this.store.listEvents(now - 7 * DAY);
        const users = (await this.store.listUsers()).filter(u => u.watched);
        const held = (await this.store.listHeldCampaigns()).filter(c => !c.decision).length;
        const readiness = this.cfg.mode === 'enforce' ? null : A.readiness(records, { now, days: 7, mode: this.cfg.mode, installedAt: await this.store.getState('installedAt'),
            brakeLimit: await this.brakeLimit(), holdAfter: this.cfg.campaignHoldAfter, watched: users.length,
            lastNotification: Math.max(0, ...users.map(u => Number(u.lastNotification) || 0)) || null, quietHours: this.cfg.quietHours, renew: null });
        return buildDigest(records, stats, events, { now, mode: this.cfg.mode, timeZone: this.cfg.timeZone, dashboardUrl: this.cfg.dashboardUrl,
            watched: users.length, held, brake: !!(await this.store.getState('brake')), readiness });
    }
    // Puts this week's summary in each admin's Inbox now. { sent, to, failed }.
    async sendDigest({ by = null } = {}) {
        const to = await this.digestRecipients();
        if (!to.length) return { sent: 0, to: [], failed: [], error: 'nobody to send it to (ADMIN_EMAILS, ADMIN_GROUP)' };
        const d = await this.digestContent();
        const org = this.cfg.orgDomains[0] || 'localhost';
        const from = `"S.P.R.U.C.E Mail Protection Service" <${this.cfg.directoryAdmin || `no-reply@${org}`}>`;
        const out = { sent: 0, to, failed: [] };
        for (const user of to) {
            try {
                const raw = mime({ from, to: user, subject: d.subject, text: d.text, date: new Date(this.now()), messageId: `<spruce-summary-${this.now()}-${crypto.randomBytes(6).toString('hex')}@${org}>` });
                const r = await this.gmail.insert(user, raw, ['INBOX', 'UNREAD']);
                if (r && r.id) await this.store.markSeen(user, r.id);   // (and isSummary) never judged
                out.sent++;
            } catch (e) { out.failed.push(user); this.log.error(`weekly summary to ${user}:`, e); }
        }
        const st = (await this.store.getState('digest')) || {};
        await this.store.setState('digest', Object.assign({}, st, { lastSentAt: this.now(), lastSentBy: by }));
        await this.store.addEvent({ kind: 'digest', text: `The weekly summary was put in ${out.sent} admin Inbox${out.sent === 1 ? '' : 'es'}${by ? ` (sent now by ${by})` : ''}${out.failed.length ? `; ${out.failed.length} couldn't be reached` : ''}.` });
        return out;
    }
    // From the hourly job: on Monday from 7 AM (TIME_ZONE), once a week, when it is on.
    async maybeDigest() {
        const st = (await this.store.getState('digest')) || {};
        if (!st.enabled) return null;
        const t = localParts(this.now(), this.cfg.timeZone);
        if (t.weekday !== 1 || t.hour < 7) return null;
        if (!(await this.store.setStateIfUnset(`digest-${t.week}`, { at: this.now() }))) return null;   // once, whichever instance
        return this.sendDigest();
    }
    async setDigest(enabled, by) {
        const st = (await this.store.getState('digest')) || {};
        await this.store.setState('digest', Object.assign({}, st, { enabled: !!enabled, updatedBy: by, updatedAt: this.now() }));
        await this.store.addEvent({ kind: 'settings', text: `${by} turned the weekly summary email ${enabled ? 'on' : 'off'}.` });
        return { enabled: !!enabled };
    }

    // --- The retraining export (Status → Model health; off until an admin allows it in Settings) ------
    // The emails an admin marked (confirmed phishing; with falseAlarms, false alarms too), one per
    // campaign, newest first, read from Gmail now and turned into the extension's training format with
    // the people taken out (src/training.js). Nothing of them is stored: the rows are only returned.
    // Judged again as on arrival (same lookups) for the facts the model read; nothing is counted.
    async trainingExport({ days = 90, falseAlarms = false, by = '', max = 100, budgetMs = 150000 } = {}) {
        const st = (await this.store.getState('trainingExport')) || {};
        if (!st.enabled) return { error: 'off' };
        const records = await this.store.listRecords({ sinceMs: this.now() - days * DAY, limit: 100000 });
        const { groups, conflicting } = training.pickRecords(records, { falseAlarms });
        const rows = [], counts = { phishing: 0, genuine: 0, gone: 0, failed: 0, notReached: 0, notEnglish: 0, conflicting, candidates: groups.length };
        const started = Date.now();
        let reached = 0;
        // The newest copy still in a mailbox (up to 3 tried): a copy deleted since doesn't lose the campaign.
        const readOne = async (copies) => {
            for (const rec of copies.slice(0, 3)) {
                let msg;
                try { msg = await this.gmail.raw(rec.user, rec.messageId); }
                catch (e) { if (e && e.status === 404) continue; throw e; }
                if (msg && msg.raw && msg.raw.length && !isSummary(msg.raw)) return { rec, msg };
            }
            return null;
        };
        await pool(groups, 4, async (copies) => {
            reached++;
            try {
                const got = await readOne(copies);
                if (!got) { counts.gone++; return; }
                const { rec, msg } = got;
                const facts = await readMessage(msg.raw);
                const allowlisted = isAllowed(this.cfg, facts.senderAddress), verified = senderVerified(facts);
                const result = await analyze(facts, { mailbox: rec.user, orgDomains: this.cfg.orgDomains, trusted: allowlisted && verified, firstTime: false, intel: this.intel, keepAiFacts: true });
                // The model learns English only (an email clearly in another language is left out, and counted).
                if (!result.language.english) { counts.notEnglish++; return; }
                const label = rec.falseAlarm === false ? 1 : 0;
                rows.push({ at: rec.processedAt, row: training.example(rec, label, result.aiFacts, facts.people, this.cfg.orgDomains) });
            } catch (e) { counts.failed++; this.log.error(`retraining export ${copies[0].key}:`, e); }
        }, () => rows.length >= max || Date.now() - started > budgetMs);
        counts.notReached = groups.length - reached;
        const out = rows.sort((a, b) => b.at - a.at).slice(0, max).map(x => x.row);
        counts.phishing = out.filter(r => r.label === 1).length; counts.genuine = out.length - counts.phishing;
        await this.store.addEvent({ kind: 'training', text: `${by} downloaded the retraining export: ${out.length} example${out.length === 1 ? '' : 's'} (${counts.phishing} phishing${falseAlarms ? `, ${counts.genuine} false alarm${counts.genuine === 1 ? '' : 's'}` : ''}) from the last ${days} days${counts.gone ? `; ${counts.gone} no longer in a mailbox` : ''}. Nothing of them was stored.` });
        return { rows: out, counts, days, falseAlarms };
    }
    async setTrainingExport(enabled, by) {
        const st = (await this.store.getState('trainingExport')) || {};
        await this.store.setState('trainingExport', Object.assign({}, st, { enabled: !!enabled, updatedBy: by, updatedAt: this.now() }));
        await this.store.addEvent({ kind: 'settings', text: `${by} ${enabled ? 'allowed' : 'turned off'} the retraining export (Status → Model health: Download for retraining).` });
        return { enabled: !!enabled };
    }

    // --- Several emails at once (Messages, and the review queue) -------------------------------------
    // action: release | false-alarm | phishing. { done, skipped, failed }.
    // Several at once. Phishing works as for one email: those still in the Inbox are moved to Spam too
    // (enforce mode); moved says how many.
    async bulk(keys, action, by) {
        const out = { done: 0, skipped: 0, failed: 0 };
        if (action === 'phishing') out.moved = 0;
        await pool(keys, 10, async (key) => {
            try {
                const r = action === 'release' ? await this.release(key, by, { quiet: true }) : await this.mark(key, action === 'false-alarm', by, { move: action === 'phishing', quiet: true });
                if (r && r.record) out.done++; else out.skipped++;
                if (r && r.moved === 'moved') out.moved++;
            } catch (e) { out.failed++; this.log.error(`bulk ${action} ${key}:`, e); }
        });
        const what = { release: 'moved back to the Inbox', 'false-alarm': 'marked as false alarms', phishing: 'confirmed as phishing' }[action];
        if (out.done) await this.store.addEvent({ kind: action === 'release' ? 'release' : 'mark', text: `${by} ${what} ${out.done} email${out.done === 1 ? '' : 's'} at once${out.moved ? ` (${out.moved} moved to Spam)` : ''}.` });
        return out;
    }

    // Whether the service is getting Gmail's notifications at all, and its watches are renewed. Each
    // problem is alerted once a day: no notification for QUIET_HOURS for any watched mailbox (they may be
    // refused before reaching the service), or watches ending within a day (the daily re-read failing).
    // (Counted, not read: three small queries, not 10,000 documents an hour.)
    async health() {
        const now = this.now();
        const sum = await this.store.mailboxSummary(now + DAY);
        const out = { watched: sum.watched };
        if (!sum.watched) return out;
        const once = async (name, kind, text) => {
            if (now - (Number(await this.store.getState(name)) || 0) < DAY) return;
            await this.store.setState(name, now);
            await this.alert(kind, text);
        };
        const last = sum.lastNotification || 0;
        const since = last || Number(await this.store.getState('installedAt')) || now;
        out.lastNotification = last || null;
        if (now - since > this.cfg.quietHours * HOUR) {
            out.quiet = true;
            await once('quietAlertAt', 'quiet', `No notification from Gmail for ${Math.round((now - since) / HOUR)} hours, for any of the ${sum.watched} watched mailboxes. Gmail's notifications may be refused before they reach the service: docs/INSTALL.md, Troubleshooting, "The jobs and notifications are refused".`);
        }
        // Many errors in the last hour (0.5.29): something stopped working (Firestore, Gmail, the model…).
        try {
            const errs = (await this.store.listEvents(now - HOUR)).filter(e => e.kind === 'error').length;
            out.errorsLastHour = errs;
            if (errs >= ERRORS_ALERT) await this.alertDaily('errors', `${errs} errors in the last hour: something may have stopped working. Status → Activity → Errors and gaps says what failed; Status → Service status, and bash deploy/doctor.sh, check the rest.`);
        } catch (e) { /* the next hour */ }
        out.expiring = sum.ending;
        if (out.expiring) await once('expiringAlertAt', 'watch-expiring', `${out.expiring} mailbox watches end within a day and weren't renewed: the daily re-read of the group (spruce-renew-watches) may be failing. Settings → Mailboxes says when it last reached the service.`);
        return out;
    }
}

module.exports = { Service, campaignOf, senderHash, recordKey, dayOf, POLICY_KEYS, policyValue, STAT_FLUSH_MS, Slots, EMAIL_SLOTS, LARGE_SLOTS };
