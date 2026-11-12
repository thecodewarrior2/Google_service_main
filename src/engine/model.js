'use strict';
// The AI model, phish-tiny (a BERT-tiny classifier, 4.4 million parameters), run by the native engine:
// ONNX Runtime (onnxruntime-node, MIT), from models/phish-tiny/model.onnx (made from model.bin by
// TinyPhishLLM's training/export-onnx.py, synced by tools/sync-model.js). About 25× faster than the plain JavaScript that ran it until 0.4.1: about 6 ms for a
// 256-token pass instead of 146 ms, with the same answers to rounding (test/engine.test.js holds them to
// the JavaScript engine's own, on a reference set).
//
// The input text and the tokens come from ai.js (modelInputParts, WordPiece), as in training. The
// engine runs at the "basic" level of graph optimization: the higher levels turn the 8-bit weights into
// 8-bit arithmetic, which changes the answers (by up to 0.36 in the margin); basic keeps them, and is as
// fast at full length. One thread, no spinning: a Cloud Run instance has one vCPU, and the event loop
// gets it back between passes (each takes milliseconds).
const crypto = require('crypto');
const path = require('path');

// Two made-up emails for the self-check when the engine starts (Status → Service status): it must score the
// first as phishing and the second as genuine (both sides of 50%).
const CHECK_PHISHING = 'subject: Your password expires today. from: "Mail Administrator" at mail-account-verify.example (outside your organization). sender check: dmarc fail. links: "Keep my password" goes to mail-account-verify.example (warning: the site was registered 3 days ago). text: Dear user, your password expires in 2 hours. Click below to keep your current password, or your mailbox will be closed today.';
const CHECK_GENUINE = 'subject: Field trip permission slips. from: "Amy Foster" at maple-schools.example (your organization). sender check: dmarc pass. text: Hi all, please send the signed permission slips for Friday\'s field trip back to the office by Thursday. Thanks!';
const runtimeVersion = () => { try { return require('onnxruntime-node/package.json').version; } catch (e) { return ''; } };
const MARGINS_KEPT = 50000;   // answers remembered per instance, by a hash of the input (campaign copies, shared sentences)
const BATCH = 32;             // texts in one run at most (the explanation passes of one email: up to 26)

