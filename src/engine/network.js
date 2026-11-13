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
// is slow leaves things "not checked".
// One exception (0.5.18), the reputation check: a link whose text shows another site (open.spotify.com)
// but which goes through the mail service that sent the email (mailers.js: the third party whose DKIM
// signature the receiver verified, such as beehiiv for link.mail.beehiiv.com; no list) becomes a warning
// instead of a danger, when Cloudflare and the phishing lists checked the service's domain and found
// nothing (nor did Safe Browsing, when on), and its registry date isn't recent. A lookup that didn't
// answer leaves it dangerous, as before.
const LINK_AGE_LOOKUPS = 3;
const YOUNG_SENDER_DAYS = 30, LOOKALIKE_YOUNG_DAYS = 90;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const { sendingService, mismatchHost, MAILER_MIN_AGE_DAYS } = require('./mailers');

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
    // (A mail service's domain behind a "text shows another site" link first: its age is part of its reputation.)
    const mailerReg = new Set(web.map(j => mismatchHost(j.reason)).filter(h => h && sendingService(h, facts, E.registrableDomain)).map(h => E.registrableDomain(h)));
    const rank = (d) => (mailerReg.has(d) ? 2 : 0) + (signInOf.get(d) ? 1 : 0);
    const ageDomains = [...signInOf.keys()].sort((a, b) => rank(b) - rank(a)).slice(0, LINK_AGE_LOOKUPS);
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

    // Links: the first finding that flags one makes it dangerous. A community report (a list whose confidence
    // is 'report', such as TweetFeed: 0.5.21) only marks it for caution, and counts as a sign below.
    const isReport = (name) => !!(intel.feeds && typeof intel.feeds.confidenceOf === 'function' && intel.feeds.confidenceOf(name) === 'report');
    const reported = [];
    for (const j of web) {
        const found = [];
        for (const h of [hostOf(j.finalUrl), hostOf(j.url)]) { const r = hostResults.get(h); if (r && r.verdict === 'unsafe') found.push(`${r.reason} (${h})`); }
        for (const u of [j.finalUrl, j.url]) { const r = u && urlResults.get(u); if (r && r.verdict === 'unsafe') found.push(r.reason); }
        const listed = (linkListed.find(([x]) => x === j) || [])[1];
        if (listed && !isReport(listed)) found.push(`listed as phishing by ${listed}`);
        if (found.length) { j.severity = 'danger'; j.reason = found[0]; j.network = true; }
        else if (listed) {
            reported.push({ j, by: listed });
            if (j.severity !== 'danger') { j.severity = 'caution'; j.reason = `reported as phishing or malware by ${listed}${j.reason ? `; ${j.reason}` : ''}`; j.network = true; }
        }
    }
    // The reputation check (0.5.18): a mismatched link through the service that sent the email, which the
    // lookups checked and found nothing against, and whose domain isn't new: a warning (caution), not a danger.
    const ageOf = new Map(ages.map(a => [a.domain, a.days]));
    const softened = [];
    for (const j of web) {
        if (j.severity !== 'danger' || j.network) continue;
        const host = mismatchHost(j.reason);
        const service = host && sendingService(host, facts, E.registrableDomain);
        if (!service) continue;
        const mailer = service.domain;
        const cf = hostResults.get(host), days = ageOf.get(E.registrableDomain(host));
        if (!cf || cf.verdict !== 'clean' || !intel.feeds || (typeof days === 'number' && days < MAILER_MIN_AGE_DAYS)) continue;
        const age = typeof days === 'number' ? `, registered ${days >= 730 ? `${Math.floor(days / 365)} years` : `${days} days`} ago` : '';
        j.severity = 'caution';
        j.reason = `${j.reason}, the click tracker of ${mailer}, the mail service that sent this email (its signature checked by Gmail; not blocked or listed as phishing${age}); where it leads isn't known until it's clicked`;
        j.mailer = mailer;
        softened.push({ mailer, host, text: (/^link text shows (\S+)/.exec(j.reason) || [])[1] || '' });
    }
    for (const r of hostResults.values()) { if (r.verdict === 'unknown') checks.notChecked++; else if (r.by === 'Cloudflare Security' || r.by === 'Cloudflare') checks.cloudflare++; }
    for (const r of urlResults.values()) { if (r.verdict === 'unknown') checks.notChecked++; else checks.safeBrowsing++; }

    const signals = [];
    if (softened.length) {
        const s = softened[0], n = softened.length;
        signals.push({ weight: 1, kind: 'mailer-link', text: `${n === 1 ? `A link shows ${s.text} but goes` : `${n} links show another site but go`} through the click tracker of ${s.mailer} (${s.host}), the mail service that sent this email, with a clean reputation: where ${n === 1 ? 'it leads' : 'they lead'} isn't known until clicked. A warning: it takes other signs to move the email.` });
    }
    if (senderOnList) signals.push({ weight: 5, kind: 'scam-sender-list', text: `The sender's address is on a list of known scam senders (${senderOnList}).` });
    const sd = hostResults.get(senderDomain);
    if (sd && sd.verdict === 'unsafe') signals.push({ weight: 5, kind: 'sender-domain-blocked', text: `The sender's domain ${senderDomain} is blocked by Cloudflare Security as malware or phishing.` });
    else if (senderDomainListed && isReport(senderDomainListed)) signals.push({ weight: 2, kind: 'sender-domain-reported', text: `The sender's domain ${senderDomain} was reported as phishing or malware by ${senderDomainListed} (community reports).` });
    else if (senderDomainListed) signals.push({ weight: 5, kind: 'sender-domain-listed', text: `The sender's domain ${senderDomain} is listed as phishing by ${senderDomainListed}.` });
    if (reported.length) {
        const r = reported[0], host = hostOf(r.j.finalUrl || r.j.url);
        signals.push({ weight: 2, kind: 'reported-link', text: `${reported.length === 1 ? `A link's site (${host}) was` : `${reported.length} links' sites were`} reported as phishing or malware by ${r.by} in the last 30 days (community reports: a sign, not proof).` });
    }
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
