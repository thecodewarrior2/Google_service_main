'use strict';
// Spamhaus's free Data Query Service (0.5.37; optional, off by default: Settings → Spamhaus). For each email,
// its sender's domain and its link sites (full host names: Spamhaus lists some abused sites by host name), at
// most 6 an email, never the organization's own or the big brands', are looked up with the admin's DQS key
// (a 26-character code) in two of Spamhaus's DNS zones (docs.spamhaus.com, "DQS queries"):
//   - DBL, the Domain Blocklist: <name>.<key>.dbl.dq.spamhaus.net answers 127.0.1.x when listed. Spamhaus's
//     advice: block on the codes under 100 (phishing, malware, botnet control; low reputation), only score
//     those from 100 (a legitimate site being abused);
//   - ZRD, Zero Reputation Domains: <name>.<key>.zrd.dq.spamhaus.net answers 127.0.2.2–127.0.2.24, the
//     hours since Spamhaus first saw the domain, in its first 24 hours: a score, never a block.
// Not listed: no such name (NXDOMAIN). 127.255.255.x is an error (the key disabled or misused, a mistyped
// zone). Only the names are sent, with the key, through the service's own DNS resolver (Cloud Run's): Spamhaus
// allows DQS through shared resolvers, but recommends a dedicated one, as shared ones can be rate-limited; a
// lookup that fails is "not checked", never "clean".
//
// Fair use of a free account (non-commercial small organizations): at most 100,000 lookups a day, consistently.
// The service stops at SPAMHAUS_DAILY_MAX (90,000 by default) for the day, counted for every instance together
// (each name costs 2: DBL and ZRD), and asks each name at most once an hour (a campaign's copies share it).
const dns = require('dns');
const { TtlCache } = require('./http');

const KEY_RE = /^[a-z0-9]{20,40}$/i;   // (Spamhaus's are 26 characters)
const ZONES = { dbl: 'dbl.dq.spamhaus.net', zrd: 'zrd.dq.spamhaus.net' };
const TTL_MS = 60 * 60 * 1000;
const PER_EMAIL = 6;
const QUOTA_READ_MS = 5 * 60 * 1000;
const DBL = {
    '127.0.1.2': { list: 'low reputation', severity: 'spam' }, '127.0.1.4': { list: 'phishing', severity: 'danger' }, '127.0.1.5': { list: 'malware', severity: 'danger' },
    '127.0.1.6': { list: 'botnet control', severity: 'danger' }, '127.0.1.102': { list: 'a legitimate site abused', severity: 'abused' },
    '127.0.1.103': { list: 'an abused redirector', severity: 'abused' }, '127.0.1.104': { list: 'a legitimate site abused for phishing', severity: 'abused' },
    '127.0.1.105': { list: 'a legitimate site abused for malware', severity: 'abused' }, '127.0.1.106': { list: 'a legitimate site abused to host botnet control', severity: 'abused' }
};
// Spamhaus's error answers: the query wasn't accepted (no listing can be read from it).
const ERRORS = { '127.255.255.250': 'the DQS key is disabled', '127.255.255.251': 'the DQS key is being used in a way its terms don\'t allow', '127.255.255.252': 'a mistyped zone name',
    '127.0.1.255': 'a query of an IP address', '127.0.2.255': 'a query of an IP address' };
