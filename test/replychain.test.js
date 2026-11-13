'use strict';
// 0.5.33: a fake reply chain ("RE:" from outside or a new sender, answering nothing this mailbox has) counts
// in the rules' score; and the optional Suspicious label (off by default). Every address and email is made up.
const test = require('node:test');
const assert = require('node:assert');
const { fakeReplySigns, looksLikeReply } = require('../src/engine/replychain');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');

const ORG = 'maple-schools.example', USER = `reader@${ORG}`;
const DAY = 24 * 3600 * 1000;
const cfgOf = (env = {}) => loadConfig(Object.assign({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER, FIRST_SEEN_LEARNING_DAYS: '0' }, env));
const mail = ({ subject, from = 'Alex Turner <alex.turner@harbor-supply.example>', head = [], body = 'Hi, following up on the below. The updated remittance details are attached; please confirm today. Thanks, Alex' }) => Buffer.from([`From: ${from}`, `To: ${USER}`, `Subject: ${subject}`, 'Message-ID: <r1@harbor-supply.example>',
    'Authentication-Results: mx.google.com; dkim=pass header.i=@harbor-supply.example; spf=pass; dmarc=pass header.from=harbor-supply.example', ...head,
    'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'));

test('what looks like a reply, in several languages, after an [EXTERNAL] tag; what doesn\'t', () => {
    for (const s of ['RE: Invoice 4471', 'Re: Re: lunch', '[EXTERNAL] RE: payroll update', 'AW: Rechnung', 'SV: faktura', 'Antw: offerte', 'RIF: fattura', 'RES: pagamento', 'Re[2]: notes'])
        assert.equal(looksLikeReply(s), true, s);
    for (const s of ['Invoice 4471', 'Regarding your account', 'Fwd: notes', 'Reminder: meeting', 'Re-enrollment form']) assert.equal(looksLikeReply(s), false, s);
});

