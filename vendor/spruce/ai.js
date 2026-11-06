// ai.js — EXPERIMENT (branch llm_testing): the extension's own small language model reads an opened
// email and gives its opinion on whether it is phishing, and which sentences made it think so.
//
// The model (models/phish-tiny/) is a BERT-tiny classifier (2 layers, 4.4 million parameters, about
// 4.5 MB with 8-bit weights) that WE train: tools/ai/ generates the training emails, fine-tunes the
// model and exports it. It runs right here, in plain JavaScript (no WebAssembly, no download, nothing
// sent anywhere), in Chrome's service worker, Firefox's and Safari's background page, and in Node for
// the tests, which check it against PyTorch's own numbers (tests/fixtures/ai-vectors.json).
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
// The model's input: one text built from the email's facts. tools/ai/make-dataset.js builds its
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
// BERT forward pass in plain JavaScript. Weights come from model.bin as described by model.json:
// 8-bit tensors (one scale per row) are turned back into floats once, when the model loads.
// ---------------------------------------------------------------------------------------------------
function loadTensors(manifest, buffer) {
    const T = {};
    for (const t of manifest.tensors) {
        const n = t.shape.reduce((a, b) => a * b, 1);
        if (t.dtype === 'f32') T[t.name] = new Float32Array(buffer, t.offset, n);
        else if (t.dtype === 'i8') {
            const q = new Int8Array(buffer, t.offset, n), scales = new Float32Array(buffer, t.scales, t.shape[0]);
            const cols = n / t.shape[0], out = new Float32Array(n);
            for (let r = 0; r < t.shape[0]; r++) { const s = scales[r]; for (let c = 0; c < cols; c++) out[r * cols + c] = q[r * cols + c] * s; }
            T[t.name] = out;
        } else throw new Error(`unknown tensor type ${t.dtype}`);
    }
    return T;
}

// y[T×out] = x[T×in] · Wᵀ + b, with W stored [out×in] as in PyTorch.
function linear(x, T, inDim, W, b, outDim) {
    const y = new Float32Array(T * outDim);
    for (let t = 0; t < T; t++) {
        const xo = t * inDim, yo = t * outDim;
        for (let o = 0; o < outDim; o++) {
            let s = b[o];
            const wo = o * inDim;
            for (let k = 0; k < inDim; k++) s += x[xo + k] * W[wo + k];
            y[yo + o] = s;
        }
    }
    return y;
}

function layerNorm(x, T, H, g, b, eps) {
    for (let t = 0; t < T; t++) {
        const o = t * H;
        let m = 0; for (let i = 0; i < H; i++) m += x[o + i]; m /= H;
        let v = 0; for (let i = 0; i < H; i++) { const d = x[o + i] - m; v += d * d; } v /= H;
        const inv = 1 / Math.sqrt(v + eps);
        for (let i = 0; i < H; i++) x[o + i] = (x[o + i] - m) * inv * g[i] + b[i];
    }
    return x;
}

// erf to about 1e-7 (the Numerical Recipes erfc approximation; Abramowitz and Stegun 7.1.26 is too coarse).
function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.5 * x);
    const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return s * y;
}
const gelu = (x) => 0.5 * x * (1 + erf(x / Math.SQRT2));