const errorOf = (ip) => ERRORS[ip] || (/^127\.255\.255\.\d+$/.test(ip) ? `an error from Spamhaus (${ip})` : null);
const TEST_DOMAIN = 'dbltest.com';   // Spamhaus's own test entry: always listed in the DBL

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// resolver: { resolve4(name) } (dns.promises' by default; the tests and the demo pass their own).
function createSpamhaus({ cfg, store, resolver = undefined, now = () => Date.now(), log = console }) {
    const r = resolver || new dns.promises.Resolver({ timeout: 3000, tries: 2 });
    const cache = new TtlCache(20000);
    let key = null, count = { day: '', n: 0, flushed: 0, total: 0, readAt: 0 };
    async function ask(name) {
        try { return { ips: await r.resolve4(name) }; }
        catch (e) { if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return { ips: [] }; return { error: String((e && e.code) || e).slice(0, 60) }; }
    }
    // The day's lookups, for every instance: this one's, added to the store every 100, and the others' read
    // every 5 minutes.
    async function counted(n) {
        const day = dayOf(now());
        if (count.day !== day) count = { day, n: 0, flushed: 0, total: 0, readAt: 0 };
        count.n += n;
        if (count.n - count.flushed >= 100) { const add = count.n - count.flushed; count.flushed = count.n; await store.incStats(`spamhaus-${day}`, { spamhausQueries: add }).catch(() => {}); }
        if (now() - count.readAt >= QUOTA_READ_MS) {
            count.readAt = now();
            try { const s = await store.getStats(`spamhaus-${day}`, `spamhaus-${day}`); count.total = (s[0] && s[0].spamhausQueries) || 0; } catch (e) { /* the last total */ }
        }
    }
    const usedToday = () => Math.max(count.total + (count.n - count.flushed), count.n);
    async function quota() {
        const day = dayOf(now());
        let total = 0;
        try { const s = await store.getStats(`spamhaus-${day}`, `spamhaus-${day}`); total = (s[0] && s[0].spamhausQueries) || 0; } catch (e) { /* none */ }
        const today = Math.max(total, count.day === day ? usedToday() : 0);
        return { today, max: cfg.spamhausDailyMax, stopped: today >= cfg.spamhausDailyMax };
    }
    // One domain: { dbl: { list, severity, abused } | null, zrdHours: n | null } or { error }.
    async function lookup(domain, k) {
        const hit = cache.get(domain);
        if (hit) return hit;
        const [d, z] = await Promise.all([ask(`${domain}.${k}.${ZONES.dbl}`), ask(`${domain}.${k}.${ZONES.zrd}`)]);
        await counted(2);
        const err = [...(d.ips || []), ...(z.ips || [])].map(errorOf).find(Boolean);
        if (err) return { error: err };
        if (d.error && z.error) return { error: d.error };
        // (every answer read: the strongest listing counts)
        const order = { danger: 0, spam: 1, abused: 2 };
        const dbl = (d.ips || []).map(ip => DBL[ip]).filter(Boolean).sort((a, b) => order[a.severity] - order[b.severity])[0] || null;
        const zip = (z.ips || []).find(ip => /^127\.0\.2\.\d+$/.test(ip));
        const out = { dbl, zrdHours: zip ? Number(zip.split('.')[3]) : null };
        if (!d.error && !z.error) cache.set(domain, out, TTL_MS);
        return out;
    }
    // Every domain at once: Map domain → result; nothing when off, without a key, or past the day's limit.
    async function checkDomains(domains) {
        const out = new Map();
        if (!cfg.spamhaus || !key) return out;
        const k = await key.get().catch(() => null);
        if (!k) return out;
        const list = [...new Set(domains.filter(Boolean))].slice(0, PER_EMAIL);
        if (usedToday() + list.length * 2 > cfg.spamhausDailyMax) return out;
        const results = await Promise.all(list.map(d => lookup(d, k)));
        let problem = null;
        list.forEach((d, i) => { if (results[i].error) problem = results[i].error; else out.set(d, results[i]); });
        if (problem && /key|zone name|IP address|error from Spamhaus/.test(problem)) await key.noteResult(false, problem, { alertText: `Spamhaus didn't accept the service's lookups (${problem}): domains aren't looked up with Spamhaus meanwhile (the other checks still run). Settings → Spamhaus says more. More: docs/ALERTS.md, "Spamhaus or abuse.ch refused the key".` });
        else if (list.length && out.size) await key.noteResult(true, null);
        return out;
    }
    // A key tried with Spamhaus: its test entry must be listed in the DBL.
    async function testKey(k) {
        const a = await ask(`${TEST_DOMAIN}.${k}.${ZONES.dbl}`);
        if (a.error) return { ok: false, why: `Spamhaus couldn't be asked (${a.error}).`, fix: 'Try again in a minute.' };
        const ip = (a.ips || [])[0];
        if (ip && errorOf(ip)) return { ok: false, why: `Spamhaus answered with an error: ${errorOf(ip)}.`, fix: 'Check the key in Spamhaus\'s portal (docs/INSTALL.md, "Spamhaus").' };
        if (!ip) return { ok: false, why: 'Spamhaus doesn\'t know this key (its test entry isn\'t found with it).', fix: 'Copy the DQS key again from Spamhaus\'s portal; a new account can take a little while to be activated.' };
        return { ok: true };
    }
    return { checkDomains, testKey, quota, setKey(k) { key = k; }, lookup };
}

module.exports = { createSpamhaus, KEY_RE, ZONES, DBL, ERRORS, errorOf, TEST_DOMAIN };
