'use strict';
// The look-alike watch (0.5.36): domains made to pass for the organization's own, found when they are
// registered, before (or as soon as) they are used for payroll or vendor fraud.
//
// From ORG_DOMAINS, a fixed list of candidates is made (variantsOf): the domain's name with a letter left
// out, doubled, swapped or replaced by a look-alike (0/o, 1/l, rn/m, vv/w…), a hyphen taken out, under
// the usual endings (.com, .org, .net, .us…), and the forms people expect of a school district
// (hardee-k12.org, hardeeschools.com for hardee.k12.fl.us). Each hour the next ones are asked of
// Cloudflare's public DNS resolver (cloudflare-dns.com, DNS over HTTPS): does the name exist, does it
// have mail servers (MX), a website (A)? Only these candidate names are sent, nothing about any email.
// A full pass takes a few hours; then it starts again.
//
// The first pass only takes stock: what already exists is listed ("there before the watch"), with no
// alert, and counts as a small sign in mail. A name that appears afterwards, or one there before but
// registered in the last 30 days, is new: the admins are alerted, and mail from it, replies to it and
// links to it are strong signs. An admin can mark each one: the district's own, someone else's and
// harmless (no sign), or a threat (a strong sign) (Status → Look-alikes).
const ENDINGS = ['com', 'org', 'net', 'us', 'info', 'co'];
const HOMOGLYPHS = [['o', '0'], ['l', '1'], ['i', '1'], ['i', 'l'], ['l', 'i'], ['m', 'rn'], ['rn', 'm'], ['w', 'vv'], ['vv', 'w'], ['e', '3'], ['a', '4'], ['s', '5'], ['d', 'cl']];
// What a school district's look-alike usually adds to its name.
const DISTRICT_WORDS = ['k12', 'schools', 'school', 'sd', 'district', 'county', 'countyschools', 'edu'];
const ROLE_WORDS = ['mail', 'portal', 'hr', 'payroll', 'staff', 'login', 'secure'];
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NEW_DAYS = 30;
const PER_DOMAIN_MAX = 900;

// The registrable name's label and its ending (hardee.k12.fl.us → hardee, k12.fl.us; maple-schools.example
// → maple-schools, example).
function partsOf(E, domain) {
    const d = String(domain || '').toLowerCase().replace(/\.$/, '');
    let reg = d;
    try { reg = E.registrableDomain(d) || d; } catch (e) { reg = d; }
    const i = reg.indexOf('.');
    return i > 0 ? { reg, label: reg.slice(0, i), ending: reg.slice(i + 1) } : null;
}

// The name's typing and look-alike variants (each still a valid label, never the name itself).
function labelEdits(label) {
    const out = new Set();
    const add = (x) => { if (x !== label && x.length >= 2 && LABEL_RE.test(x)) out.add(x); };
    for (let i = 0; i < label.length; i++) {
        add(label.slice(0, i) + label.slice(i + 1));                                    // a letter left out
        if (/[a-z]/.test(label[i])) add(label.slice(0, i + 1) + label[i] + label.slice(i + 1));   // doubled
        if (i < label.length - 1 && label[i] !== label[i + 1]) add(label.slice(0, i) + label[i + 1] + label[i] + label.slice(i + 2));   // swapped
    }
    for (const [from, to] of HOMOGLYPHS) {
        let at = label.indexOf(from);
        while (at >= 0) { add(label.slice(0, at) + to + label.slice(at + from.length)); at = label.indexOf(from, at + 1); }
    }
    if (label.includes('-')) add(label.replace(/-/g, ''));
    return [...out];
}

// Every candidate for the organization's domains, in a fixed order (the most likely first).
function variantsOf(E, orgDomains) {
    const out = new Set(), own = new Set((orgDomains || []).map(d => String(d).toLowerCase()));
    const add = (label, ending) => { const d = `${label}.${ending}`; if (LABEL_RE.test(label) && !own.has(d)) out.add(d); };
    for (const domain of orgDomains || []) {
        const p = partsOf(E, domain);
        if (!p) continue;
        const start = out.size;
        const k12 = /^k12\.[a-z]{2}\.us$/.exec(p.ending);
        const state = k12 ? p.ending.split('.')[1] : '';
        const endings = [...new Set([...(k12 ? [] : [p.ending]), ...ENDINGS])];
        // The name itself under other endings.
        for (const e of endings) add(p.label, e);
        // The district's usual forms: name-k12.org, namek12fl.com, nameschools.org…
        for (const w of [...DISTRICT_WORDS, ...(state ? [`k12${state}`, `k12-${state}`] : [])]) {
            if (p.label.includes(w)) continue;
            for (const e of ENDINGS) { add(`${p.label}${w}`, e); add(`${p.label}-${w}`, e); }
        }
        // Typing and look-alike variants of the name.
        const edits = labelEdits(p.label);
        for (const x of edits) for (const e of endings) add(x, e);
        // The name with a role added (name-payroll.com, namehr.org).
        for (const w of ROLE_WORDS) for (const e of ['com', 'org', 'net']) { add(`${p.label}-${w}`, e); add(`${p.label}${w}`, e); }
        // (a bound per domain: the most likely come first)
        if (out.size - start > PER_DOMAIN_MAX) { const all = [...out]; out.clear(); all.slice(0, start + PER_DOMAIN_MAX).forEach(x => out.add(x)); }
    }
    return [...out];
}

// What Cloudflare's public resolver says of a name: exists (NOERROR, with or without records) or not
// (NXDOMAIN), its mail servers and website. A failed lookup: null (asked again next pass).
function createDnsCheck({ http, base = 'https://cloudflare-dns.com/dns-query' }) {
    async function ask(name, type) {
        const res = await http.request(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } }, 6000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
    return async function check(domain) {
        try {
            const ns = await ask(domain, 'NS');
            if (ns.Status === 3) return { exists: false };
            if (ns.Status !== 0) return null;
            const [mx, a] = await Promise.all([ask(domain, 'MX').catch(() => null), ask(domain, 'A').catch(() => null)]);
            const recs = (r, t) => ((r && r.Answer) || []).filter(x => x.type === t).map(x => String(x.data || ''));
            const mxs = recs(mx, 15).filter(x => !/^0 \.$/.test(x));   // ("0 ." is a null MX: no mail accepted)
            return { exists: true, mx: mxs.length > 0, web: recs(a, 1).length > 0 };
        } catch (e) { return null; }
    };
}

// How a found look-alike counts in mail: 'strong' (new, or marked a threat), 'weak' (there before the
// watch, not reviewed), or null (the district's own, or harmless; or gone).
function weightOf(entry) {
    if (!entry || entry.gone) return null;
    if (entry.status === 'new' || entry.status === 'threat') return 'strong';
    if (entry.status === 'baseline') return 'weak';
    return null;
}

module.exports = { variantsOf, labelEdits, partsOf, createDnsCheck, weightOf, NEW_DAYS, ENDINGS };
