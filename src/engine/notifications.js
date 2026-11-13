'use strict';
// Email that a platform sends for a person (0.5.16): Google Classroom, Drive, Docs, Sheets, Slides, Forms and
// Calendar; DocuSign; Dropbox; Adobe Acrobat Sign; SharePoint. "Dana Morales (via Google Docs)"
// <drive-shares-dm-noreply@google.com>, "Jordan Rivera (Classroom)" <no-reply@classroom.google.com>, "Dana
// Morales via Docusign" <dse_na4@docusign.net>. The name is the person's; the address, the sender check and the
// "[EXTERNAL]" tag a district's own routing rule adds are the platform's, for a colleague's share as much as for
// a stranger's. So such an email, once the receiver's sender check proves the platform sent it, is judged by
// the person's own address: the Reply-To the platform sets from their account (Drive shares, DocuSign), or the
// "Name (address)" it writes in the text. Classroom notifications carry neither: the person is then unknown,
// and their name proves nothing either way.
//
// Also here: a colleague's name in the text of an outside share (the compromised-district campaign: a real
// account elsewhere shares a document "from" someone of yours), and what counts as a share or a signature
// request. Names are compared only as colleagueNameHash fingerprints, as the directory's are kept.

// The platforms' own sending domains (the domain the sender check passed for), and their notification
// mailboxes (an employee's own address at the platform is not a notification).
const PLATFORMS = [
    { name: 'Google', domain: 'google.com' },
    { name: 'DocuSign', domain: 'docusign.net' },
    { name: 'DocuSign', domain: 'docusign.com' },
    { name: 'Dropbox', domain: 'dropbox.com' },
    { name: 'Dropbox', domain: 'dropboxmail.com' },
    { name: 'Adobe Acrobat Sign', domain: 'adobesign.com' },
    { name: 'Adobe Acrobat Sign', domain: 'echosign.com' },
    { name: 'SharePoint', domain: 'sharepointonline.com' }
];
const NOTIFICATION_MAILBOX = /(^|[-_.])(no-?reply|noreply|notifications?|drive-shares|shares|comments|receipts|calendar|classroom|dse)([-_.]|$)|^dse(_[a-z0-9]+)?$/i;
// "Name (via Google Docs)", "Name (Classroom)", "Name (Google Forms)", "Name via Docusign".
const VIA_PARENS = /^(.*?)\s*\((?:via\s+)?([^()]{2,40})\)\s*$/i;
const VIA_WORD = /^(.*?)\s+via\s+(.{2,40})$/i;

// Hosts of documents, forms, folders and signature requests: a "share" when one is linked.
const SHARE_HOSTS = ['docs.google.com', 'drive.google.com', 'forms.gle', 'sites.google.com', 'classroom.google.com', 'docusign.net', 'docusign.com',
    'dropbox.com', 'db.tt', '1drv.ms', 'onedrive.live.com', 'sharepoint.com', 'acrobat.adobe.com', 'adobesign.com', 'echosign.com', 'box.com', 'wetransfer.com', 'we.tl'];
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch (e) { return ''; } };
const onHost = (h, d) => h === d || h.endsWith(`.${d}`);
const isShareLink = (href) => { const h = hostOf(href); return !!h && SHARE_HOSTS.some(d => onHost(h, d)); };

