'use strict';
// The engine: the extension's checks and model on raw emails. All emails here are made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readHtml } = require('../src/engine/html');
const { readMessage, receiverAuth } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const CTX = { mailbox: 'reader@maple-schools.example', orgDomains: ['maple-schools.example'] };

test('a fake storage notice (DMARC fail, sender named after the reader, filler after a blank gap) is flagged and the AI agrees', async () => {
    const facts = await readMessage(fixture('phish-storage.eml'));
    assert.deepEqual(facts.layout, ['text after a large blank gap']);
    assert.equal(facts.auth.dmarc, 'fail');
    assert.doesNotMatch(facts.visibleText, /regalia/, 'the filler is not part of what the reader sees');
    const r = await analyze(facts, Object.assign({ firstTime: true }, CTX));
    assert.equal(r.status, 'flagged');
    assert.ok(r.score >= 5, String(r.score));
    for (const kind of ['hidden-filler', 'outside-org', 'first-time']) assert.ok(r.signals.some(s => s.kind === kind), kind);
    assert.ok(r.signals.some(s => /DMARC/.test(s.text)));
    assert.ok(r.signals.some(s => /your own mailbox name/.test(s.text)));
    assert.ok(r.ai.probability > 0.85, String(r.ai.probability));
});

test('a genuine newsletter (DMARC pass, hidden preheader, its own links) stays clean', async () => {
    const r = await analyze(await readMessage(fixture('genuine-newsletter.eml')), CTX);
    assert.equal(r.status, 'clean');
    assert.ok(r.ai.probability < 0.5, String(r.ai.probability));
    assert.ok(!r.signals.some(s => s.weight >= 3), JSON.stringify(r.signals));
});

test('only the receiving server\'s own verification results count (a sender can add its own header)', () => {
    const head = 'Authentication-Results: evil.example; dmarc=pass header.from=bank.example\r\nAuthentication-Results: mx.google.com;\r\n dkim=none; spf=fail smtp.mailfrom=x@evil.example; dmarc=fail header.from=bank.example';
    assert.deepEqual(receiverAuth(head), { dmarc: 'fail', spf: 'fail', dkim: 'none', arc: null, headerFrom: 'bank.example' });
    assert.equal(receiverAuth('Authentication-Results: evil.example; dmarc=pass'), null);
});

test('HTML reading: hidden text, filler after a gap, pictures only, quoted history, links', () => {
    const r = readHtml(`<div style="display:none">Preheader text that hides here</div><p>Hello <b>there</b>.</p>
        <p style="font-size:0px">tiny hidden words</p><p style="opacity:0">invisible</p><span hidden>gone</span>
        <a href="https://a.example/x">Visible link</a><a href="javascript:alert(1)">Click</a>
        <blockquote>On Monday someone wrote: old text <a href="https://quoted.example/">old link</a></blockquote>
        <style>p { color: red }</style><script>evil()</script>`);
    assert.match(r.visibleText, /Hello there\./);
    for (const t of ['Preheader', 'tiny hidden', 'invisible', 'gone', 'old text', 'evil', 'color: red']) assert.doesNotMatch(r.visibleText, new RegExp(t), t);
    assert.match(r.hiddenText, /tiny hidden words/);
    assert.match(r.quotedText, /old text/);
    assert.deepEqual(r.links.map(l => l.href), ['https://a.example/x', 'javascript:alert(1)'], 'links in quoted history are not judged');
    assert.deepEqual(r.layout, []);
    const gap = readHtml(`<p>Short lure.</p><div style="height:3000px"></div><p>${'Unrelated filler text from an old forum post. '.repeat(6)}</p>`);
    assert.deepEqual(gap.layout, ['text after a large blank gap']);
    assert.equal(gap.visibleText, 'Short lure.');
    assert.deepEqual(readHtml(`<p>Lure.</p><div style="height:3000px"></div><p>Short.</p>`).layout, [], 'too little after the gap to be filler');
    assert.deepEqual(readHtml(`<table><tr><td height="1200">Real content in a tall cell</td></tr></table>`).layout, [], 'a tall cell with text is not a spacer');
    const pics = readHtml(`<span style="display:none">Apply today for a card!</span><a href="https://x.example/"><img src="a.jpg" width="600"></a><img src="p.gif" width="1" height="1">`);
    assert.deepEqual(pics.layout, ['images only']);
    assert.match(pics.visibleText, /Apply today for a card!/, 'the hidden preheader is what a picture-only email says');
    assert.equal(pics.pictures, 1, 'a tracking pixel is not a picture');
});

