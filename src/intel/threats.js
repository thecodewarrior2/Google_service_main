'use strict';
// Threat lookups for link hosts, link addresses and sender domains.
//
// Cloudflare Security DNS (security.cloudflare-dns.com, DNS over HTTPS): only the HOST NAME is sent.
//   Cloudflare answers a malware or phishing name with 0.0.0.0. A name its filter says doesn't exist
//   (NXDOMAIN) is asked again of Cloudflare's unfiltered resolver (cloudflare-dns.com): if that one
//   resolves it, the filter blocked it; if not, the name really doesn't exist.
// Google Safe Browsing (Lookup API v4, threatMatches:find): the LINK ADDRESS is sent, up to 500 per
//   request, with the part after "#" always removed and, for one-time links (password resets, sign-in
//   and unsubscribe links; the extension's isSingleUseToken), the query string removed too, so tokens
//   never leave the district. Needs an API key: saved on Settings → Safe Browsing (Secret Manager,
//   src/intel/sbkey.js), else SAFE_BROWSING_KEY; turned on and off there (0.5.23: cfg.safeBrowsing is a
//   policy setting, read at each lookup). The key goes in a header, never in the address.
// Answers are remembered (TTL) so a campaign's 40 copies cost one lookup. A lookup that fails is
// "unknown", never "safe".
const { TtlCache } = require('./http');

const SINKHOLE_RE = /^(0\.0\.0\.0|127\.|::$|::1$|0:0:0:0:0:0:0:0)/;
const CF_SECURITY = 'https://security.cloudflare-dns.com/dns-query';
const CF_REFERENCE = 'https://cloudflare-dns.com/dns-query';
const SB_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const SB_TYPES = { MALWARE: 'malware', SOCIAL_ENGINEERING: 'phishing or a deceptive site', UNWANTED_SOFTWARE: 'unwanted software', POTENTIALLY_HARMFUL_APPLICATION: 'a harmful app' };
const CLEAN_TTL = 6 * 60 * 60 * 1000, BAD_TTL = 24 * 60 * 60 * 1000;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