class Model {
    constructor({ file, manifest, tokenizer, modelInputParts, ort = null }) {
        this.file = file; this.meta = manifest; this.cfg = manifest.config;
        this.tok = tokenizer; this.parts = modelInputParts;
        this.ort = ort; this.session = null; this.margins = new Map();
        // For Status: not loaded, loading, ready or failed; when, how long, why; the self-check's scores.
        this.state = 'not loaded'; this.loadedAt = null; this.loadMs = null; this.error = null; this.check = null;
    }
    // The session, made once (about 100 ms); server.js asks for it at start, so the first email doesn't wait.
    ready() {
        if (!this.session) {
            const started = Date.now();
            this.state = 'loading';
            try { this.ort = this.ort || require('onnxruntime-node'); }
            catch (e) { this.state = 'failed'; this.error = String(e && e.message || e).slice(0, 300); return Promise.reject(e); }
            this.session = this.ort.InferenceSession.create(this.file, {
                graphOptimizationLevel: 'basic', intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
                extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } }
            }).then((s) => { this.state = 'ready'; this.loadedAt = Date.now(); this.loadMs = this.loadedAt - started; this.error = null; return s; },
                (e) => { this.session = null; this.state = 'failed'; this.error = String(e && e.message || e).slice(0, 300); throw e; });
        }
        return this.session;
    }
    // How strongly the model leans to phishing (its phishing score minus its genuine score) for each text,
    // in one run per BATCH (shorter texts padded, the padding never attended to).
    async margins_(texts) {
        const out = new Array(texts.length);
        const todo = [];
        texts.forEach((t, i) => {
            const k = crypto.createHash('sha256').update(String(t)).digest('base64');
            const hit = this.margins.get(k);
            if (hit !== undefined) { this.margins.delete(k); this.margins.set(k, hit); out[i] = hit; }
            else todo.push({ i, k, ids: this.tok.encode(String(t), this.cfg.maxLen) });
        });
        const session = todo.length ? await this.ready() : null;
        for (let s = 0; s < todo.length; s += BATCH) {
            const part = todo.slice(s, s + BATCH), B = part.length, T = Math.max(...part.map(x => x.ids.length));
            const ids = new BigInt64Array(B * T), mask = new Float32Array(B * T);
            part.forEach((x, b) => { for (let t = 0; t < x.ids.length; t++) { ids[b * T + t] = BigInt(x.ids[t]); mask[b * T + t] = 1; } });
            const res = await session.run({ input_ids: new this.ort.Tensor('int64', ids, [B, T]), attention_mask: new this.ort.Tensor('float32', mask, [B, T]) });
            const l = res.logits.data;
            part.forEach((x, b) => {
                const m = l[b * 2 + 1] - l[b * 2];
                out[x.i] = m;
                if (this.margins.size >= MARGINS_KEPT) this.margins.delete(this.margins.keys().next().value);
                this.margins.set(x.k, m);
            });
        }
        return out;
    }
    // The self-check (once per instance, when it starts): two made-up emails scored, which must fall on
    // either side of 50%. Never throws: the result says what happened.
    async selfCheck() {
        const t = Date.now();
        try {
            const [a, b] = await this.margins_([CHECK_PHISHING, CHECK_GENUINE]);
            const phishing = 1 / (1 + Math.exp(-a)), genuine = 1 / (1 + Math.exp(-b));
            this.check = { ok: Number.isFinite(a) && Number.isFinite(b) && phishing >= 0.5 && genuine < 0.5, phishing, genuine, ms: Date.now() - t };
        } catch (e) { this.check = { ok: false, error: String(e && e.message || e).slice(0, 300), ms: Date.now() - t }; }
        return this.check;
    }
    // What Status shows about the engine here.
    status() {
        return { model: `${this.meta.name} ${this.meta.version}`, runtime: `ONNX Runtime ${runtimeVersion()}`.trim(), optimization: 'basic', threads: 1,
            state: this.state, loadedAt: this.loadedAt, loadMs: this.loadMs, error: this.error, check: this.check };
    }
    async margin(text) { return (await this.margins_([text]))[0]; }
    async probability(text) { return 1 / (1 + Math.exp(-(await this.margin(text)))); }
    // The opinion, and what made it: each sentence is scored on its own ("does this sentence alone read
    // like phishing?"), and so are the facts about the sender and links without the text; the ones that
    // lean furthest toward phishing are named. Only when the email reads as phishing (50% or more), and
    // then all in one run.
    async analyze(facts) {
        const parts = this.parts(facts);
        const [m] = await this.margins_([`${parts.head} text: ${parts.sentences.join(' ')}`]);
        const p = 1 / (1 + Math.exp(-m));
        const reasons = [];
        if (p >= 0.5) {
            const sentences = parts.sentences.slice(0, 25).filter(s => s.length >= 12);
            const ws = await this.margins_([...sentences.map(s => `text: ${s}`), `${parts.head} text:`]);
            sentences.forEach((s, i) => { if (ws[i] > 0) reasons.push({ sentence: s.slice(0, 200), weight: ws[i] }); });
            const w = ws[sentences.length];
            if (w > 0) reasons.push({ sentence: 'Who sent it, the sender check and where its links go', weight: w, facts: true });
        }
        reasons.sort((a, b) => b.weight - a.weight);
        return { probability: p, reasons: reasons.slice(0, 3), model: this.meta.name, version: this.meta.version };
    }
    // What the model read, sentence by sentence, for a person deciding (the dashboard's "show more"): the
    // facts line (subject, sender, sender check, links, layout) and each sentence of the text, each scored on
    // its own as in analyze (a margin above 0 leans toward phishing), up to max sentences, in order.
    // Filler (blank lines of invisible characters, lone punctuation, a word of one or two letters) is
    // read by the model as it comes, but marked filler: not shown, never what weighed most, and skipped
    // when finding the sentence before and after one that did (weighed: up to 3, in the text's order).
    async reading(facts, max = 40) {
        const parts = this.parts(facts);
        const [m] = await this.margins_([`${parts.head} text: ${parts.sentences.join(' ')}`]);
        const sentences = parts.sentences.slice(0, max);
        const ws = await this.margins_([...sentences.map(s => `text: ${s}`), `${parts.head} text:`]);
        const all = parts.sentences.map(s => ({ text: shownText(s), filler: !hasText(s) }));
        const near = (i, step) => { for (let j = i + step; j >= 0 && j < all.length; j += step) if (!all[j].filler) return { index: j, text: all[j].text }; return null; };
        const weighed = sentences.map((s, i) => [ws[i], i]).filter(([w, i]) => w > 0 && !all[i].filler)
            .sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i).sort((a, b) => a - b)
            .map(i => ({ index: i, before: near(i, -1), after: near(i, 1) }));
        return { probability: 1 / (1 + Math.exp(-m)), model: this.meta.name, version: this.meta.version,
                 head: parts.head, headWeight: ws[sentences.length],
                 sentences: sentences.map((s, i) => ({ text: all[i].text, weight: ws[i], filler: all[i].filler })),
                 weighed, more: Math.max(0, parts.sentences.length - sentences.length) };
    }
}

// Characters that show as nothing: zero-width and joiners, the grapheme joiner, soft hyphens, Hangul fillers,
// byte-order marks (mailing lists pad their preview text with them).
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\u2800]/gu;
// A sentence as a person would read it: without the invisible characters, spaces collapsed.
function shownText(s) { return String(s || '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(); }
// Real text: at least 3 letters or digits, and a word of 2 letters or more (not blank, not lone
// punctuation, dashes or bullets, not a stray letter or number, not only what replaced an address or a
// number: "phone number.").
function hasText(s) {
    const t = shownText(s).replace(/\b(?:address at [a-z0-9.-]+|phone number|number)\b/gi, '');
    return (t.match(/[\p{L}\p{N}]/gu) || []).length >= 3 && /\p{L}{2}/u.test(t);
}

function loadModel({ dir, manifest, tokenizer, modelInputParts }) {
    return new Model({ file: path.join(dir, 'model.onnx'), manifest, tokenizer, modelInputParts });
}

module.exports = { Model, loadModel, hasText, shownText, MARGINS_KEPT, CHECK_PHISHING, CHECK_GENUINE };