const domainOf = (a) => String(a || '').toLowerCase().split('@')[1] || '';
const ownDomain = (d, orgDomains) => !!d && (orgDomains || []).some(o => d === o || d.endsWith(`.${o}`));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The platform notification behind an email, or null. facts: from mime.readMessage.
//   { platform: 'Google' | 'DocuSign' | …, via: 'Google Docs' | 'Classroom' | …, name: the person's name (or ''),
//     address: the person's own address (or null: not in the email), inside: true | false | null (unknown) }
function platformNotification(facts, orgDomains = []) {
    const f = facts || {};
    const sender = String(f.senderAddress || '').toLowerCase();
    const domain = domainOf(sender), local = sender.split('@')[0] || '';
    const a = f.auth || {};
    const platform = PLATFORMS.find(p => domain === p.domain || domain.endsWith(`.${p.domain}`));
    // Proven: the receiver's DMARC check passed for the platform's own domain (Gmail's verdict, which a sender
    // can't write: mime.receiverAuth reads only the receiver's own Authentication-Results).
    if (!platform || a.dmarc !== 'pass' || !a.headerFrom || !(domain === a.headerFrom || domain.endsWith(`.${a.headerFrom}`))
        || !(a.headerFrom === platform.domain || a.headerFrom.endsWith(`.${platform.domain}`)) || !NOTIFICATION_MAILBOX.test(local)) return null;
    const shown = String(f.senderName || '').trim();
    const m = VIA_PARENS.exec(shown) || VIA_WORD.exec(shown);
    const name = (m ? m[1] : '').trim().replace(/^["']+|["']+$/g, '');
    const via = m ? m[2].trim() : platform.name;
    // Google Classroom (0.5.17): its posts, and its class invitations ("Class invitation: …", or the
    // notification type in X-Notifications).
    const classroom = platform.name === 'Google' && (/classroom/i.test(via) || onHost(domain, 'classroom.google.com'));
    const kind = (/^x-notifications:\s*([A-Z_]+)/mi.exec(String(f.rawHead || '')) || [])[1] || '';
    const invitation = classroom && (/invit/i.test(String(f.subject || '')) || /INVIT/.test(kind));
    // The person's own address: the Reply-To the platform set (not one of its own addresses), or the
    // "Name (address)" it writes in the text; for a class invitation, also an address at a personal
    // provider anywhere in its text (who runs the class).
    let address = null;
    const replyTo = ((f.people && f.people.replyTo) || []).map(p => String(p.address || '').toLowerCase()).find(x => x.includes('@') && !PLATFORMS.some(p => domainOf(x) === p.domain || domainOf(x).endsWith(`.${p.domain}`)));
    const text = `${f.visibleText || ''}\n${f.quotedText || ''}`;
    if (replyTo) address = replyTo;
    else if (name) {
        const t = new RegExp(`${escapeRe(name)}\\s*\\(\\s*([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})\\s*\\)`, 'i').exec(text);
        if (t) address = t[1].toLowerCase();
    }
    if (!address && invitation) {
        const E = require('./spruce').load();
        const any = (text.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(x => x.toLowerCase()).find(x => E.isPersonalMailDomain(domainOf(x)));
        if (any) address = any;
    }
    return { platform: platform.name, via, name, address, inside: address ? ownDomain(domainOf(address), orgDomains) : null, classroom, invitation };
}

// What an outside share comes from, for the mass-share count (pipeline.js): a platform notification for a
// person outside the organization, or an outside sender's own email linking a document, form, folder or
// signature request. { address } or null.
function shareSource(facts, orgDomains = []) {
    const relay = platformNotification(facts, orgDomains);
    if (relay) return relay.address && relay.inside === false ? { address: relay.address, relay } : null;
    const sender = String((facts && facts.senderAddress) || '').toLowerCase();
    if (!sender.includes('@') || ownDomain(domainOf(sender), orgDomains)) return null;
    return ((facts && facts.links) || []).some(l => isShareLink(l.href)) ? { address: sender, relay: null } : null;
}

// The person behind a platform notification, under a colleague's name, with an account outside the
// organization: an account taken over or made up elsewhere, sharing "as" your colleague. At another
// organization's domain: 5 (flagged); at a personal mail provider (gmail.com…), where staff do have their own
// accounts: 3 (amber), as for a colleague's name on an outside address.
//
// Google Classroom from a personal account (gmail.com and the other free providers): a class run outside any
// school, the known way to send scams through Classroom's own address (2025: 115,000 invitations to 13,500
// organizations). 5 (flagged), whatever the name: a school's classes come from its own domain. (0.5.17)
function relaySigns(E, relay, colleagues) {
    if (!relay || !relay.address || relay.inside !== false) return [];
    const personal = E.isPersonalMailDomain(domainOf(relay.address));
    if (relay.classroom && personal) {
        return [{ weight: 5, kind: 'classroom-personal', text: `A Google Classroom ${relay.invitation ? 'invitation' : 'email'} from a personal account (${relay.address}), not a school's: classes run from personal accounts are a known way to send scams through Classroom.` }];
    }
    if (!relay.name || !colleagues || !colleagues.size) return [];
    const h = E.colleagueNameHash(relay.name);
    if (!h || !colleagues.has(h)) return [];
    return [personal
        ? { weight: 3, kind: 'relay-colleague-personal', text: `${relay.via} sent it for someone using the name of a person in your organization, from a personal account outside it (${relay.address}).` }
        : { weight: 5, kind: 'relay-colleague-outside', text: `${relay.via} sent it for someone using the name of a person in your organization, but from an account at another organization (${relay.address}).` }];
}

// A colleague's name in the subject or text of a share that comes from outside: "Dana Morales asked me to
// share…", "Shared: Q3 Budget from Dana Morales", a signature "Thanks, Dana Morales". 2: legitimate partners
// write that too, so it moves an email only with more (a first share from them, a mass share, a sign-in or
// payroll request, the link checks or the AI). Not a greeting ("Hi Dana Morales"), not the reader's own name
// (selfHash), not the sender's own (the From checks judge that), and not a quotation of the colleague's own
// email: the name followed by their address in your domains, or "wrote:" ("On Monday, Dana Morales
// <dana@your-district.org> wrote:", "From: Dana Morales <dana@your-district.org>").
const GREETINGS = new Set(['hi', 'hello', 'dear', 'hey', 'morning', 'afternoon', 'evening', 'greetings', 'attn', 'attention']);
function colleagueMentionSigns(E, { subject, text, colleagues, selfHash, exclude = [], orgDomains = [] }) {
    if (!colleagues || !colleagues.size) return [];
    const skip = new Set([selfHash, ...exclude.map(n => E.colleagueNameHash(n))].filter(Boolean));
    const quoting = (after) => /^[\s"']*(?:<|\()?\s*[A-Za-z0-9._%+'-]+@([A-Za-z0-9.-]+)/.test(after) && ownDomain((/@([A-Za-z0-9.-]+)/.exec(after) || [])[1], orgDomains)
        || /^[^\n.!?]{0,80}\bwrote:/i.test(after);
    for (const part of [String(subject || ''), String(text || '').slice(0, 30000)]) {
        const words = [...part.matchAll(/[\p{L}][\p{L}'’-]*/gu)];
        for (let i = 0; i < words.length - 1; i++) {
            if (!/^\p{Lu}/u.test(words[i][0]) || !/^\p{Lu}/u.test(words[i + 1][0])) continue;
            if (i > 0 && GREETINGS.has(words[i - 1][0].toLowerCase())) continue;
            for (const n of [2, 3]) {
                if (i + n > words.length || !words.slice(i, i + n).every(w => /^\p{Lu}/u.test(w[0]))) continue;
                const h = E.colleagueNameHash(words.slice(i, i + n).map(w => w[0]).join(' '));
                const last = words[i + n - 1];
                if (h && colleagues.has(h) && !skip.has(h) && !quoting(part.slice(last.index + last[0].length, last.index + last[0].length + 160))) {
                    return [{ weight: 2, kind: 'colleague-named-outside', text: 'It names someone in your organization as the one it comes from or asks for it, but it was shared from outside: accounts taken over at other organizations send such shares.' }];
                }
            }
        }
    }
    return [];
}

// An outside share whose text asks to sign in, verify an account or confirm details (payroll, direct
// deposit, a password) to see it: a shared document doesn't need that, the platform signs people in itself.
// The lure of these campaigns. 1, on top of what the request check (highRiskRequestSigns) finds.
const SHARE_LURE = /\b(?:sign|log)[\s-]?in\b|\bverify\s+(?:your|the)\s+(?:account|identity|email|details|information|mailbox)\b|\bconfirm\s+(?:your\s+)?(?:account|identity|details|information|credentials|direct\s+deposit|payroll|password|bank(?:ing)?\s+details)\b|\b(?:enter|provide|update)\s+(?:your\s+)?(?:password|credentials|login|direct\s+deposit|banking|bank\s+details)\b|\bre-?authenticate\b|\bvalidate\s+(?:your\s+)?(?:account|mailbox|email)\b/i;
function shareLureSigns(text) {
    return SHARE_LURE.test(String(text || '').slice(0, 30000))
        ? [{ weight: 1, kind: 'share-lure', text: 'It was shared from outside and asks you to sign in, verify an account or confirm details to see it: a shared document doesn\'t need that.' }] : [];
}

// It was shared with many of the organization's people within the hour by the same outside account
// (pipeline.js counts them: store.shareReach): the usual sign of an account taken over elsewhere.
const MASS_SHARE = 10;
function massShareSigns(reach) {
    return reach >= MASS_SHARE ? [{ weight: 2, kind: 'mass-share', text: `The same outside account sent this to ${reach} of your people within the hour.` }] : [];
}

module.exports = { platformNotification, shareSource, relaySigns, colleagueMentionSigns, shareLureSigns, massShareSigns, isShareLink, MASS_SHARE, PLATFORMS };
