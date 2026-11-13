'use strict';
// One email → the extension's verdict (the same signals and weights: caution at 3, flagged at 5) and
// the AI model's opinion. Nothing is stored here.
//
// Offline, as in the extension: its decoders unwrap gateway and tracker links, and
// detectLinkProblem/linkProblemSeverity find look-alike domains, mismatched link text, raw IP
// addresses and the like. With ctx.intel (src/intel; network.js applies it): Cloudflare Security DNS,
// Google Safe Browsing, the phishing lists and registry dates. Short links are NOT looked up (no
// unshorten.me or similar service): a short link is judged by its own host and what decodes offline.
const spruce = require('./spruce');
const { detectLanguage } = require('./language');
const N = require('./notifications');
const { fakeReplySigns } = require('./replychain');
const { readAttachments } = require('./attachments');
const { networkChecks } = require('./network');

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
        out.push({ text: l.text, url: href, finalUrl, severity, reason, hidden: !!l.hidden, from: l.from || undefined });
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

// Whether Gmail's own DMARC check passed for the sender's domain (the domain in From, which anyone can
// write). Only then does the address count for the allowlist or as "inside the organization".
function senderVerified(facts) {
    const a = facts && facts.auth;
    const domain = String((facts && facts.senderAddress) || '').toLowerCase().split('@')[1] || '';
    return !!(a && a.dmarc === 'pass' && domain && (!a.headerFrom || a.headerFrom === domain));
}

