// ai.js — EXPERIMENT (branch llm_testing): the extension's own small language model reads an opened
// email and gives its opinion on whether it is phishing, and which sentences made it think so.
//
// The model (models/phish-tiny/) is a BERT-tiny classifier (2 layers, 4.4 million parameters, about
// 4.5 MB with 8-bit weights) that WE train, in TinyPhishLLM (the model's own repository, shared with the
// extension; tools/sync-model.js brings it here): its training/ generates the training emails, fine-tunes the
// model and exports it. In this service it runs in the native engine (src/engine/model.js, ONNX Runtime,
// nothing sent anywhere); this file builds its input and splits it into tokens.
//
// Ground rules, enforced here and in the callers:
//   - ADVISORY ONLY. The model's opinion can add a warning, never remove one: it never makes an email or
//     link "safe", never clears a flag and never moves anything to Spam (aiAdvice).
//   - ON THIS COMPUTER ONLY. Each opened email is analyzed as it opens (aiAutoAnalyze, on by default),
//     or only when the person clicks "Ask the AI"; nothing is sent anywhere or stored.
//   - LESS PERSONAL DATA. Addresses keep only their domain, phone numbers and long numbers are replaced
//     (redactForAi) before the text reaches the model, as in training.
//   - TEXT THAT VOUCHES FOR ITSELF counts toward phishing (selfVouchingSigns in shared.js; the training
//     data teaches the model the same).
// Loaded after shared.js (registrableDomain, selfVouchingSigns, isSharedMailbox).

// ---------------------------------------------------------------------------------------------------
// The model's input: one text built from the email's facts. TinyPhishLLM's training/make-dataset.js builds its
// training emails with this same function, so training and use always see the same format.
// facts: { subject, senderName, senderAddress, auth: { dmarc } | null,
//          links: [{ text, host, destHost, finding }], bodyText,
//          org: 'inside' | 'outside' | undefined (the user's own organization, when the account has one),
//          recipient: the reader's own mailbox name (the part before @), replaced by "your name" wherever
//                     it appears, so the model sees the trick ("READER! Apply…", a sender named after
//                     you) without ever seeing the name,
//          layout: ['images only' | 'text after a large blank gap'] (how the email hides its text),
//          mailChecks: kinds of headerAnomalies findings (AI_MAIL_CHECKS) }
// ---------------------------------------------------------------------------------------------------
const AI_MAX_LINKS = 8;

const AI_EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const AI_PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;
const AI_LONG_NUMBER_RE = /\b\d[\d -]{5,}\d\b/g;

// Email addresses keep their domain (where mail comes from matters, who it is for doesn't); phone
// numbers and long numbers (accounts, cards, codes) are replaced by what they are.
function redactForAi(text) {
    return String(text || '')
        .replace(AI_EMAIL_RE, (m, local, domain) => `address at ${domain.toLowerCase()}`)
        .replace(AI_PHONE_RE, 'phone number')
        .replace(AI_LONG_NUMBER_RE, 'number');
}

// Tags that mail systems add to EVERY outside email ("[EXTERNAL] …", "EXT: …", "CAUTION: …"): they say
// nothing about phishing (both kinds carry them), so the model never sees them.
function stripExternalTag(subject) {
    let s = String(subject || '');
    for (let i = 0; i < 3; i++) s = s.replace(/^\s*(\[\s*(external|ext|caution|warning|outside sender|non-district|external sender)[^\]]{0,30}\]|\*{0,3}\s*(external|ext|caution)\s*\*{0,3}\s*:)\s*/i, '');
    return s.trim();
}

// What a mail system along the way already found in the headers (headerAnomalies kinds), in words.
const AI_MAIL_CHECKS = Object.freeze({
    'spam-flag': 'already marked as spam by a mail system', 'local-tool': 'sent with a home-made bulk-mail tool',
    'broken-to': 'broken to address', 'placeholders': 'unfilled template placeholders', 'markup': 'web code in address lines',
    'forged-received': 'forged delivery records', 'duplicate-headers': 'repeated headers', 'fake-signature': 'fake signature'
});
const AI_LAYOUTS = new Set(['images only', 'text after a large blank gap']);

// The reader's own mailbox name, wherever it appears, becomes "your name" (whole words only, and only
// names of 3 or more letters, so "al" in "also" stays).
function maskRecipient(text, recipient) {
    const r = String(recipient || '').trim().toLowerCase();
    if (r.length < 3) return String(text || '');
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(text || '').replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1your name');
}

function modelInputParts(facts) {
    const f = facts || {};
    const mask = (t) => maskRecipient(redactForAi(t), f.recipient);
    const addr = String(f.senderAddress || '').toLowerCase();
    const domain = addr.split('@')[1] || 'unknown';
    const head = [];
    head.push(`subject: ${mask(stripExternalTag(f.subject) || 'none').slice(0, 160)}.`);
    const where = f.org === 'inside' ? ' (your organization)' : f.org === 'outside' ? ' (outside your organization)' : '';
    head.push(`from: "${mask(f.senderName || '').slice(0, 80)}" at ${domain}${where}${typeof isSharedMailbox === 'function' && isSharedMailbox(addr) ? ' (shared mailbox)' : ''}.`);
    const checks = [...new Set((f.mailChecks || []).map(k => AI_MAIL_CHECKS[k]).filter(Boolean))].slice(0, 4);
    head.push(`sender check: ${f.auth && f.auth.dmarc ? `dmarc ${f.auth.dmarc}` : 'unknown'}${checks.length ? `; ${checks.join('; ')}` : ''}.`);
    const links = (f.links || []).slice(0, AI_MAX_LINKS).map(l => {
        const text = mask(String(l.text || '').trim()).slice(0, 40) || 'image';
        const dest = l.destHost && l.destHost !== l.host ? `${l.host} then ${l.destHost}` : (l.host || 'unknown');
        return `"${text}" goes to ${dest}${l.finding ? ` (warning: ${redactForAi(l.finding).slice(0, 80)})` : ''}`;
    });
    head.push(links.length ? `links: ${links.join('; ')}.` : 'links: none.');
    const layout = (f.layout || []).filter(x => AI_LAYOUTS.has(x));
    if (layout.length) head.push(`layout: ${layout.join('; ')}.`);
    const body = mask(String(f.bodyText || '')).replace(/\s+/g, ' ').trim();
    return { head: head.join(' '), sentences: splitSentences(body) };
}