test('a reply naming no earlier email, or one this mailbox doesn\'t have, from outside or a new sender: a sign of 2', () => {
    const facts = (extra = {}) => Object.assign({ subject: 'RE: Invoice 4471', inReplyTo: '', references: [] }, extra);
    assert.deepEqual(fakeReplySigns(facts(), { outside: true }).map(s => [s.kind, s.weight]), [['fake-reply', 2]]);
    assert.match(fakeReplySigns(facts(), { outside: true })[0].text, /doesn't answer any email: none is named in its headers/);
    const named = facts({ inReplyTo: '<a1@harbor-supply.example>' });
    assert.deepEqual(fakeReplySigns(named, { outside: true, threadSize: 1 }).map(s => s.kind), ['fake-reply']);
    assert.match(fakeReplySigns(named, { outside: true, threadSize: 1 })[0].text, /this mailbox has no earlier email in that conversation/);
    assert.deepEqual(fakeReplySigns(named, { outside: true, threadSize: 3 }), [], 'a real conversation');
    assert.deepEqual(fakeReplySigns(named, { outside: true, threadSize: null }), [], 'not known (Check an email): nothing said');
    assert.deepEqual(fakeReplySigns(facts(), { outside: false, firstTime: false }), [], 'a colleague, known: never');
    assert.deepEqual(fakeReplySigns(facts(), { outside: false, firstTime: true }).length, 1, 'a new sender, inside or not');
    assert.deepEqual(fakeReplySigns(facts({ subject: 'Invoice 4471' }), { outside: true }), []);
});

test('in the checks: counted in the score; a real reply (its conversation in the mailbox) isn\'t', async () => {
    const fake = await analyze(await readMessage(mail({ subject: 'RE: Remittance update' })), { mailbox: USER, orgDomains: [ORG] });
    assert.ok(fake.signals.some(s => s.kind === 'fake-reply' && s.weight === 2), JSON.stringify(fake.signals.map(s => s.kind)));
    const real = await analyze(await readMessage(mail({ subject: 'RE: Remittance update', head: ['In-Reply-To: <a1@maple-schools.example>', 'References: <a1@maple-schools.example>'] })), { mailbox: USER, orgDomains: [ORG], threadSize: 2 });
    assert.ok(!real.signals.some(s => s.kind === 'fake-reply'));
});

function gmailWith(raws, threadSizes = {}) {
    const g = { modified: [], threadAsked: [] };
    Object.assign(g, {
        raw: async (user, id) => ({ id, threadId: `t-${id}`, labelIds: ['INBOX', 'UNREAD'], historyId: null, internalDate: Date.now(), raw: raws[id] }),
        threadSize: async (user, threadId) => { g.threadAsked.push(threadId); return threadSizes[threadId] || 1; },
        labelId: async (u, name) => `L_${name}`,
        modify: async (user, id, add, remove) => { g.modified.push({ id, add, remove }); return {}; }
    });
    return g;
}

test('the worker: the conversation is looked up only for a "RE:" naming an earlier email; the Suspicious label off by default, on when turned on, off again for a false alarm', async () => {
    const raws = {
        fake: mail({ subject: 'RE: Remittance update', head: ['In-Reply-To: <a1@harbor-supply.example>'] }),
        plain: mail({ subject: 'Remittance update' })
    };
    const store = new MemoryStore();
    const gmail = gmailWith(raws);
    const svc = new Service({ cfg: cfgOf(), store, gmail, log: { error() {}, warn() {} } });
    await store.setState('installedAt', Date.now() - 30 * DAY);
    const r1 = await svc.judge(USER, { id: 'fake', threadId: 't-fake', internalDate: Date.now() }, await readMessage(raws.fake));
    assert.deepEqual(gmail.threadAsked, ['t-fake']);
    const rec = await store.getRecord(`${USER}|fake`) || (await store.listRecords({})).find(r => r.messageId === 'fake');
    assert.ok(rec.signals.some(s => s.kind === 'fake-reply'), JSON.stringify(rec.signals.map(s => [s.kind, s.weight])));
    await svc.judge(USER, { id: 'plain', threadId: 't-plain', internalDate: Date.now() }, await readMessage(raws.plain));
    assert.deepEqual(gmail.threadAsked, ['t-fake'], 'not a reply: no look');
    // The label: off by default, so nothing labeled even when the email is only suspicious.
    assert.equal(svc.cfg.suspiciousLabel, false);
    assert.ok(!gmail.modified.some(m => m.add.includes('L_SPRUCE/Suspicious')));
    assert.equal(r1.action === 'flag' || r1.action === 'none' || r1.action === 'would-move', true);
    // On: a suspicious email (made so: a record judged suspicious) is labeled; a false alarm takes it off.
    await svc.setPolicy('suspiciousLabel', true, `it.head@${ORG}`);
    const flagged = mail({ subject: 'RE: notes from Thursday', from: 'Jo Rivera <jo.rivera@new-vendor.example>', body: 'Hi, here are the notes from Thursday. Let me know if anything is missing. Jo' });
    raws.flagged = flagged;
    const before = svc.judge.bind(svc);
    const res = await before(USER, { id: 'flagged', threadId: 't-flagged', internalDate: Date.now() }, await readMessage(flagged));
    const fr = (await store.listRecords({})).find(r => r.messageId === 'flagged');
    if (res.action === 'flag') {
        assert.ok(gmail.modified.some(m => m.id === 'flagged' && m.add.includes('L_SPRUCE/Suspicious')));
        assert.equal(fr.suspiciousLabel, true);
        await svc.mark(fr.key, true, `it.head@${ORG}`);
        assert.ok(gmail.modified.some(m => m.id === 'flagged' && m.remove.includes('L_SPRUCE/Suspicious')), 'a false alarm takes it off');
        assert.equal((await store.getRecord(fr.key)).suspiciousLabel, false);
    } else assert.fail(`the made-up email should be suspicious, not ${res.action} (score ${fr && fr.score})`);
    assert.ok((await store.listEvents(0)).some(e => e.admin && /turned on the Suspicious label/.test(e.text)));
});
