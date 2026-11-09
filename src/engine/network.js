'use strict';
// The checks that need the network (src/intel), applied to one email's links and sender:
//   - Cloudflare Security DNS: link hosts (where the link goes, and its own host) and the sender's domain;
//   - Google Safe Browsing, only when turned on (SAFE_BROWSING=true; off by default): the links (no "#…";
//     one-time links without their query);
//   - the phishing lists: link addresses and sites, the sender's domain and address. The organization's
//     own domains are matched by exact address only, never as a whole site or domain (as the
//     extension's senderDomainShared: one listing of a hacked school site must not flag all staff mail);
//   - registry dates: up to LINK_AGE_LOOKUPS unfamiliar link domains, and the sender's domain.
// A link any of them flags becomes "dangerous" (the extension's dangerous-links weight then counts
// it); the sender's findings and the site ages become signs of their own. A lookup that fails or
// is slow leaves things "not checked": nothing here ever makes an email look safer.
const LINK_AGE_LOOKUPS = 3;
const YOUNG_SENDER_DAYS = 30, LOOKALIKE_YOUNG_DAYS = 90;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

// judged: the links as analyze.judgeLinks made them (mutated: severity and reason of flagged links).
// Returns { signals: [...], checks: { … } } for the record.
async function networkChecks(E, intel, facts, judged, ctx) {
    const checks = { cloudflare: 0, safeBrowsing: 0, lists: false, ages: 0, notChecked: 0 };
    if (!intel) return { signals: [], checks: null };
    const org = (ctx.orgDomains || []).map(d => d.toLowerCase());
    const ours = (h) => org.some(d => h === d || h.endsWith('.' + d));
    const senderDomain = (facts.senderAddress.split('@')[1] || '').toLowerCase();
    const personal = senderDomain && E.isPersonalMailDomain(senderDomain);
    const web = judged.filter(j => !j.hidden && /^https?:\/\//i.test(j.url));
    const linkHosts = new Set();
    for (const j of web) for (const h of [hostOf(j.url), hostOf(j.finalUrl)]) if (h && !ours(h)) linkHosts.add(h);
    const hosts = [...linkHosts];
    if (senderDomain && !ours(senderDomain) && !personal) hosts.push(senderDomain);

    // Site ages: unfamiliar link domains (not a protected brand's, ours or a personal mail service),
    // the ones about signing in or paying first; and the sender's domain.
    const signInOf = new Map();
    for (const j of web) {
        const reg = E.registrableDomain(hostOf(j.finalUrl || j.url));
        if (!reg || ours(reg) || E.PROTECTED_DOMAINS.has(reg) || E.isPersonalMailDomain(reg)) continue;
        signInOf.set(reg, !!signInOf.get(reg) || E.SIGNIN_INTENT_RE.test(`${j.text || ''} ${j.finalUrl || j.url}`));
    }
    const ageDomains = [...signInOf.keys()].sort((a, b) => signInOf.get(b) - signInOf.get(a)).slice(0, LINK_AGE_LOOKUPS);
    const senderReg = senderDomain && !personal && !ours(senderDomain) ? E.registrableDomain(senderDomain) : '';
    const listHit = (u) => intel.feeds.urlHit(u, { exactOnly: ours(hostOf(u)) }).catch(() => null);

    const [hostResults, urlResults, ages, senderAge, senderOnList, senderDomainListed, linkListed] = await Promise.all([
        intel.threats ? intel.threats.checkHosts(hosts) : new Map(),
        intel.threats && (!intel.threats.enabled || intel.threats.enabled.safeBrowsing) ? intel.threats.checkUrls(web.map(j => ({ url: j.finalUrl && j.finalUrl !== j.url ? j.finalUrl : j.url, text: j.text })).concat(web.filter(j => j.finalUrl && j.finalUrl !== j.url).map(j => ({ url: j.url, text: j.text })))) : new Map(),
        intel.rdap ? Promise.all(ageDomains.map(async d => ({ domain: d, days: await intel.rdap.ageDays(d).catch(() => null), signIn: signInOf.get(d) }))) : [],
        intel.rdap && senderReg ? intel.rdap.ageDays(senderReg).catch(() => null) : null,
        intel.feeds && facts.senderAddress ? intel.feeds.addressHit(facts.senderAddress).catch(() => null) : null,
        intel.feeds && senderDomain && !personal && !ours(senderDomain) ? intel.feeds.domainHit(senderDomain).catch(() => null) : null,
        intel.feeds ? Promise.all(web.map(async j => [j, (await listHit(j.finalUrl || j.url)) || (j.finalUrl && j.finalUrl !== j.url ? await listHit(j.url) : null)])) : []
    ]);
    checks.lists = !!intel.feeds;

    // Links: the first finding that flags one makes it dangerous.
    for (const j of web) {
        const found = [];
        for (const h of [hostOf(j.finalUrl), hostOf(j.url)]) { const r = hostResults.get(h); if (r && r.verdict === 'unsafe') found.push(`${r.reason} (${h})`); }
        for (const u of [j.finalUrl, j.url]) { const r = u && urlResults.get(u); if (r && r.verdict === 'unsafe') found.push(r.reason); }
        const listed = (linkListed.find(([x]) => x === j) || [])[1];
        if (listed) found.push(`listed as phishing by ${listed}`);
        if (found.length) { j.severity = 'danger'; j.reason = found[0]; j.network = true; }
    }
    for (const r of hostResults.values()) { if (r.verdict === 'unknown') checks.notChecked++; else if (r.by === 'Cloudflare Security' || r.by === 'Cloudflare') checks.cloudflare++; }
    for (const r of urlResults.values()) { if (r.verdict === 'unknown') checks.notChecked++; else checks.safeBrowsing++; }

    const signals = [];
    if (senderOnList) signals.push({ weight: 5, kind: 'scam-sender-list', text: `The sender's address is on a list of known scam senders (${senderOnList}).` });
    const sd = hostResults.get(senderDomain);
    if (sd && sd.verdict === 'unsafe') signals.push({ weight: 5, kind: 'sender-domain-blocked', text: `The sender's domain ${senderDomain} is blocked by Cloudflare Security as malware or phishing.` });
    else if (senderDomainListed) signals.push({ weight: 5, kind: 'sender-domain-listed', text: `The sender's domain ${senderDomain} is listed as phishing by ${senderDomainListed}.` });
    else if (sd && sd.verdict === 'nonexistent') signals.push({ weight: 3, kind: 'sender-domain-missing', text: `The sender's domain ${senderDomain} doesn't exist, so the address is made up.` });
    if (typeof senderAge === 'number') {
        checks.ages++;
        let look = null;
        try { look = E.lookalikeOf(senderDomain); } catch (e) { look = null; }
        if (look && senderAge < LOOKALIKE_YOUNG_DAYS) signals.push({ weight: 5, kind: 'young-lookalike-sender', text: `The sender's domain ${senderReg} ${look}, and was registered only ${senderAge} day${senderAge === 1 ? '' : 's'} ago: a look-alike address.` });
        else if (senderAge < YOUNG_SENDER_DAYS) signals.push({ weight: 2, kind: 'young-sender-domain', text: `The sender's domain ${senderReg} was registered only ${senderAge} day${senderAge === 1 ? '' : 's'} ago. Phishing often comes from brand-new domains.` });
    }
    const known = ages.filter(a => typeof a.days === 'number');
    checks.ages += known.length;
    if (known.length) {
        let emailAsks = false;
        try { emailAsks = E.highRiskRequestKinds(facts.visibleText).length > 0 || E.SIGNIN_INTENT_RE.test(facts.subject || ''); } catch (e) { emailAsks = false; }
        const weakAuth = !!ctx.firstTime || !facts.auth || facts.auth.dmarc !== 'pass';
        try { signals.push(...E.linkAgeSigns(known, { emailAsks, weakAuth })); } catch (e) { /* no sign */ }
    }
    return { signals, checks };
}

module.exports = { networkChecks, LINK_AGE_LOOKUPS };