// Sentences (and line-like fragments), for the explanation; kept in order.
function splitSentences(text) {
    // Only at an end mark followed by a space, so addresses (www.example.com) and numbers stay whole.
    return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 1).slice(0, 60);
}

function modelInputText(facts) {
    const p = modelInputParts(facts);
    return `${p.head} text: ${p.sentences.join(' ')}`;
}

// ---------------------------------------------------------------------------------------------------
// WordPiece tokenizer, as BERT's uncased tokenizer (lower case, accents removed, punctuation split).
// ---------------------------------------------------------------------------------------------------
function isBertPunct(ch) {
    const c = ch.codePointAt(0);
    if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) return true;
    return /\p{P}/u.test(ch);
}

class WordPiece {
    constructor(vocabText) {
        this.vocab = new Map();
        String(vocabText).split('\n').forEach((t, i) => { const w = t.replace(/\r$/, ''); if (w && !this.vocab.has(w)) this.vocab.set(w, i); });
        this.unk = this.vocab.get('[UNK]'); this.cls = this.vocab.get('[CLS]'); this.sep = this.vocab.get('[SEP]');
    }
    basic(text) {
        let t = '';
        for (const ch of String(text)) {
            const c = ch.codePointAt(0);
            if (c === 0 || c === 0xfffd || (/\p{Cc}|\p{Cf}/u.test(ch) && !/[\t\n\r]/.test(ch))) continue;
            // CJK ideographs become words of their own, as in BERT
            if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x20000 && c <= 0x2A6DF) || (c >= 0xF900 && c <= 0xFAFF)) { t += ` ${ch} `; continue; }
            t += /\s/.test(ch) ? ' ' : ch;
        }
        t = t.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        const out = [];
        for (const word of t.split(/\s+/).filter(Boolean)) {
            let cur = '';
            for (const ch of word) {
                if (isBertPunct(ch)) { if (cur) out.push(cur); out.push(ch); cur = ''; } else cur += ch;
            }
            if (cur) out.push(cur);
        }
        return out;
    }
    wordpiece(word) {
        if ([...word].length > 100) return [this.unk];
        const ids = [];
        let start = 0;
        while (start < word.length) {
            let end = word.length, found = null;
            while (start < end) {
                const piece = (start > 0 ? '##' : '') + word.slice(start, end);
                if (this.vocab.has(piece)) { found = this.vocab.get(piece); break; }
                end--;
            }
            if (found === null) return [this.unk];
            ids.push(found);
            start = end;
        }
        return ids;
    }
    encode(text, maxLen) {
        const ids = [this.cls];
        for (const w of this.basic(text)) {
            for (const id of this.wordpiece(w)) { if (ids.length >= maxLen - 1) break; ids.push(id); }
            if (ids.length >= maxLen - 1) break;
        }
        ids.push(this.sep);
        return ids;
    }
}

// ---------------------------------------------------------------------------------------------------
// The network itself runs in the native engine since 0.5.0 (src/engine/model.js: ONNX Runtime, the model
// file models/phish-tiny/model.onnx made by TinyPhishLLM's training/export-onnx.py). This file keeps what comes before it:
// the input text (modelInputParts) and the tokenizer (WordPiece), the same as in training.
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// What the person is told. Never "safe": a low probability is "no strong signs found", and when the
// extension's own checks warn, they are named as the ones to trust. Text that vouches for itself is
// a warning however the model scored it. Returns { level: 'danger'|'caution'|'info', headline, note }.
// ---------------------------------------------------------------------------------------------------
function aiAdvice(result, extensionStatus, vouching) {
    const ownWarns = extensionStatus === 'flagged' || extensionStatus === 'caution';
    const keepOwn = ownWarns ? 'The extension\'s own checks also warn about this email; they rest on verified facts, so trust them over the model.' : '';
    const pct = Math.min(99, Math.round(((result && result.probability) || 0) * 100));   // no model is ever 100% sure
    const v = (vouching || []).sort((a, b) => b.weight - a.weight)[0];
    if (v && v.weight >= 5) return { level: 'danger', headline: 'This email tries to talk to AI tools and filters.', note: `${v.text} ${keepOwn}`.trim() };
    // A safety claim is only a small weight in the extension's own verdict: here it is mentioned when the
    // model warns anyway, and never makes a warning of its own.
    if (pct >= 85) return { level: 'danger', headline: `The model thinks this is likely phishing (${pct}%).`, note: `${v ? v.text + ' ' : ''}${keepOwn}`.trim() };
    if (pct >= 50) return { level: 'caution', headline: `The model finds this email suspicious (${pct}%).`, note: `${v ? v.text + ' ' : ''}${keepOwn}`.trim() };
    return { level: 'info', headline: `The model found no strong signs of phishing (${pct}%).`,
             note: keepOwn || 'That is an opinion, not a check: phishing can look ordinary. Still be careful with links, attachments and requests for money or passwords.' };
}

