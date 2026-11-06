'use strict';
// One email → the extension's verdict (the same signals and weights: caution at 3, flagged at 5) and
// the AI model's opinion. Pure apart from the model: no network, nothing stored.
//
// Not yet here (they need the network; see docs/ROADMAP.md): the DNS threat services, the phishing
// lists, short-link lookups, registry dates of link domains, brand ownership. A link is judged by
// what can be read offline: the extension's decoders unwrap gateway and tracker links, and
// detectLinkProblem/linkProblemSeverity find look-alike domains, mismatched link text, raw IP
// addresses and the like.
const spruce = require('./spruce');

const MAX_LINKS = 300;

function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }

async function judgeLinks(E, links) {
    const out = [];
    for (const l of links.slice(0, MAX_LINKS)) {
        const href = String(l.href || '');
        const scheme = (/^\s*([a-z][a-z0-9+.-]*):/i.exec(href) || [])[1];
        if (scheme && /^(javascript|vbscript|data|file)$/i.test(scheme)) {
            out.push({ text: l.text, url: href.slice(0, 200), finalUrl: '', severity: 'danger', reason: `link runs code or opens hidden content (${scheme.toLowerCase()}:)` });
            continue;
        }
        if (!/^https?:\/\//i.test(href)) continue;                         // mailto:, tel:, anchors
        let finalUrl = href;
        try { finalUrl = (await E.unwrapNestedUrl(href, false, { redirectorSet: new Set() })).unwrappedUrl || href; } catch (e) { /* kept as it is */ }
        let reason = null;
        try { reason = E.detectLinkProblem(l.text || '', href, finalUrl, E.builtinTrackers, {}); } catch (e) { reason = null; }
        let severity = reason ? E.linkProblemSeverity(reason) : null;
        if (!reason) { const cloud = E.cloudStoragePage(finalUrl); if (cloud) { reason = cloud.reason; severity = 'caution'; } }
        out.push({ text: l.text, url: href, finalUrl, severity, reason, hidden: !!l.hidden });
    }
    return out;
}

// The extension's emailContentSignals: links flagged dangerous.
function linkSignals(judged) {
    const web = judged.filter(j => !j.hidden);
    const danger = web.filter(j => j.severity === 'danger');
    if (!danger.length) return [];
    const why = [...new Set(danger.map(d => String(d.reason || '').replace(/\.$/, '')))].slice(0, 2).join('; ');
    const total = web.length;
    return [{ weight: danger.length >= 2 || danger.length === total ? 5 : 3, kind: 'dangerous-links',
              text: `${danger.length === total ? (danger.length === 1 ? 'Its only link is' : `All ${danger.length} of its links are`) : `${danger.length} of its ${total} links ${danger.length === 1 ? 'is' : 'are'}`} flagged as dangerous${why ? ` (${why})` : ''}.` }];
}

// facts: from mime.readMessage. ctx: { mailbox (the recipient's address), orgDomains: [..], trusted: bool,
// firstTime: bool (first email from this address anywhere in the organization, after the learning period) }
async function analyze(facts, ctx = {}) {
    const E = spruce.load();
    const mailbox = String(ctx.mailbox || '').toLowerCase();
    const org = (ctx.orgDomains || [])[0] || '';
    const senderDomain = (facts.senderAddress.split('@')[1] || '').toLowerCase();
    const inside = !!senderDomain && (ctx.orgDomains || []).some(d => E.isOwnDomain(senderDomain, d));
    const judged = await judgeLinks(E, facts.links || []);
    const allText = `${facts.subject}\n${facts.visibleText}\n${facts.hiddenText}`;
    const safe = (f) => { try { return f() || []; } catch (e) { return []; } };
    const headerSigns = safe(() => E.headerAnomalies(facts.rawForHeaders, mailbox, E.gmailReceiver));
    const signals = [
        ...headerSigns,
        ...safe(() => E.displayNameAnomalies(facts.senderName)),
        ...safe(() => E.nameAddressSigns(facts.senderName, facts.senderAddress, org, null, null)),
        ...safe(() => E.ownNameSigns(facts.senderName, facts.senderAddress, mailbox)),
        ...safe(() => E.subjectScamSigns(facts.subject)),
        ...safe(() => E.bodyScamSigns(facts.visibleText)),
        ...safe(() => E.selfVouchingSigns(allText)),
        ...safe(() => E.layoutSigns(facts.layout)),
        ...safe(() => E.highRiskRequestSigns(facts.visibleText)),
        ...safe(() => E.senderContextSigns(facts.senderAddress, org, !!ctx.firstTime)),
        ...linkSignals(judged)
    ];
    const base = { status: ctx.trusted ? 'trusted' : 'clean', reasons: [], move: false };
    const verdict = E.applyEmailSignals(base, signals) || base;

    // The model reads what the extension gives it for an opened email (modelInputParts in ai.js).
    const aiFacts = {
        subject: facts.subject, senderName: facts.senderName, senderAddress: facts.senderAddress,
        org: (ctx.orgDomains || []).length ? (inside ? 'inside' : 'outside') : undefined,
        auth: facts.auth ? { dmarc: facts.auth.dmarc } : null,
        links: judged.filter(j => !j.hidden).slice(0, 8).map(j => ({ text: j.text, host: hostOf(j.url), destHost: j.finalUrl && hostOf(j.finalUrl) !== hostOf(j.url) ? hostOf(j.finalUrl) : '', finding: j.severity ? j.reason : '' })),
        bodyText: String(facts.visibleText || '').slice(0, 8000),
        recipient: mailbox.split('@')[0] || '',
        layout: facts.layout || [],
        mailChecks: headerSigns.map(s => s.kind).filter(Boolean)
    };
    let ai = null;
    try {
        const r = E.model.analyze(aiFacts);
        ai = { probability: r.probability, reasons: r.reasons.map(x => ({ sentence: x.sentence, facts: !!x.facts })), model: `${r.model} ${r.version}` };
    } catch (e) {
        ai = { probability: null, error: String(e && e.message || e), model: `${E.modelInfo.name} ${E.modelInfo.version}` };
    }
    return {
        status: verdict.status,
        score: typeof verdict.score === 'number' ? verdict.score : signals.reduce((a, s) => a + (s.weight || 0), 0),
        signals: signals.map(s => ({ weight: s.weight, kind: s.kind || null, text: s.text })),
        links: judged.filter(j => j.severity).slice(0, 20).map(j => ({ url: j.url.slice(0, 300), finalUrl: String(j.finalUrl || '').slice(0, 300), severity: j.severity, reason: j.reason })),
        linkCount: judged.length,
        inside,
        ai
    };
}

module.exports = { analyze, judgeLinks, linkSignals };