// sbKey: src/intel/sbkey.js (the key in use, and where each lookup's outcome is noted); without it, the
// environment's cfg.safeBrowsingKey.
function createThreats({ http, cfg, engine, version = '0', sbKey = null }) {
    const hostCache = new TtlCache(), urlCache = new TtlCache();
    const useCf = cfg.cloudflareThreats !== false;
    // On: the setting (dashboard or SAFE_BROWSING), read at each lookup; and a key (a saved one is read then).
    const sbOn = () => cfg.safeBrowsing !== false && (sbKey ? !!cfg.safeBrowsing : !!cfg.safeBrowsingKey);
    const keyNow = async () => (sbKey ? sbKey.get() : cfg.safeBrowsingKey || null);

    async function doh(base, host) {
        const res = await http.request(`${base}?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: 'application/dns-json' } }, 5000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
    async function cloudflare(host) {
        const sec = await doh(CF_SECURITY, host);
        const ips = (sec.Answer || []).filter(a => a.type === 1 || a.type === 28).map(a => String(a.data || ''));
        if (sec.Status === 0) {
            if (ips.some(ip => SINKHOLE_RE.test(ip))) return { verdict: 'unsafe', by: 'Cloudflare Security', reason: 'Cloudflare Security blocks it as malware or phishing' };
            return { verdict: ips.length ? 'clean' : 'unknown', by: 'Cloudflare Security' };
        }
        if (sec.Status === 3) {
            const ref = await doh(CF_REFERENCE, host);
            if (ref.Status === 0 && (ref.Answer || []).length) return { verdict: 'unsafe', by: 'Cloudflare Security', reason: 'Cloudflare Security blocks it as malware or phishing' };
            if (ref.Status === 3) return { verdict: 'nonexistent', by: 'Cloudflare', reason: 'the site does not exist' };
        }
        return { verdict: 'unknown', by: 'Cloudflare Security' };
    }
    // hosts → Map(host → { verdict: 'unsafe'|'clean'|'nonexistent'|'unknown', by, reason })
    async function checkHosts(hosts) {
        const out = new Map();
        const list = [...new Set(hosts.map(h => String(h || '').toLowerCase().replace(/\.$/, '')).filter(h => HOST_RE.test(h)))].slice(0, 50);
        if (!useCf) { for (const h of list) out.set(h, { verdict: 'unknown', by: 'none', reason: 'DNS threat checks are off' }); return out; }
        await Promise.all(list.map(async (h) => {
            const hit = hostCache.get(h);
            if (hit) { out.set(h, hit); return; }
            try {
                const r = await cloudflare(h);
                if (r.verdict !== 'unknown') hostCache.set(h, r, r.verdict === 'unsafe' ? BAD_TTL : CLEAN_TTL);
                out.set(h, r);
            } catch (e) { out.set(h, { verdict: 'unknown', by: 'Cloudflare Security', reason: `not checked (${e.name === 'ServiceBusyError' ? 'service busy' : 'lookup failed'})` }); }
        }));
        return out;
    }

    // What is sent to Safe Browsing for a link: no fragment, and no query for one-time links.
    function forLookup(url, text = '') {
        let u;
        try { u = new URL(url); } catch (e) { return null; }
        if (!/^https?:$/.test(u.protocol)) return null;
        u.hash = '';
        let oneTime = false;
        try { oneTime = engine.isSingleUseToken(url, text); } catch (e) { oneTime = false; }
        if (oneTime) u.search = '';
        return u.href;
    }
    // links: [{ url, text }] → Map(url → { verdict: 'unsafe'|'clean'|'unknown', by, reason })
    async function checkUrls(links) {
        const out = new Map();
        const sent = new Map();                                   // address sent → original urls
        const key = sbOn() ? await keyNow() : null;
        for (const l of links.slice(0, 500)) {
            const s = forLookup(l.url, l.text);
            if (!s) continue;
            if (!sbOn()) { out.set(l.url, { verdict: 'unknown', by: 'none', reason: 'Safe Browsing is off' }); continue; }
            if (!key) { out.set(l.url, { verdict: 'unknown', by: 'Google Safe Browsing', reason: 'not checked (Safe Browsing is on, but no API key is saved)' }); continue; }
            const hit = urlCache.get(s);
            if (hit) { out.set(l.url, hit); continue; }
            if (!sent.has(s)) sent.set(s, []);
            sent.get(s).push(l.url);
        }
        if (!sent.size) return out;
        const body = { client: { clientId: 'spruce-mail-protection', clientVersion: version },
            threatInfo: { threatTypes: Object.keys(SB_TYPES), platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: [...sent.keys()].map(url => ({ url })) } };
        try {
            const res = await http.request(SB_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, 6000);
            if (!res.ok) {
                let why = '';
                try { why = String((((await res.json()) || {}).error || {}).message || ''); } catch (e) { /* not JSON */ }
                throw Object.assign(new Error(`HTTP ${res.status}${why ? `: ${why.slice(0, 120)}` : ''}`), { sbAnswered: true });
            }
            const data = await res.json();
            const bad = new Map();
            for (const m of data.matches || []) if (m.threat && m.threat.url) bad.set(m.threat.url, SB_TYPES[m.threatType] || String(m.threatType || 'a threat').toLowerCase());
            for (const [s, originals] of sent) {
                const r = bad.has(s) ? { verdict: 'unsafe', by: 'Google Safe Browsing', reason: `Google Safe Browsing lists it as ${bad.get(s)}` } : { verdict: 'clean', by: 'Google Safe Browsing' };
                urlCache.set(s, r, r.verdict === 'unsafe' ? BAD_TTL : 30 * 60 * 1000);
                for (const o of originals) out.set(o, r);
            }
            if (sbKey) await sbKey.noteResult(true, null);
        } catch (e) {
            for (const originals of sent.values()) for (const o of originals) out.set(o, { verdict: 'unknown', by: 'Google Safe Browsing', reason: `not checked (${e.name === 'ServiceBusyError' ? 'service busy' : 'lookup failed'})` });
            // Google refusing the key (revoked, restricted, quota) is worth telling the admins; a network blip isn't.
            if (sbKey && e.sbAnswered) await sbKey.noteResult(false, e.message);
        }
        return out;
    }
    return { checkHosts, checkUrls, forLookup, enabled: { cloudflare: useCf, get safeBrowsing() { return sbOn(); } } };
}

module.exports = { createThreats, SINKHOLE_RE };
