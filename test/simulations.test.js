'use strict';
// 0.5.44: phishing-training emails let through (Settings → Phishing training). Header rules need a secret value
// (kept only as a hash) or the vendor's sending addresses (the hop Gmail's own server wrote); link domains need
// every link to go there, and shared platforms are refused. Every address, token and email here is made up.
const test = require('node:test');
const assert = require('node:assert');
const spruce = require('../src/engine/spruce');
const sims = require('../src/simulations');
const { readMessage } = require('../src/engine/mime');
const { MemoryStore } = require('../src/store/memory');
const { Service } = require('../src/pipeline');
const { loadConfig } = require('../src/config');

const E = spruce.load();
const ORG = 'maple-schools.example', USER = `pat.reyes@${ORG}`;
const TOKEN = 'made-up-token-7f3a9c';
const raw = ({ headers = [], body = '<p>Your package is waiting.</p><p><a href="https://track.phish-vendor-training.example/p/123">Track it</a></p>' } = {}) => Buffer.from([
    ...headers, 'From: Parcel Service <notice@parcel-alerts.example>', `To: ${USER}`, 'Subject: Your package', 'Message-ID: <t1@parcel-alerts.example>',
    'Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass', 'Content-Type: text/html; charset=utf-8', '', body].join('\r\n'));
const received = (ip) => `Received: from mail.vendor-relay.example (mail.vendor-relay.example. [${ip}]) by mx.google.com with ESMTPS id x1; Thu, 12 Nov 2026 10:00:00 -0800`;

