'use strict';
// 0.5.11: the AI doesn't read mail from inside the organization by default (AI_SCANS_INSIDE, Settings →
// Policy); the rule checks still read it (its links, its headers, the rest), and mail dressed up as inside
// (a forged staff address, a staff address in an outside sender's name) is outside mail, with its own signs.
const test = require('node:test');
const assert = require('node:assert');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const { decide } = require('../src/policy');
const { loadConfig } = require('../src/config');
const { Service, policyValue } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');

const ORG = 'maple-schools.example', USER = `sam.okafor@${ORG}`;
const mail = ({ from, name = 'Help Desk', auth, body = 'The staff meeting is moved to 3 pm in the library.', html = null }) => Buffer.from([
    `From: "${name}" <${from}>`, `To: ${USER}`, 'Subject: Staff meeting moved', 'Message-ID: <m@x.example>',
    ...(auth ? [`Authentication-Results: mx.google.com; ${auth}`] : []),
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8`, '', html || body].join('\r\n'));
const judge = async (raw, ctx = {}) => analyze(await readMessage(raw), Object.assign({ mailbox: USER, orgDomains: [ORG] }, ctx));
const PASS = `dkim=pass; dmarc=pass (p=REJECT) header.from=${ORG}`;

test('mail from inside (your domain, DMARC passing): not read by the AI by default; read with aiInside', async () => {
    const r = await judge(mail({ from: `helpdesk@${ORG}`, auth: PASS }));
    assert.equal(r.inside, true);
    assert.equal(r.ai.probability, null);
    assert.equal(r.ai.skipped, 'inside');
    const on = await judge(mail({ from: `helpdesk@${ORG}`, auth: PASS }), { aiInside: true });
    assert.equal(typeof on.ai.probability, 'number');
    assert.equal(on.ai.skipped, undefined);
});

test('the rule checks still read inside mail: its malicious links count, and the rules can move it (a staff account taken over)', async () => {
    const html = '<p>Please review the attached payroll change and sign in to confirm.</p>'
        + '<p><a href="javascript:alert(1)">Open the payroll file</a></p><p><a href="data:text/html,<form>sign in</form>">Sign in to confirm</a></p>';
    const r = await judge(mail({ from: `payroll@${ORG}`, auth: PASS, html }));
    assert.equal(r.inside, true);
    assert.equal(r.ai.skipped, 'inside');
    assert.ok(r.signals.some(s => s.kind === 'dangerous-links'), JSON.stringify(r.signals));
    assert.equal(r.status, 'flagged');
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER, MODE: 'enforce' });
    const d = decide(r, cfg, {});
    assert.deepEqual([d.action, d.trigger], ['move', 'rules']);
});

test('mail dressed up as inside: a forged staff address (DMARC failing) is outside mail, read by the AI, with a sign; a staff address in an outside sender\'s name too', async () => {
    const forged = await judge(mail({ from: `superintendent@${ORG}`, name: 'Superintendent', auth: `spf=fail; dmarc=fail (p=NONE) header.from=${ORG}` }));
    assert.equal(forged.inside, false);
    assert.equal(typeof forged.ai.probability, 'number', 'the AI reads it');
    const spoof = forged.signals.find(s => s.kind === 'spoofed-inside');
    assert.ok(spoof && /claims to come from inside your organization/.test(spoof.text), JSON.stringify(forged.signals));
    assert.ok(forged.signals.some(s => /failed its sender's verification \(DMARC\)/.test(s.text)), 'and the DMARC failure itself');
    assert.equal(forged.status, 'flagged', 'together: flagged');
    // No DMARC result at all (a domain without DMARC): outside mail, but no "forged" sign (nothing says it is).
    const unknown = await judge(mail({ from: `superintendent@${ORG}`, auth: null }));
    assert.equal(unknown.inside, false);
    assert.ok(!unknown.signals.some(s => s.kind === 'spoofed-inside'));

    const named = await judge(mail({ from: 'notices@mailer-relay.example', name: `it-support@${ORG}`, auth: 'spf=pass; dmarc=pass header.from=mailer-relay.example' }));
    const n = named.signals.find(s => s.kind === 'inside-name-outside-address');
    assert.ok(n && n.weight === 3 && n.text.includes(`it-support@${ORG}`), JSON.stringify(named.signals));
    // Your own staff writing as themselves: no such sign.
    const own = await judge(mail({ from: `it-support@${ORG}`, name: `it-support@${ORG}`, auth: PASS }));
    assert.ok(!own.signals.some(s => /inside-name-outside-address|spoofed-inside/.test(s.kind || '')));
});

test('AI_SCANS_INSIDE: off by default; on in the environment, on Settings → Policy (noted), or with AI_MOVES_INSIDE', async () => {
    const base = { STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER };
    assert.equal(loadConfig(base).aiScansInside, false);
    assert.equal(new Service({ cfg: loadConfig(base), store: new MemoryStore(), gmail: {} }).aiReadsInside(), false);
    assert.equal(new Service({ cfg: loadConfig(Object.assign({ AI_SCANS_INSIDE: 'on' }, base)), store: new MemoryStore(), gmail: {} }).aiReadsInside(), true);
    assert.equal(new Service({ cfg: loadConfig(Object.assign({ AI_MOVES_INSIDE: 'true' }, base)), store: new MemoryStore(), gmail: {} }).aiReadsInside(), true);
    assert.equal(policyValue('aiScansInside', 'on'), true);
    assert.equal(policyValue('aiScansInside', false), false);
    assert.throws(() => policyValue('aiScansInside', 'maybe'), /on or off/);
    const store = new MemoryStore();
    const svc = new Service({ cfg: loadConfig(base), store, gmail: {}, log: { error() {}, warn() {} } });
    const out = await svc.setPolicy('aiScansInside', true, `it.head@${ORG}`);
    assert.deepEqual([out.value, out.before], [true, false]);
    assert.equal(svc.aiReadsInside(), true);
    assert.ok((await store.listEvents()).some(e => /turned on the AI for mail from inside the organization on the dashboard \(confirmed with the project ID\): the AI reads it too now/.test(e.text)));
});
