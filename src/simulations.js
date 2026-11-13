'use strict';
// Phishing-training emails (0.5.44; Settings → Phishing training; off until an admin adds a rule). Training
// emails from KnowBe4, Wizer and similar services are let through: not checked, not moved, not recorded (only
// counted), so a training campaign measures whether people spot phishing without help, and no lookup of the
// service's can be taken by the vendor for a "click". The same design as the S.P.R.U.C.E+ extension's
// managedPhishSimulationRules and managedPhishSimulationDomains (its docs/ADMIN-GUIDE.md), as the service's
// own code. An email is a training email when it matches either:
//   - a header rule: the vendor's header is present, and its value is the admin's secret token (kept only as a
//     one-way hash) and/or Gmail received the email from one of the vendor's sending addresses (the hop written
//     by Gmail's own server, mx.google.com: lower Received lines can be forged by a sender). A header name alone
//     is public, so a real phishing email could copy it: such a rule is refused;
//   - the vendor's link domains: the email has links and EVERY link (after the engine's offline unwrapping)
//     goes to one of them. One link anywhere else and it is checked as usual. Domains anyone can host pages on
//     (shared platforms, link shorteners, well-known companies', personal mail) are refused.
const crypto = require('crypto');

const MAX_RULES = 20, MAX_DOMAINS = 500, MAX_IPS = 100;
const HEADER_RE = /^[A-Za-z0-9-]{1,100}$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Domains anyone can host pages or links on: never a training domain (the extension's list).
const SHARED_PLATFORM_SUFFIXES = ['amazonaws.com', 'cloudfront.net', 'windows.net', 'azurewebsites.net', 'azureedge.net',
    'googleapis.com', 'googleusercontent.com', 'appspot.com', 'web.app', 'firebaseapp.com', 'pages.dev', 'workers.dev', 'r2.dev',
    'github.io', 'githubusercontent.com', 'gitlab.io', 'netlify.app', 'vercel.app', 'herokuapp.com', 'onrender.com', 'glitch.me',
    'surge.sh', 'wixsite.com', 'weebly.com', 'godaddysites.com', 'squarespace.com', 'wordpress.com', 'blogspot.com', 'webflow.io',
    'dropbox.com', 'box.com', 'notion.site', 'canva.site', 'ipfs.io', 'dweb.link', 'mailchimp.com', 'list-manage.com',
    'sendgrid.net', 'hubspot.com', 'hs-sites.com', 'typeform.com', 'jotform.com', 'surveymonkey.com', 'formstack.com',
    '000webhostapp.com', 'linktr.ee', 'docusign.net', 'adobe.com', 'google.com', 'sharepoint.com', 'microsoft.com', 'live.com'];
// What the page offers to start from (the vendor's documented header; its secret or addresses are the admin's).
const PRESETS = [
    { id: 'knowbe4-token', name: 'KnowBe4 (PST header token)', header: 'X-KB4TOKEN', needs: 'value', help: 'KSAT → Account Settings → Phishing → Enable PST Header Token: paste the token.' },
    { id: 'knowbe4-ips', name: 'KnowBe4 (X-PHISHTEST and sending addresses)', header: 'X-PHISHTEST', needs: 'ips', help: 'KnowBe4\'s Whitelisting Guide lists its sending addresses (not with Direct Message Injection: use the token).' },
    { id: 'wizer', name: 'Wizer (X-TestPhish and sending addresses)', header: 'X-TestPhish', needs: 'ips', help: 'Wizer\'s "IPs and domains" page lists its sending addresses (not with Direct Email Delivery: use its domains).' },
    { id: 'custom', name: 'Another vendor, or a custom header', header: '', needs: 'value or ips', help: 'Your vendor\'s Google Workspace allow-listing guide names its header; use a secret value if it offers one.' }
];

const hashValue = (header, value) => crypto.createHash('sha256').update(`spruce-training|${String(header).toLowerCase()}|${String(value).trim()}`).digest('hex');

// --- Addresses ----------------------------------------------------------------------------------------
const IP_V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function ipToBig(ip) {
    const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    const v4 = IP_V4_RE.exec(s.replace(/^::ffff:/, ''));
    if (v4) {
        const parts = v4.slice(1).map(Number);
        if (parts.some(p => p > 255)) return null;
        return { v: 4, n: parts.reduce((a, p) => (a << 8n) + BigInt(p), 0n) };
    }
    if (!/^[0-9a-f:]+$/.test(s) || !s.includes(':')) return null;
    const [head, tail] = s.split('::');
    if (s.split('::').length > 2) return null;
    const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
    const missing = 8 - h.length - t.length;
    if (missing < 0 || (tail === undefined && missing !== 0)) return null;
    const groups = [...h, ...Array(tail === undefined ? 0 : missing).fill('0'), ...t];
    if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g, 16)), 0n) };
}
// "147.160.167.0/26", "23.21.109.197", "2a02:2c8:1:400::29" or an IPv6 range.
function validIpEntry(entry) {
    const [addr, bits] = String(entry).trim().split('/');
    const a = ipToBig(addr);
    if (!a) return false;
    if (bits === undefined) return true;
    const n = Number(bits);
    return Number.isInteger(n) && n >= (a.v === 4 ? 8 : 16) && n <= (a.v === 4 ? 32 : 128);
}
function ipInList(ip, list) {
    const a = ipToBig(ip);
    if (!a) return false;
    for (const entry of list || []) {
        const [addr, bitsText] = String(entry).trim().split('/');
        const b = ipToBig(addr);
        if (!b || b.v !== a.v) continue;
        const width = a.v === 4 ? 32 : 128;
        const bits = bitsText === undefined ? width : Number(bitsText);
        if (!Number.isInteger(bits) || bits < 0 || bits > width) continue;
        const shift = BigInt(width - bits);
        if ((a.n >> shift) === (b.n >> shift)) return true;
    }
    return false;
}
// The address Gmail's own server (mx.google.com) received the email from: the topmost Received line it wrote.
// Lower lines could have been written by the sender. Null when the email was put in the mailbox directly (a
// vendor's direct injection) or no such line is there.
function deliveringIp(headers) {
    for (const [n, v] of headers) {
        if (n !== 'received') continue;
        if (!/\bby mx\.google\.com\b/i.test(v)) continue;
        const from = v.split(/\bby mx\.google\.com\b/i)[0];
        const m = /\[([0-9a-f:.]+)\]/i.exec(from);
        return m ? m[1] : null;
    }
    return null;
}