test('the rules as typed: a header alone is refused (public); a secret value is kept only as a hash; addresses checked', () => {
    assert.match(sims.ruleFrom({ header: 'X-PHISHTEST' }).error, /A header name alone is public/);
    assert.match(sims.ruleFrom({ header: 'X PHISH', value: 'x' }).error, /letters, digits and "-" only/);
    assert.match(sims.ruleFrom({ header: 'X-PHISHTEST', ips: '23.21.109.197\nnot-an-ip' }).error, /"not-an-ip" isn't an address or range/);
    const r = sims.ruleFrom({ name: 'KnowBe4', header: 'X-KB4TOKEN', value: TOKEN }).rule;
    assert.deepEqual([r.name, r.header, r.ips.length], ['KnowBe4', 'x-kb4token', 0]);
    assert.ok(/^[0-9a-f]{64}$/.test(r.valueHash) && !JSON.stringify(r).includes(TOKEN), 'never the token itself');
    assert.deepEqual(sims.ruleFrom({ header: 'X-TestPhish', ips: '192.0.2.10, 198.51.100.0/26 2001:db8::/32' }).rule.ips, ['192.0.2.10', '198.51.100.0/26', '2001:db8::/32']);
});

test('the link domains: only a vendor\'s own; shared platforms, shorteners, personal mail and big companies\' refused', () => {
    const d = sims.domainsFrom(E, 'phish-vendor-training.example\nhttps://www.Other-Training.example/x\n*.third-training.example\ndocs.google.com\nbit.ly\ngmail.com\nmybank.github.io\npaypal.com\nnot a domain');
    assert.deepEqual(d.domains, ['phish-vendor-training.example', 'www.other-training.example', 'third-training.example']);
    assert.deepEqual(d.refused.map(x => x.domain).sort(), ['bit.ly', 'docs.google.com', 'gmail.com', 'mybank.github.io', 'paypal.com']);
    assert.ok(d.refused.every(x => x.why));
    assert.deepEqual(d.invalid, ['not', 'a', 'domain']);
});

test('matching: the secret token; the vendor\'s address as Gmail\'s own server saw it (a forged lower line doesn\'t count); every link on the vendor\'s domains', async () => {
    const token = { rules: [sims.ruleFrom({ name: 'KnowBe4', header: 'X-KB4TOKEN', value: TOKEN }).rule], domains: [] };
    const m = async (r, st) => sims.matchTraining(E, await readMessage(r), st);
    assert.deepEqual(await m(raw({ headers: [`X-KB4TOKEN: ${TOKEN}`] }), token), { name: 'KnowBe4', by: 'header' });
    assert.equal(await m(raw({ headers: ['X-KB4TOKEN: someone-elses-guess'] }), token), null, 'a wrong token: checked as usual');
    assert.equal(await m(raw({}), token), null);
    const byIp = { rules: [sims.ruleFrom({ name: 'Wizer', header: 'X-TestPhish', ips: '192.0.2.0/24' }).rule], domains: [] };
    assert.equal((await m(raw({ headers: [received('192.0.2.44'), 'X-TestPhish: 1'] }), byIp)).name, 'Wizer');
    assert.equal(await m(raw({ headers: [received('203.0.113.9'), 'X-TestPhish: 1'] }), byIp), null, 'another sender');
    // A phisher writes a Received line of its own below Gmail's: only the line by mx.google.com counts.
    assert.equal(await m(raw({ headers: [received('203.0.113.9'), 'Received: from x ([192.0.2.44]) by mx.google.com; forged', 'X-TestPhish: 1'] }), byIp), null);
    assert.equal(await m(raw({ headers: ['X-TestPhish: 1'] }), byIp), null, 'no hop by Gmail (put in directly): addresses can\'t match');
    const dom = { rules: [], domains: ['phish-vendor-training.example'] };
    assert.deepEqual(await m(raw({}), dom), { name: 'links to phish-vendor-training.example', by: 'links' });
    assert.equal(await m(raw({ body: '<a href="https://track.phish-vendor-training.example/p">Track</a> <a href="https://evil-login.example/x">Sign in</a>' }), dom), null, 'one link elsewhere: checked');
    assert.equal(await m(raw({ body: 'No links here.' }), dom), null);
    assert.equal(await m(raw({ body: '<a href="https://phish-vendor-training.example.evil.example/x">x</a>' }), dom), null, 'a look-alike doesn\'t match');
});

test('in the service: a training email is let through unchecked, counted, never recorded; changes need nothing but the admin\'s action and are noted', async () => {
    const store = new MemoryStore();
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER, MODE: 'enforce' });
    const gmail = { modified: [], labelId: async (u, n) => `L_${n}`, modify: async (...a) => { gmail.modified.push(a); return {}; }, threadSize: async () => 1 };
    const svc = new Service({ cfg, store, gmail, log: { error() {}, warn() {} } });
    const by = `it.director@${ORG}`;
    assert.equal((await svc.addTrainingRule({ header: 'X-PHISHTEST' }, by)).status, 400);
    assert.deepEqual(await svc.addTrainingRule({ name: 'KnowBe4', header: 'X-KB4TOKEN', value: TOKEN }, by), { ok: true });
    assert.ok(!JSON.stringify(await store.getState('phishTraining')).includes(TOKEN), 'the token isn\'t kept');
    // A training email that the checks would flag (a credential lure): let through, nothing moved or recorded.
    const lure = raw({ headers: [`X-KB4TOKEN: ${TOKEN}`], body: '<p>Your mailbox is full. Verify your password now or lose access.</p><a href="https://login-verify-account.example/x">Verify</a>' });
    const out = await svc.judge(USER, { id: 'k1', threadId: 't1', internalDate: Date.now() }, await readMessage(lure));
    assert.deepEqual(out, { user: USER, messageId: 'k1', action: 'none', training: 'KnowBe4' });
    assert.equal(gmail.modified.length, 0);
    assert.equal((await store.listRecords({})).length, 0);
    const day = svc.dayOf(Date.now());
    assert.equal((await store.getStats(day, day))[0].training, 1);
    // Check an email says so.
    const pasted = await svc.checkPasted(lure.toString('utf8'), { by });
    assert.equal(pasted.training, 'KnowBe4');
    assert.equal(pasted.action, 'none');
    assert.match(pasted.why, /phishing-training email \(KnowBe4\): let through unchecked/);
    // Domains: refused ones say why; good ones saved.
    assert.match((await svc.setTrainingDomains('docs.google.com', by)).error, /Never a training domain: docs\.google\.com/);
    assert.deepEqual(await svc.setTrainingDomains('phish-vendor-training.example', by), { ok: true });
    // Removing everything turns it off.
    const id = (await store.getState('phishTraining')).rules[0].id;
    await svc.removeTrainingRule(id, by);
    await svc.setTrainingDomains('', by);
    assert.equal(await store.getState('phishTraining'), null);
    const notes = (await store.listEvents(0)).filter(e => e.admin).map(e => e.text);
    assert.ok(notes.some(t => /added the phishing-training rule "KnowBe4" \(header X-KB4TOKEN, with a secret value\)/.test(t)));
    assert.ok(notes.some(t => /removed the phishing-training rule "KnowBe4"/.test(t)));
    assert.ok(notes.every(t => !t.includes(TOKEN)));
});
