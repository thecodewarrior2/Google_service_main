'use strict';
// How old a domain is, from its registry's public record (RDAP; the extension's domainRegistration).
// The registry for an ending comes from IANA's bootstrap list (data.iana.org/rdap/dns.json, kept a
// month). Only the DOMAIN NAME is sent, to its own registry. Answers are kept in the shared store for
// 30 days (an unknown one for a day), so each domain is asked about once a month for the whole district.
// An answer slower than WAIT_MS is "unknown": a slow registry never holds an email up.
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const KEEP_MS = 30 * 24 * 60 * 60 * 1000, UNKNOWN_KEEP_MS = 24 * 60 * 60 * 1000;
const WAIT_MS = 4000;
const DAY = 24 * 60 * 60 * 1000;

function createRdap({ http, store, engine, now = () => Date.now() }) {
    let bootstrap = null, bootstrapAt = 0;
    const flights = new Map();

    async function serverFor(tld) {
        if (!bootstrap || now() - bootstrapAt > KEEP_MS) {
            let map = await store.getCached('rdap', 'bootstrap');
            if (!map) {
                const res = await http.request(BOOTSTRAP_URL, {}, 10000);
                if (!res.ok) throw new Error(`IANA bootstrap: HTTP ${res.status}`);
                const data = await res.json();
                map = {};
                for (const [tlds, urls] of data.services || []) {
                    const https = (urls || []).find(u => /^https:\/\//.test(u));
                    if (https) for (const t of tlds) map[String(t).toLowerCase()] = https.endsWith('/') ? https : `${https}/`;
                }
                await store.setCached('rdap', 'bootstrap', map, KEEP_MS);
            }
            bootstrap = map; bootstrapAt = now();
        }
        return bootstrap[tld] || null;
    }

    async function lookup(reg) {
        const base = await serverFor(reg.split('.').pop());
        if (!base) return { created: null };
        const res = await http.request(`${base}domain/${encodeURIComponent(reg)}`, { headers: { accept: 'application/rdap+json' } }, WAIT_MS);
        if (!res.ok) return { created: null };
        const data = await res.json();
        const ev = (data.events || []).find(e => e && e.eventAction === 'registration' && e.eventDate);
        const t = ev ? Date.parse(ev.eventDate) : NaN;
        return { created: Number.isFinite(t) ? t : null };
    }

    // Age in days of a domain's registrable part, or null when unknown.
    async function ageDays(domain) {
        const reg = engine.registrableDomain(String(domain || '').toLowerCase());
        if (!reg || !engine.SENDER_DOMAIN_RE.test(reg)) return null;
        const hit = await store.getCached('age', reg).catch(() => null);
        let v = hit;
        if (!v) {
            if (!flights.has(reg)) {
                flights.set(reg, (async () => {
                    let timer;
                    const late = new Promise(r => { timer = setTimeout(() => r(null), WAIT_MS); });
                    let out;
                    try { out = await Promise.race([lookup(reg), late]); } catch (e) { out = null; } finally { clearTimeout(timer); }
                    if (out) await store.setCached('age', reg, out, out.created ? KEEP_MS : UNKNOWN_KEEP_MS).catch(() => {});
                    return out;
                })().finally(() => flights.delete(reg)));
            }
            v = await flights.get(reg);
        }
        return v && v.created ? Math.max(0, Math.floor((now() - v.created) / DAY)) : null;
    }
    return { ageDays };
}

module.exports = { createRdap };