// facts: from mime.readMessage. ctx: { mailbox (the recipient's address), orgDomains: [..], trusted: bool,
// selfNameHash: the recipient's own name's colleagueNameHash (never counted as a colleague named), shareReach:
// how many of the organization's people the same outside account shared with this hour (pipeline.js),
// firstTime: bool (first email from this address anywhere in the organization, after the learning period),
// keepAiFacts: bool (the answer also has what the model read, for the retraining export),
// colleagues: Set of colleagueNameHash values (the organization's people), or null,
// aiInside: bool (the AI model also reads mail from inside the organization; off: the rules alone do) }
async function analyze(facts, ctx = {}) {
    const E = spruce.load();
    const mailbox = String(ctx.mailbox || '').toLowerCase();
    const org = (ctx.orgDomains || [])[0] || '';
    const senderDomain = (facts.senderAddress.split('@')[1] || '').toLowerCase();
    // An address in the organization's own domains (as the extension sees it, for the model); "inside"
    // for the policy only when DMARC passed: a forged staff address is mail from outside.
    const ownAddress = !!senderDomain && (ctx.orgDomains || []).some(d => E.isOwnDomain(senderDomain, d));
    const verified = senderVerified(facts);
    const inside = ownAddress && verified;
    // A platform's notification for a person, and a share from outside (notifications.js).
    const relay = N.platformNotification(facts, ctx.orgDomains || []);
    const share = N.shareSource(facts, ctx.orgDomains || []);
    // A notification's note (the sharer's own message) can be set apart as a quotation: the text checks read it.
    const bodyText = relay ? `${facts.visibleText}\n${facts.quotedText || ''}` : facts.visibleText;
    // Attachments and pictures (0.5.34): QR codes and links in them are checked like the email's own links.
    const att = ctx.readAttachments === false ? { links: [], signals: [], found: [], skipped: 0 }
        : await readAttachments(facts.attachmentFiles || [], { outside: !inside }).catch(() => ({ links: [], signals: [], found: [], skipped: 0 }));
    const judged = await judgeLinks(E, [...(facts.links || []), ...att.links]);
    // The network checks (they may flag links, so they come before the link signs are counted).
    // Allowlisted senders are never moved, so their mail costs no lookups.
    const net = await networkChecks(E, ctx.trusted ? null : (ctx.intel || null), facts, judged, Object.assign({}, ctx, { orgDomains: ctx.orgDomains || [] }))
        .catch(() => ({ signals: [], checks: { failed: true } }));
    const allText = `${facts.subject}\n${facts.visibleText}\n${facts.hiddenText}`;
    const safe = (f) => { try { return f() || []; } catch (e) { return []; } };
    const headerSigns = safe(() => E.headerAnomalies(facts.rawForHeaders, mailbox, E.gmailReceiver));
    const signals = [
        ...headerSigns,
        ...safe(() => E.displayNameAnomalies(facts.senderName)),
        // ctx.colleagues: one-way hashes of the organization's people's names (Service.colleagueNames).
        // A platform's notification for a person (Classroom, a Drive share, DocuSign…: notifications.js) is
        // judged by the person's own address, never by the platform's (0.5.16); any other email by its own.
        ...safe(() => (relay ? N.relaySigns(E, relay, ctx.colleagues || null) : E.nameAddressSigns(facts.senderName, facts.senderAddress, org, ctx.colleagues || null, null))),
        // The same names in the other address lines: replies going to an outside address under a
        // colleague's name, a colleague copied in at an outside or look-alike address (0.5.14). A
        // notification's Reply-To is the person themselves.
        ...safe(() => E.colleagueLineSigns(addressLinePeople(facts), ctx.orgDomains || [], ctx.colleagues || null, (relay && relay.address) || facts.senderAddress)),
        // A colleague named in an outside share's subject or text ("Dana Morales asked me to share…").
        ...safe(() => (share ? N.colleagueMentionSigns(E, { subject: facts.subject, text: bodyText,
            colleagues: ctx.colleagues || null, selfHash: ctx.selfNameHash || '', exclude: [relay ? relay.name : facts.senderName], orgDomains: ctx.orgDomains || [] }) : [])),
        ...(share ? N.shareLureSigns(`${facts.subject}\n${bodyText}`) : []),
        ...N.massShareSigns(share ? Number(ctx.shareReach) || 0 : 0),
        ...safe(() => E.ownNameSigns(facts.senderName, facts.senderAddress, mailbox)),
        ...insideSpoofSigns(E, facts, ctx.orgDomains || [], ownAddress, verified),
        ...safe(() => E.subjectScamSigns(facts.subject)),
        ...safe(() => E.bodyScamSigns(bodyText)),
        ...safe(() => E.selfVouchingSigns(allText)),
        ...safe(() => E.layoutSigns(facts.layout)),
        ...safe(() => E.highRiskRequestSigns(bodyText)),
        // "RE:" from outside or a new sender, answering nothing this mailbox has (0.5.33). Not a platform's
        // notification (a share is never a reply). ctx.threadSize: the Gmail thread's size (pipeline.js).
        ...safe(() => (relay ? [] : fakeReplySigns(facts, { threadSize: ctx.threadSize == null ? null : Number(ctx.threadSize), outside: !inside, firstTime: !!ctx.firstTime }))),
        // Outside, and first time: for a notification, the person's (none when the notification doesn't say who).
        ...safe(() => (relay ? (relay.address ? E.senderContextSigns(relay.address, org, !!ctx.firstTime) : []) : E.senderContextSigns(facts.senderAddress, org, !!ctx.firstTime))),
        ...linkSignals(judged),
        ...att.signals,
        ...net.signals,
        // A look-alike of the organization's domain that the look-alike watch found registered (0.5.36):
        // ctx.lookalikes, domain → 'strong' (new, or marked a threat) or 'weak' (there before the watch).
        ...safe(() => watchedLookalikeSigns(E, facts, judged, ctx.lookalikes))
    ];
    const base = { status: ctx.trusted ? 'trusted' : 'clean', reasons: [], move: false };
    const verdict = E.applyEmailSignals(base, signals) || base;
    // What confirms it from outside the email's own text: a link a security service blocks or a
    // phishing list has, a sender on a list or blocked, a brand-new look-alike sender domain, or Gmail's
    // DMARC check failing. Rules plus one of these is "strong" evidence (the brakes never hold it).
    const SENDER_CONFIRMS = new Set(['scam-sender-list', 'sender-domain-blocked', 'sender-domain-listed', 'young-lookalike-sender']);
    const WATCH_CONFIRMS = new Set(['watched-lookalike-sender', 'watched-lookalike-reply-to']);
    const confirmedBy = [
        signals.some(s => WATCH_CONFIRMS.has(s.kind)) ? 'the sender or the reply address is a newly registered look-alike of your domain' : '',
        judged.some(j => j.network && j.severity === 'danger') ? 'a link is blocked or on a phishing list' : '',
        net.signals.some(s => SENDER_CONFIRMS.has(s.kind)) ? 'the sender is on a list, blocked, or a new look-alike' : '',
        facts.auth && facts.auth.dmarc === 'fail' ? 'Gmail\'s DMARC check failed' : ''
    ].filter(Boolean);

    // The model reads what the extension gives it for an opened email (modelInputParts in ai.js).
    const aiFacts = {
        subject: facts.subject, senderName: facts.senderName, senderAddress: facts.senderAddress,
        org: (ctx.orgDomains || []).length ? (ownAddress ? 'inside' : 'outside') : undefined,
        auth: facts.auth ? { dmarc: facts.auth.dmarc } : null,
        links: judged.filter(j => !j.hidden).slice(0, 8).map(j => ({ text: j.text, host: hostOf(j.url), destHost: j.finalUrl && hostOf(j.finalUrl) !== hostOf(j.url) ? hostOf(j.finalUrl) : '', finding: j.severity ? j.reason : '' })),
        bodyText: String(facts.visibleText || '').slice(0, 8000),
        recipient: mailbox.split('@')[0] || '',
        layout: facts.layout || [],
        mailChecks: headerSigns.map(s => s.kind).filter(Boolean)
    };
    // The model was trained on English only: on an email clearly in another language its score means little,
    // so it gives none, and says why (the rule checks above don't depend on the language).
    const language = detectLanguage(`${facts.subject}\n${facts.visibleText}`);
    let ai = null;
    if (inside && !ctx.aiInside) {
        // Mail from inside the organization (your domains, DMARC passing) isn't read by the AI unless the
        // policy says so (AI_SCANS_INSIDE): the rules above (its links, headers and the rest) read it.
        ai = { probability: null, skipped: 'inside', model: `${E.modelInfo.name} ${E.modelInfo.version}` };
    } else if (!language.english) {
        ai = { probability: null, skipped: 'language', language: language.name, model: `${E.modelInfo.name} ${E.modelInfo.version}` };
    } else {
        try {
            const r = await E.model.analyze(aiFacts);
            ai = { probability: r.probability, reasons: r.reasons.map(x => ({ sentence: x.sentence, facts: !!x.facts })), model: `${r.model} ${r.version}` };
        } catch (e) {
            ai = { probability: null, error: String(e && e.message || e), model: `${E.modelInfo.name} ${E.modelInfo.version}` };
        }
    }
    return {
        status: verdict.status,
        score: typeof verdict.score === 'number' ? verdict.score : signals.reduce((a, s) => a + (s.weight || 0), 0),
        signals: signals.map(s => ({ weight: s.weight, kind: s.kind || null, text: s.text })),
        links: judged.filter(j => j.severity).slice(0, 20).map(j => ({ url: j.url.slice(0, 300), finalUrl: String(j.finalUrl || '').slice(0, 300), severity: j.severity, reason: j.reason, from: j.from || undefined })),
        linkCount: judged.length,
        // Every link's address and where it leads (in memory only): the re-check index (src/recheck.js).
        linkUrls: [...new Set(judged.flatMap(j => [j.url, j.finalUrl]).filter(Boolean))].slice(0, 80),
        // What the attachment checks found (0.5.34): file names and what was in them (a host, a sign), no content.
        attachmentFindings: att.found, attachmentsSkipped: att.skipped || 0,
        checks: net.checks,
        inside,
        ownAddress,
        verified,
        confirmedBy,
        strong: verdict.status === 'flagged' && confirmedBy.length > 0,
        ai,
        language: { code: language.code, name: language.name, english: language.english },
        // Only for the retraining export (src/training.js), which takes the people out: never stored.
        aiFacts: ctx.keepAiFacts ? aiFacts : undefined
    };
}