// --- The admin's settings -------------------------------------------------------------------------------
// Why a domain can't be a training domain, or null.
function refusedDomain(E, d) {
    const reg = (() => { try { return E.registrableDomain(d) || d; } catch (e) { return d; } })();
    if (E.isPersonalMailDomain(d)) return 'a personal email provider';
    if (E.PROTECTED_DOMAINS.has(reg) || (E.brandOfDomain && (E.brandOfDomain(reg) || E.brandOfDomain(d))) || (E.companyNameOf && E.companyNameOf(reg))) return 'a well-known company\'s domain, where anyone can host content';
    if (E.publicShorteners && (E.publicShorteners.includes(d) || E.publicShorteners.includes(reg))) return 'a public link shortener';
    if (SHARED_PLATFORM_SUFFIXES.some(s => d === s || d.endsWith(`.${s}`))) return 'a shared hosting or sending platform';
    return null;
}
// A rule as the admin typed it → the rule kept ({ id, name, header, valueHash, ips }), or { error }.
function ruleFrom(input) {
    const name = String(input.name || input.header || '').trim().slice(0, 60);
    const header = String(input.header || '').trim();
    if (!HEADER_RE.test(header)) return { error: 'The header is the vendor\'s header name: letters, digits and "-" only (for example X-KB4TOKEN).' };
    const value = typeof input.value === 'string' ? input.value.trim() : '';
    if (value.length > 500) return { error: 'The secret value is at most 500 characters.' };
    const ips = String(Array.isArray(input.ips) ? input.ips.join('\n') : input.ips || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    const bad = ips.find(x => !validIpEntry(x));
    if (bad) return { error: `"${bad.slice(0, 60)}" isn't an address or range (192.0.2.10, 192.0.2.0/24, 2001:db8::/32).` };
    if (ips.length > MAX_IPS) return { error: `At most ${MAX_IPS} sending addresses a rule.` };
    if (!value && !ips.length) return { error: 'A header name alone is public: a real phishing email could copy it. Add the vendor\'s secret token (or your own custom header\'s value), or the vendor\'s sending addresses.' };
    return { rule: { id: crypto.randomBytes(6).toString('hex'), name: name || header, header: header.toLowerCase(), headerShown: header, valueHash: value ? hashValue(header, value) : null, ips } };
}
// The domains as typed → { domains, refused: [{ domain, why }], invalid: [] }.
function domainsFrom(E, text) {
    const list = [...new Set(String(Array.isArray(text) ? text.join('\n') : text || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
    const domains = [], refused = [], invalid = [];
    for (const d of list) {
        if (!DOMAIN_RE.test(d)) { invalid.push(d); continue; }
        const why = refusedDomain(E, d);
        if (why) refused.push({ domain: d, why }); else domains.push(d);
    }
    return { domains: domains.slice(0, MAX_DOMAINS), refused, invalid };
}

// --- Matching ---------------------------------------------------------------------------------------------
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
// The rule or domain an email matches ({ name, by: 'header' | 'links' }), or null. settings: state/phishTraining.
async function matchTraining(E, facts, settings) {
    if (!settings || (!(settings.rules || []).length && !(settings.domains || []).length)) return null;
    if ((settings.rules || []).length) {
        let headers = [];
        try { headers = E.parseRawHeaders(facts.rawForHeaders || ''); } catch (e) { headers = []; }
        let ip;
        for (const rule of settings.rules) {
            const values = headers.filter(([n]) => n === rule.header).map(([, v]) => String(v));
            if (!values.length) continue;
            if (rule.valueHash && !values.some(v => [v, ...v.split(/[\s;,]+/)].some(x => x && hashValue(rule.header, x) === rule.valueHash))) continue;
            if ((rule.ips || []).length) {
                if (ip === undefined) ip = deliveringIp(headers);
                if (!ip || !ipInList(ip, rule.ips)) continue;
            }
            return { name: rule.name, by: 'header' };
        }
    }
    const domains = settings.domains || [];
    if (domains.length) {
        const raw = (facts.links || []).map(l => (l && (l.href || l.url)) || '').filter(u => /^https?:\/\//i.test(u)).slice(0, 100);
        if (!raw.length) return null;
        // (security gateways' rewrites unwrapped offline first: the real destination counts)
        const web = await Promise.all(raw.map(async u => { try { return ((await E.unwrapNestedUrl(u, false, { redirectorSet: new Set() })) || {}).unwrappedUrl || u; } catch (e) { return u; } }));
        let first = null;
        for (const u of web) {
            const host = hostOf(u);
            const d = host && domains.find(x => host === x || host.endsWith(`.${x}`));
            if (!d) return null;
            first = first || d;
        }
        return { name: `links to ${first}`, by: 'links' };
    }
    return null;
}

module.exports = { matchTraining, ruleFrom, domainsFrom, refusedDomain, deliveringIp, ipInList, validIpEntry, hashValue, PRESETS, MAX_RULES, MAX_DOMAINS };
