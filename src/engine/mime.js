'use strict';
// A raw email (RFC 822, as the Gmail API returns it with format=raw) → the facts the checks and the
// model use: sender, subject, the receiving server's verification results, links, the text a person
// sees, how the email hides text, attachments (names and types only).
const { simpleParser } = require('mailparser');
const { readHtml } = require('./html');

const MAX_RAW = 2 * 1024 * 1024;   // headerAnomalies reads at most this much of the message

// The receiving server's own verdict (Gmail writes "Authentication-Results: mx.google.com; …" on
// arrival). Results written by anyone else (the sender can add their own) are ignored.
function receiverAuth(rawHead, receiverHost = 'mx.google.com') {
    const lines = String(rawHead || '').replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n');
    for (const line of lines) {
        const m = /^authentication-results:\s*(.*)$/i.exec(line);
        if (!m) continue;
        const v = m[1];
        if (v.split(';')[0].trim().toLowerCase() !== receiverHost) continue;
        const get = (k) => { const r = new RegExp(`\\b${k}=([a-z]+)`, 'i').exec(v); return r ? r[1].toLowerCase() : null; };
        const from = /header\.from=([^\s;]+)/i.exec(v);
        // Every domain whose DKIM signature the receiver verified (header.i=@mail.beehiiv.com or header.d=…):
        // a third party among them is the service that sent the email (0.5.19).
        const dkimDomains = [...new Set([...v.matchAll(/dkim=pass\b[^;]*?\bheader\.[id]=@?([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi)].map(m => m[1].toLowerCase()))];
        return { dmarc: get('dmarc'), spf: get('spf'), dkim: get('dkim'), arc: get('arc'), headerFrom: from ? from[1].toLowerCase() : null, dkimDomains };
    }
    return null;
}

function textToHtmlish(text) {
    // Plain-text emails: the text is what a person sees; links are the web addresses in it.
    return { visibleText: String(text || '').slice(0, 20000), hiddenText: '', quotedText: '', preheader: '', layout: [], pictures: 0,
             links: [...String(text || '').matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)].slice(0, 300).map(m => ({ text: m[0], href: m[0], hidden: false, afterGap: false })) };
}

// raw: Buffer or string. Returns the facts, or throws for a message that can't be parsed at all.
async function readMessage(raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
    const text = buf.subarray(0, MAX_RAW).toString('utf8');
    const headEnd = text.search(/\r?\n\r?\n/);
    const rawHead = headEnd >= 0 ? text.slice(0, headEnd) : text;
    const mail = await simpleParser(buf, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, maxHtmlLengthToParse: 2 * 1024 * 1024 });
    const from = (mail.from && mail.from.value && mail.from.value[0]) || {};
    const read = mail.html ? readHtml(mail.html) : textToHtmlish(mail.text);
    // Plain-text part as well: some phishing puts different text there than in the HTML.
    if (mail.html && mail.text && !read.visibleText.trim()) read.visibleText = String(mail.text).slice(0, 20000);
    const to = [].concat(mail.to || []).flatMap(t => (t && t.value) || []).map(v => String(v.address || '').toLowerCase()).filter(Boolean);
    // The people the email names in its headers (display names and addresses), for the retraining
    // export's removal of names (src/training.js); never stored.
    const named = (field) => [].concat(field || []).flatMap(t => (t && t.value) || []).map(v => ({ name: String(v.name || ''), address: String(v.address || '').toLowerCase() })).filter(p => p.name || p.address);
    const people = { to: named(mail.to), cc: named(mail.cc), replyTo: named(mail.replyTo) };
    return {
        rawForHeaders: text,                                   // for headerAnomalies (headers + the start of the body)
        rawHead,
        messageIdHeader: mail.messageId || '',
        date: mail.date ? mail.date.getTime() : null,
        subject: String(mail.subject || ''),
        senderName: String(from.name || ''),
        senderAddress: String(from.address || '').toLowerCase(),
        replyTo: ((mail.replyTo && mail.replyTo.value) || []).map(v => String(v.address || '').toLowerCase()).filter(Boolean),
        // The email(s) this one answers, by Message-ID (0.5.33: a fake reply chain names none).
        inReplyTo: mail.inReplyTo ? String(mail.inReplyTo).slice(0, 1000) : '',
        references: [].concat(mail.references || []).map(String).slice(0, 50),
        to,
        people,
        auth: receiverAuth(rawHead),
        visibleText: read.visibleText,
        hiddenText: read.hiddenText,
        quotedText: read.quotedText,
        layout: read.layout,
        pictures: read.pictures,
        links: read.links,
        // (Not the AMP version of the body, text/x-amp-html, that Google's share and comment notifications carry
        // beside the HTML one: it is the email itself, not a file, 0.5.22.)
        attachments: (mail.attachments || []).filter(a => !(String(a.contentType || '').toLowerCase() === 'text/x-amp-html' && !a.filename))
            .map(a => ({ name: String(a.filename || ''), type: String(a.contentType || ''), size: a.size || 0 }))
    };
}

module.exports = { readMessage, receiverAuth };
