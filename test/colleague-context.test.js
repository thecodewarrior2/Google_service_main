'use strict';
// 0.5.43: a colleague's name on an outside address counts only when the email claims to be from inside the
// organization. A vendor's employee who shares a name with someone in the district, writing a greeting from
// her company's own address, is no impersonation. Every name, address and email here is made up.
const test = require('node:test');
const assert = require('node:assert');
const spruce = require('../src/engine/spruce');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');

const E = spruce.load();
const ORG = 'maple-schools.example', USER = `pat.reyes@${ORG}`;
const colleagues = new Set([E.colleagueNameHash('Misty Hollins')]);
const mail = ({ from = 'Misty Hollins <misty.hollins@learnbridge-vendor.example>', subject = 'Hello from LearnBridge', body = 'Hi Pat, I hope your week is going well. It was nice meeting you at the conference. Talk soon, Misty', dmarc = 'pass', extra = [] } = {}) =>
    readMessage(Buffer.from([`From: ${from}`, `To: ${USER}`, `Subject: ${subject}`, 'Message-ID: <c1@learnbridge-vendor.example>', ...extra,
        `Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=${dmarc}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')));
const sign = async (opts, ctx = {}) => {
    const r = await analyze(await mail(opts), Object.assign({ mailbox: USER, orgDomains: [ORG], colleagues }, ctx));
    return r.signals.find(s => s.kind === 'sender-colleague-name' || s.kind === 'sender-name-shared') || null;
};

test('a vendor\'s employee sharing a colleague\'s name, writing a greeting from her company\'s own address: shown, not counted', async () => {
    const s = await sign({});
    assert.deepEqual([s.kind, s.weight], ['sender-name-shared', 0]);
    assert.match(s.text, /same name as someone in your organization, writing from learnbridge-vendor\.example's own address\. Nothing in the email claims to be from inside your organization, so it doesn't count/);
    assert.equal(await sign({}, { colleagues: null }), null, 'without the directory\'s names: nothing');
});

test('it counts (3) when the email claims to be from inside, and says how', async () => {
    const cases = [
        [{ from: 'Misty Hollins <misty.hollins.1975@gmail.com>' }, /from a personal email account/],
        [{ from: 'Misty Hollins <misty@maple-schools-k12.example>' }, /imitating your organization's domain/],
        [{ dmarc: 'fail' }, /Gmail's sender check failed/],
        [{ extra: ['Reply-To: misty.h@quickmail-box.example'] }, /replies going to another address \(misty\.h@quickmail-box\.example\)/],
        [{ from: '"Misty Hollins, Principal" <misty.hollins@learnbridge-vendor.example>' }, /title or your organization's name in the sender's name/],
        [{ from: 'Misty Hollins - Maple Schools <misty.hollins@learnbridge-vendor.example>' }, /title or your organization's name/],
        [{ subject: 'Quick favor', body: 'Are you available? I am in a meeting and need a quick favor. Text me your cell number.' }, /asking for what impersonators ask/],
        [{ subject: 'Update', body: 'Please update my direct deposit to the new bank account before Friday.' }, /asking for what impersonators ask/]
    ];
    for (const [opts, re] of cases) {
        const s = await sign(opts);
        assert.deepEqual([s.kind, s.weight], ['sender-colleague-name', 3], JSON.stringify(opts));
        assert.match(s.text, /^The sender uses the name of someone in your organization, but writes from an outside address \(/);
        assert.match(s.text, re, JSON.stringify(opts));
    }
});

test('the rest of the checks are unchanged: the vendor\'s greeting is clean; the impersonation is still caught', async () => {
    const clean = await analyze(await mail({}), { mailbox: USER, orgDomains: [ORG], colleagues });
    assert.equal(clean.status, 'clean', JSON.stringify(clean.signals));
    const fake = await analyze(await mail({ from: 'Misty Hollins <misty.hollins.1975@gmail.com>', subject: 'Are you available?', body: 'Are you available? I am in a meeting and need a quick favor. Reply with your cell number.' }), { mailbox: USER, orgDomains: [ORG], colleagues });
    assert.ok(fake.score >= 3, JSON.stringify(fake.signals.map(s => [s.kind, s.weight])));
});
