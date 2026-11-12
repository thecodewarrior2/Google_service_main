'use strict';
// 0.5.12: a suspicious email says what made it suspicious (the rules' score, the AI's, or a link check);
// "…show more" gives each sentence that weighed most with the sentence of real text before and after it
// (blank lines, lone punctuation and invisible padding skipped); the To-line check reads the address a mail
// program shows in the name as it is written ('quoted', with a name, with a +tag); and "AI alone moves
// inside mail" is on Settings → Policy, off by default, agreed to when turned on.
// Every address, name and text here is made up (maple-schools.example).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { readMessage } = require('../src/engine/mime');
const { analyze, aiReading } = require('../src/engine/analyze');
const { hasText } = require('../src/engine/model');
const { decide, suspiciousWhy } = require('../src/policy');
const { loadConfig } = require('../src/config');
const { Service, policyValue } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/server');
const spruce = require('../src/engine/spruce');

const ORG = 'maple-schools.example', USER = `sam.okafor@${ORG}`;
const cfgOf = (extra = {}) => loadConfig(Object.assign({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER }, extra));

test('the suspicious reason names its cause: the rules\' score, a link check, the AI\'s score, or both', () => {
    const cfg = cfgOf();
    const r = (status, score, p, inside = false) => ({ status, score, inside, ai: { probability: p } });
    // The rules alone (the AI at 0%: what was reported, an email "suspicious" with the AI at 0%).
    let d = decide(r('caution', 3, 0), cfg);
    assert.equal(d.action, 'flag');
    assert.equal(d.why, 'the rule checks scored it 3 (suspicious from 3, moved from 5)');
    // The AI alone.
    d = decide(r('clean', 0, 0.72), cfg);
    assert.equal(d.why, 'the AI scored it 72% (suspicious from 65%, moved from 90%)');
    // Both.
    assert.equal(decide(r('caution', 4, 0.8), cfg).why, 'the rule checks scored it 4 (suspicious from 3, moved from 5), and the AI scored it 80% (suspicious from 65%, moved from 90%)');
    // A link check's verdict with no score.
    assert.equal(decide(r('caution', 0, 0.1), cfg).why, 'a link check found a suspicious link');
    // Flagged, with moving on the rules off.
    assert.match(decide(r('flagged', 6, 0.1), cfgOf({ MOVE_ON_RULES: 'false' })).why, /scored it 6 .*moving on the rules is off \(MOVE_ON_RULES\)/);
    // Inside, the AI high, the setting off: says so.
    assert.match(decide(r('clean', 0, 0.95, true), cfg).why, /the AI scored it 95%, but the sender is inside the organization and "AI alone moves inside mail" is off/);
    // Nothing suspicious: no reason.
    assert.equal(decide(r('clean', 1, 0.2), cfg).action, 'none');
    assert.equal(suspiciousWhy(r('caution', 3, null), cfg), 'the rule checks scored it 3 (suspicious from 3, moved from 5)');
});

test('"AI alone moves inside mail": off by default; on (environment or Settings → Policy, agreed to), the AI score alone moves inside mail, and the record says so', async () => {
    assert.equal(cfgOf().aiMovesInside, false);
    const inside = { status: 'clean', score: 0, inside: true, ai: { probability: 0.95 } };
    assert.equal(decide(inside, cfgOf({ MODE: 'enforce' })).action, 'flag', 'off: never moved on the AI alone');
    const on = decide(inside, cfgOf({ MODE: 'enforce', AI_MOVES_INSIDE: 'true' }));
    assert.deepEqual([on.action, on.trigger], ['move', 'ai']);
    assert.match(on.why, /^AI 95% ≥ 90% \(the sender is inside the organization; "AI alone moves inside mail" is on\)$/);
    assert.equal(policyValue('aiMovesInside', 'on'), true);
    assert.equal(policyValue('aiMovesInside', false), false);
    assert.throws(() => policyValue('aiMovesInside', 'maybe'), /alone moves mail from inside is on or off/);

    // On the dashboard: the project ID and the agreement; noted in Activity; the AI reads inside mail then.
    const cfg = loadConfig({ DEMO: '1', MODE: 'enforce', ORG_DOMAINS: ORG, STORE: 'memory' });
    const store = new MemoryStore();
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn() {} } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = async (body) => { const res = await fetch(`${base}/api/policy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
    try {
        let out = await post({ key: 'aiMovesInside', value: true, projectId: 'demo-project' });
        assert.equal(out.status, 400);
        assert.match(out.body.error, /Tick "I agree" to let the AI alone move mail from inside\. Nothing was changed\./);
        assert.equal(service.aiReadsInside(), false);
        out = await post({ key: 'aiMovesInside', value: true, projectId: 'demo-project', agree: true });
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.equal(out.body.changed.value, true);
        assert.equal(out.body.aiMovesInside, true, 'every answer says it');
        assert.equal(cfg.aiMovesInside, true);
        assert.equal(service.aiReadsInside(), true, 'it needs the AI to read inside mail');
        assert.ok((await store.listEvents()).some(e => /turned on "AI alone moves inside mail" on the dashboard \(confirmed with the project ID\): an email from inside the organization that the AI scores 90% or more is moved to Spam on the AI score alone/.test(e.text)));
        // Turning it off needs no agreement.
        out = await post({ key: 'aiMovesInside', value: false, projectId: 'demo-project' });
        assert.equal(out.status, 200);
        assert.equal(cfg.aiMovesInside, false);
        assert.ok((await store.listEvents()).some(e => /turned off "AI alone moves inside mail".*the AI score alone no longer moves mail from inside the organization; the rules still can/.test(e.text)));
        assert.equal(service.aiReadsInside(), false);
        const s = await (await fetch(`${base}/api/settings`)).json();
        assert.equal(s.aiMovesInside, false);
        assert.ok(s.policy && s.policy.aiMovesInside, 'shown on Settings → Policy');
    } finally { await new Promise(r => srv.close(r)); }
});

test('old records ("suspicious, below the move rules") are shown with what made them suspicious', async () => {
    const cfg = loadConfig({ DEMO: '1', ORG_DOMAINS: ORG, STORE: 'memory' });
    const store = new MemoryStore();
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn() {} } });
    await store.saveRecord({ key: `${USER}|old1`, user: USER, messageId: 'old1', processedAt: Date.now(), action: 'flag', state: 'inbox', status: 'caution', score: 3,
        ai: { probability: 0, model: 'phish-tiny' }, inside: false, why: 'suspicious, below the move rules; moved when it.head@maple-schools.example confirmed it as phishing', sender: { address: 'events@calendar-vendor.example' } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    try {
        const m = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/message?key=${encodeURIComponent(`${USER}|old1`)}`)).json();
        assert.equal(m.message.why, 'the rule checks scored it 3 (suspicious from 3, moved from 5); moved when it.head@maple-schools.example confirmed it as phishing');
        assert.match((await store.getRecord(`${USER}|old1`)).why, /^suspicious, below the move rules/, 'the record itself is left as it was');
    } finally { await new Promise(r => srv.close(r)); }
});

