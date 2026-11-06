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