// Mail from, replying to, or linking to a domain the look-alike watch found (src/lookalike.js): new or
// marked a threat (strong): the sender 5, the reply address 5, a link 4; there before the watch began and
// not reviewed (weak): 3, 3, 2. The organization's own domains never count.
function watchedLookalikeSigns(E, facts, judged, lookalikes) {
    if (!lookalikes || !lookalikes.size) return [];
    const regOf = (h) => { const x = String(h || '').toLowerCase(); try { return E.registrableDomain(x) || x; } catch (e) { return x; } };
    const at = (a) => String(a || '').slice(String(a || '').lastIndexOf('@') + 1).toLowerCase();
    const out = [];
    const sender = regOf(at(facts.senderAddress));
    const sw = lookalikes.get(sender);
    if (sw) out.push(sw === 'strong'
        ? { weight: 5, kind: 'watched-lookalike-sender', text: `The sender's domain ${sender} imitates your organization's, and was registered recently (the look-alike watch found it; Status → Look-alikes).` }
        : { weight: 3, kind: 'known-lookalike-sender', text: `The sender's domain ${sender} imitates your organization's (the look-alike watch lists it; it was there before the watch began).` });
    const reply = (facts.replyTo || []).map(a => regOf(at(a))).find(d => d && d !== sender && lookalikes.get(d));
    if (reply) out.push(lookalikes.get(reply) === 'strong'
        ? { weight: 5, kind: 'watched-lookalike-reply-to', text: `Replies go to ${reply}, a recently registered imitation of your organization's domain (the look-alike watch found it).` }
        : { weight: 3, kind: 'known-lookalike-reply-to', text: `Replies go to ${reply}, an imitation of your organization's domain (the look-alike watch lists it).` });
    const link = (judged || []).map(j => regOf(hostOf(j.finalUrl || j.url))).find(d => d && d !== sender && lookalikes.get(d));
    if (link) out.push(lookalikes.get(link) === 'strong'
        ? { weight: 4, kind: 'watched-lookalike-link', text: `A link goes to ${link}, a recently registered imitation of your organization's domain (the look-alike watch found it).` }
        : { weight: 2, kind: 'known-lookalike-link', text: `A link goes to ${link}, an imitation of your organization's domain (the look-alike watch lists it).` });
    return out;
}