test('the To-line check: the address in the name read as written; another of the same domain is a weak sign, another domain a sign', () => {
    const E = spruce.load();
    const raw = (to) => ['From: "Front Office" <office@lakeview-events.example>', `To: ${to}`, 'Subject: Spring open house', 'Message-ID: <x1@lakeview-events.example>', '', 'Hello.'].join('\r\n');
    const toSign = (to) => E.headerAnomalies(raw(to), USER).find(s => /“To” line/.test(s.text));
    // The same mailbox, as mail programs write it: no sign.
    for (const to of [`"${USER}" <${USER}>`, `'${USER}' <${USER}>`, `"'${USER}'" <${USER}>`, `"Sam Okafor (${USER})" <${USER}>`, `"mailto:${USER}" <${USER}>`,
        `"sam.okafor+events@${ORG}" <${USER}>`, `"SAM.OKAFOR@MAPLE-SCHOOLS.EXAMPLE" <${USER}>`, `"Sam Okafor" <${USER}>`, `=?UTF-8?Q?sam=2Eokafor=40maple-schools=2Eexample?= <${USER}>`]) {
        assert.equal(toSign(to), undefined, to);
    }
    // An alias or a group of the same domain, or the same name in another domain: weak (1).
    assert.equal(toSign(`"all-staff@${ORG}" <${USER}>`).weight, 1);
    assert.equal(toSign(`"sam.okafor@maple-schools-old.example" <${USER}>`).weight, 1);
    // The reader's address shown on mail really addressed elsewhere: a sign (2), naming both domains.
    const s = toSign(`"${USER}" <list-7781@bulk-sender.example>`);
    assert.equal(s.weight, 2);
    assert.equal(s.text, 'Its “To” line shows an address at maple-schools.example but is really addressed to one at bulk-sender.example.');
    // A broken address is still one.
    assert.ok(E.headerAnomalies(raw(`"Sam" <sam@@${ORG}>`), USER).some(x => x.kind === 'broken-to'));
});

test('"…show more": each sentence that weighed most comes with the sentence of real text before and after it; filler is marked and skipped', async () => {
    assert.equal(hasText('Hello there.'), true);
    for (const f of ['', '   ', '.', '--', '* .', '‌ ͏ ‌ .', 'OK.', '1 2', '•', 'phone number.', '|  |']) assert.equal(hasText(f), false, JSON.stringify(f));
    const body = ['Hello Sam, a note from the help desk.', '‌ ͏ ‌.', '--.', 'Your mailbox password expires today and your account will be closed.',
        '!!', 'Click here now to verify your password and keep your account open.', '⠀.', '.', 'Thank you, the help desk team.'].join(' ');
    const raw = Buffer.from(['From: "Help Desk" <helpdesk@mailbox-renewal.example>', `To: ${USER}`, 'Subject: Password expires today', 'Message-ID: <x2@mailbox-renewal.example>',
        'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'));
    const r = await analyze(await readMessage(raw), { mailbox: USER, orgDomains: [ORG], keepAiFacts: true });
    const reading = await aiReading(r.aiFacts);
    const filler = reading.sentences.filter(x => x.filler);
    assert.ok(filler.length >= 3, JSON.stringify(reading.sentences.map(x => [x.text, x.filler])));
    assert.ok(reading.weighed.length >= 1, 'the phishing sentences weighed');
    for (const c of reading.weighed) {
        const at = reading.sentences[c.index];
        assert.ok(!at.filler && at.weight > 0);
        for (const n of [c.before, c.after].filter(Boolean)) assert.ok(hasText(n.text), `context is real text: ${JSON.stringify(n)}`);
    }
    const expires = reading.weighed.find(c => /expires today/.test(reading.sentences[c.index].text));
    if (expires) assert.equal(expires.before.text, 'Hello Sam, a note from the help desk.', 'the blank padding and the dashes are skipped');
    const click = reading.weighed.find(c => /Click here now/.test(reading.sentences[c.index].text));
    if (click) assert.equal(click.after.text, 'Thank you, the help desk team.');
    assert.ok(expires || click);
    // Invisible characters aren't shown.
    assert.ok(reading.sentences.every(x => !/[‌͏⠀]/.test(x.text)));
});