class PhishModel {
    constructor(manifest, buffer, vocabText) {
        this.cfg = manifest.config;
        this.meta = manifest;
        this.W = loadTensors(manifest, buffer);
        this.tok = new WordPiece(vocabText);
    }
    // ids: token ids → [logit legitimate, logit phishing]
    forward(ids) {
        const { hidden: H, heads, layers, intermediate: I, eps } = this.cfg;
        const W = this.W, T = ids.length, dh = H / heads, P = 'bert.';
        let x = new Float32Array(T * H);
        const we = W[P + 'embeddings.word_embeddings.weight'], pe = W[P + 'embeddings.position_embeddings.weight'], te = W[P + 'embeddings.token_type_embeddings.weight'];
        for (let t = 0; t < T; t++) for (let i = 0; i < H; i++) x[t * H + i] = we[ids[t] * H + i] + pe[t * H + i] + te[i];
        layerNorm(x, T, H, W[P + 'embeddings.LayerNorm.weight'], W[P + 'embeddings.LayerNorm.bias'], eps);
        for (let l = 0; l < layers; l++) {
            const L = `${P}encoder.layer.${l}.`;
            const q = linear(x, T, H, W[L + 'attention.self.query.weight'], W[L + 'attention.self.query.bias'], H);
            const k = linear(x, T, H, W[L + 'attention.self.key.weight'], W[L + 'attention.self.key.bias'], H);
            const v = linear(x, T, H, W[L + 'attention.self.value.weight'], W[L + 'attention.self.value.bias'], H);
            const ctx = new Float32Array(T * H), scores = new Float32Array(T), scale = 1 / Math.sqrt(dh);
            for (let h = 0; h < heads; h++) {
                const ho = h * dh;
                for (let i = 0; i < T; i++) {
                    let max = -Infinity;
                    for (let j = 0; j < T; j++) {
                        let s = 0;
                        for (let d = 0; d < dh; d++) s += q[i * H + ho + d] * k[j * H + ho + d];
                        scores[j] = s * scale; if (scores[j] > max) max = scores[j];
                    }
                    let sum = 0;
                    for (let j = 0; j < T; j++) { scores[j] = Math.exp(scores[j] - max); sum += scores[j]; }
                    for (let j = 0; j < T; j++) {
                        const p = scores[j] / sum;
                        for (let d = 0; d < dh; d++) ctx[i * H + ho + d] += p * v[j * H + ho + d];
                    }
                }
            }
            const att = linear(ctx, T, H, W[L + 'attention.output.dense.weight'], W[L + 'attention.output.dense.bias'], H);
            for (let i = 0; i < att.length; i++) att[i] += x[i];
            layerNorm(att, T, H, W[L + 'attention.output.LayerNorm.weight'], W[L + 'attention.output.LayerNorm.bias'], eps);
            const mid = linear(att, T, H, W[L + 'intermediate.dense.weight'], W[L + 'intermediate.dense.bias'], I);
            for (let i = 0; i < mid.length; i++) mid[i] = gelu(mid[i]);
            const out = linear(mid, T, I, W[L + 'output.dense.weight'], W[L + 'output.dense.bias'], H);
            for (let i = 0; i < out.length; i++) out[i] += att[i];
            x = layerNorm(out, T, H, W[L + 'output.LayerNorm.weight'], W[L + 'output.LayerNorm.bias'], eps);
        }
        const pooled = linear(x.subarray(0, H), 1, H, W[P + 'pooler.dense.weight'], W[P + 'pooler.dense.bias'], H).map(Math.tanh);
        return Array.from(linear(pooled, 1, H, W['classifier.weight'], W['classifier.bias'], 2));
    }
    // How strongly the model leans to phishing (its two scores' difference), and as a probability.
    margin(text) { const [a, b] = this.forward(this.tok.encode(text, this.cfg.maxLen)); return b - a; }
    probability(text) { return 1 / (1 + Math.exp(-this.margin(text))); }
    // The opinion, and what made it: each sentence is scored on its own ("does this sentence alone read
    // like phishing?"), and so are the facts about the sender and links without the text. The ones
    // that lean furthest toward phishing are named. (Leaving sentences out one at a time says little
    // when an email repeats its tricks, which phishing usually does.)
    analyze(facts) {
        const parts = modelInputParts(facts);
        const m = this.margin(`${parts.head} text: ${parts.sentences.join(' ')}`);
        const p = 1 / (1 + Math.exp(-m));
        const reasons = [];
        if (p >= 0.5) {
            for (const s of parts.sentences.slice(0, 25)) {
                if (s.length < 12) continue;
                const w = this.margin(`text: ${s}`);
                if (w > 0) reasons.push({ sentence: s.slice(0, 200), weight: w });
            }
            const w = this.margin(`${parts.head} text:`);
            if (w > 0) reasons.push({ sentence: 'Who sent it, the sender check and where its links go', weight: w, facts: true });
        }
        reasons.sort((a, b) => b.weight - a.weight);
        return { probability: p, reasons: reasons.slice(0, 3), model: this.meta.name, version: this.meta.version };
    }
}

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

// The model, loaded once from the extension's own files (or handed in by the tests).
let phishModelPromise = null;
function loadPhishModel(readFile) {
    if (!phishModelPromise) {
        phishModelPromise = (async () => {
            const read = readFile || (async (path, kind) => {
                const res = await fetch(chrome.runtime.getURL(path));
                if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
                return kind === 'json' ? res.json() : kind === 'text' ? res.text() : res.arrayBuffer();
            });
            const [manifest, bin, vocab] = await Promise.all([read('models/phish-tiny/model.json', 'json'), read('models/phish-tiny/model.bin', 'bin'), read('models/phish-tiny/vocab.txt', 'text')]);
            return new PhishModel(manifest, bin, vocab);
        })().catch((e) => { phishModelPromise = null; throw e; });
    }
    return phishModelPromise;
}