// The people in an email's Reply-To, Cc and To lines (name and address each, as the mail parser read
// them, a list person by person), for colleagueLineSigns.
function addressLinePeople(facts) {
    const p = facts.people || {};
    const line = (name, list) => (list || []).slice(0, 30).map(x => ({ line: name, name: x.name, address: x.address }));
    return [...line('reply-to', p.replyTo), ...line('cc', p.cc), ...line('to', p.to)];
}

// Signs of mail dressed up as coming from inside the organization:
//   - its From address is in your domains, but Gmail's DMARC check failed for it: someone else wrote it
//     (the DMARC failure is a sign of its own too; this one says it imitates a colleague's address);
//   - the sender's name shows an address of yours ("it@district.org" <x@elsewhere.example>) on an outside
//     address.
// Mail from inside that passed DMARC gets neither.
function insideSpoofSigns(E, facts, orgDomains, ownAddress, verified) {
    if (!orgDomains.length) return [];
    const out = [];
    const isOwn = (d) => orgDomains.some(o => E.isOwnDomain(String(d || '').toLowerCase(), o));
    if (ownAddress && !verified && facts.auth && facts.auth.dmarc === 'fail') {
        out.push({ weight: 2, kind: 'spoofed-inside', text: `It claims to come from inside your organization (${facts.senderAddress}), but Gmail's sender check (DMARC) failed: it wasn't sent by your domain.` });
    }
    const named = (String(facts.senderName || '').match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g) || []).filter(a => isOwn(a.split('@')[1]));
    if (named.length && !ownAddress) {
        out.push({ weight: 3, kind: 'inside-name-outside-address', text: `The sender's name shows an address of your organization (${named[0].toLowerCase()}), but it comes from outside (${facts.senderAddress}).` });
    }
    return out;
}

// What the model read of an email (analyze's aiFacts), sentence by sentence (Model.reading).
async function aiReading(aiFacts, max = 40) {
    return spruce.load().model.reading(aiFacts, max);
}

module.exports = { analyze, aiReading, judgeLinks, linkSignals, senderVerified, platformNotification: N.platformNotification, shareSource: N.shareSource };