test('a link that runs code counts as dangerous; a look-alike domain too', async () => {
    const facts = await readMessage(Buffer.from([
        'From: "PayPal" <service@paypa1-secure.example>', 'To: reader@maple-schools.example', 'Subject: Account limited',
        'Authentication-Results: mx.google.com; dmarc=none header.from=paypa1-secure.example', 'Content-Type: text/html', '',
        '<p>Your account is limited.</p><a href="https://paypa1.com/verify">Restore access</a> <a href="javascript:steal()">Details</a>'].join('\r\n')));
    const r = await analyze(facts, CTX);
    assert.equal(r.status, 'flagged');
    const links = r.signals.find(s => s.kind === 'dangerous-links');
    assert.ok(links && links.weight === 5, JSON.stringify(r.signals));
    assert.ok(r.links.some(l => /look-alike/.test(l.reason)));
    assert.ok(r.links.some(l => /runs code/.test(l.reason)));
});

test('allowlisted senders are "trusted": never escalated, whatever the checks find', async () => {
    const r = await analyze(await readMessage(fixture('phish-storage.eml')), Object.assign({ trusted: true }, CTX));
    assert.equal(r.status, 'trusted');
});

test('the model (0.4.0): a pass\'s answer is remembered by a hash of its input, so identical copies cost one pass; the answer is the same', async () => {
    const E = require('../src/engine/spruce').load();
    const session = await E.model.ready();
    let runs = 0;
    const run = session.run.bind(session);
    session.run = (...a) => { runs++; return run(...a); };
    try {
        const text = 'from: billing@harbor-supply-invoices.example text: Our bank details have changed; please update the account number on file and pay today. ' + Math.random();
        const a = await E.model.margin(text), b = await E.model.margin(text);
        assert.equal(runs, 1, 'the second copy costs no pass');
        assert.equal(a, b);
        await E.model.margin(text + ' (another one)');
        assert.equal(runs, 2);
    } finally { session.run = run; }
});

// The reference: 400 made-up inputs, their token ids, and the model's answers as tools/export-onnx.py
// computes them from model.bin in numpy, without ONNX (for phish-tiny 0.11.0 they agreed with the
// JavaScript engine of 0.4.1 to 1.2e-6). A new model gets new answers from tools/export-onnx.py
// --reference (docs/RETRAINING.md, step 7).
test('the native engine (0.5.0): the same answers as an independent computation of the model, on 400 made-up inputs; one at a time or in a batch', async () => {
    const E = require('../src/engine/spruce').load();
    const ref = require('./fixtures/model-reference.json');
    assert.equal(ref.model, E.modelInfo.version, 'the reference is for this model (a new model: python3 tools/export-onnx.py <folder> --reference test/fixtures/model-reference.json)');
    ref.cases.forEach((c, i) => assert.deepEqual(E.model.tok.encode(c.text, E.model.cfg.maxLen), c.ids, `case ${i}: the tokenizer's ids`));
    const { Model } = require('../src/engine/model');
    // (a fresh model: nothing remembered from the other tests)
    const fresh = new Model({ file: E.model.file, manifest: E.model.meta, tokenizer: E.model.tok, modelInputParts: E.model.parts });
    const one = [];
    for (const c of ref.cases) one.push(await fresh.margin(c.text));
    let worst = 0, flips = 0;
    ref.cases.forEach((c, i) => {
        worst = Math.max(worst, Math.abs(one[i] - c.margin));
        const p0 = 1 / (1 + Math.exp(-c.margin)), p1 = 1 / (1 + Math.exp(-one[i]));
        for (const line of [0.5, 0.65, 0.9]) if ((p0 >= line) !== (p1 >= line)) flips++;
    });
    assert.ok(worst < 1e-4, `largest difference ${worst}`);
    assert.equal(flips, 0, 'no email changes side of the 50%, 65% or 90% line');
    // In one batch (padded): the same as one at a time.
    const batched = new Model({ file: E.model.file, manifest: E.model.meta, tokenizer: E.model.tok, modelInputParts: E.model.parts });
    const all = await batched.margins_(ref.cases.slice(0, 64).map(c => c.text));
    all.forEach((m, i) => assert.ok(Math.abs(m - one[i]) < 1e-4, `case ${i}: ${m} vs ${one[i]}`));
});
