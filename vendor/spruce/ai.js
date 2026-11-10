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
// Two tokens × four outputs per sweep over k: each x[k] and W[o][k] is read once for eight products, and
// the eight sums don't wait on each other (one sum alone waits on each addition). Each output is still
// added up in the same order (bias, then k = 0, 1, …), in doubles, so the result is the same to the bit
// as the plain loop's (0.4.0; about 3× faster).
function linear(x, T, inDim, W, b, outDim) {
    const y = new Float32Array(T * outDim);
    let t = 0;
    for (; t + 1 < T; t += 2) {
        const xa = t * inDim, xb = xa + inDim, ya = t * outDim, yb = ya + outDim;
        let o = 0;
        for (; o + 3 < outDim; o += 4) {
            const w0 = o * inDim, w1 = w0 + inDim, w2 = w1 + inDim, w3 = w2 + inDim;
            let a0 = b[o], a1 = b[o + 1], a2 = b[o + 2], a3 = b[o + 3];
            let c0 = a0, c1 = a1, c2 = a2, c3 = a3;
            for (let k = 0; k < inDim; k++) {
                const u = x[xa + k], v = x[xb + k];
                const p0 = W[w0 + k], p1 = W[w1 + k], p2 = W[w2 + k], p3 = W[w3 + k];
                a0 += u * p0; a1 += u * p1; a2 += u * p2; a3 += u * p3;
                c0 += v * p0; c1 += v * p1; c2 += v * p2; c3 += v * p3;
            }
            y[ya + o] = a0; y[ya + o + 1] = a1; y[ya + o + 2] = a2; y[ya + o + 3] = a3;
            y[yb + o] = c0; y[yb + o + 1] = c1; y[yb + o + 2] = c2; y[yb + o + 3] = c3;
        }
        for (; o < outDim; o++) {
            const wo = o * inDim;
            let a = b[o], c = a;
            for (let k = 0; k < inDim; k++) { const w = W[wo + k]; a += x[xa + k] * w; c += x[xb + k] * w; }
            y[ya + o] = a; y[yb + o] = c;
        }
    }
    for (; t < T; t++) {
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
// gelu over a whole layer, with erf written out in the loop: the same operations in the same order as
// gelu(x) above (the same result to the bit), without a function call per value, which V8 didn't make
// cheap (it was 40% of a pass; 0.4.0).
const fround = Math.fround;
function geluInPlace(a) {
    const r2 = Math.SQRT2;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], z = x / r2, ax = z < 0 ? -z : z, sg = z < 0 ? -1 : 1;
        const t = 1 / (1 + 0.5 * ax);
        const y = 1 - t * Math.exp(-ax * ax - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
            t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
        a[i] = 0.5 * x * (1 + sg * y);
    }
    return a;
}

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
                    const qi = i * H + ho;
                    // Four scores at a time (each added up in the same order as one alone: the same result).
                    let j = 0;
                    for (; j + 3 < T; j += 4) {
                        const k0 = j * H + ho, k1 = k0 + H, k2 = k1 + H, k3 = k2 + H;
                        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
                        for (let d = 0; d < dh; d++) { const u = q[qi + d]; s0 += u * k[k0 + d]; s1 += u * k[k1 + d]; s2 += u * k[k2 + d]; s3 += u * k[k3 + d]; }
                        scores[j] = s0 * scale; scores[j + 1] = s1 * scale; scores[j + 2] = s2 * scale; scores[j + 3] = s3 * scale;
                        if (scores[j] > max) max = scores[j];
                        if (scores[j + 1] > max) max = scores[j + 1];
                        if (scores[j + 2] > max) max = scores[j + 2];
                        if (scores[j + 3] > max) max = scores[j + 3];
                    }
                    for (; j < T; j++) {
                        let s = 0;
                        for (let d = 0; d < dh; d++) s += q[qi + d] * k[j * H + ho + d];
                        scores[j] = s * scale; if (scores[j] > max) max = scores[j];
                    }
                    let sum = 0;
                    for (let j = 0; j < T; j++) { scores[j] = Math.exp(scores[j] - max); sum += scores[j]; }
                    // Four positions at a time, rounded to float32 after each addition as storing in ctx
                    // does (the same result to the bit, with fewer loads and stores).
                    let jj = 0;
                    for (; jj + 3 < T; jj += 4) {
                        const p0 = scores[jj] / sum, p1 = scores[jj + 1] / sum, p2 = scores[jj + 2] / sum, p3 = scores[jj + 3] / sum;
                        const v0 = jj * H + ho, v1 = v0 + H, v2 = v1 + H, v3 = v2 + H;
                        for (let d = 0; d < dh; d++) {
                            let c = ctx[qi + d];
                            c = fround(c + p0 * v[v0 + d]); c = fround(c + p1 * v[v1 + d]); c = fround(c + p2 * v[v2 + d]);
                            ctx[qi + d] = c + p3 * v[v3 + d];
                        }
                    }
                    for (let j = jj; j < T; j++) {
                        const p = scores[j] / sum, vj = j * H + ho;
                        for (let d = 0; d < dh; d++) ctx[qi + d] += p * v[vj + d];
                    }
                }
            }
            const att = linear(ctx, T, H, W[L + 'attention.output.dense.weight'], W[L + 'attention.output.dense.bias'], H);
            for (let i = 0; i < att.length; i++) att[i] += x[i];
            layerNorm(att, T, H, W[L + 'attention.output.LayerNorm.weight'], W[L + 'attention.output.LayerNorm.bias'], eps);
            const mid = linear(att, T, H, W[L + 'intermediate.dense.weight'], W[L + 'intermediate.dense.bias'], I);
            geluInPlace(mid);
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
