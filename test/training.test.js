'use strict';
// 0.3.2: the retraining export. The emails an admin marked, read from Gmail at the moment of the
// download, turned into the extension's training format with the people taken out; nothing stored.
// Every person, address and email here is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/server');
const { buildDemo, campaignTemplates } = require('../src/demo/seed');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const T = require('../src/training');
const E = require('../src/engine/spruce').load();

const ORG = 'maple-schools.example';
const ME = `jordan.reyes@${ORG}`;
const H = { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' };
const ROOT = path.resolve(__dirname, '..');

// A parent's genuine note (a false alarm) and a phishing email from a staff account taken over.
const PARENT = ['From: "Dana Whitfield" <dana.whitfield@freemail.example>', `To: "Jordan Reyes" <${ME}>`, `Cc: "Sam Okafor" <sam.okafor@${ORG}>`,
    'Subject: Tyler absent Friday', 'Authentication-Results: mx.google.com; dmarc=pass header.from=freemail.example', 'Content-Type: text/plain', '',
    'Hi Jordan,\nTyler will be absent on Friday for a doctor visit at Lakeside Pediatrics. Could you send his math homework? His student ID is 20448812. Call me at 555-201-3344 or dana.whitfield@freemail.example.\nMs. Okafor said the field trip form is due Monday.\nThanks,\nDana Whitfield'].join('\r\n');
const INSIDE = [`From: "Riley Chen" <riley.chen@${ORG}>`, `To: "Jordan Reyes" <${ME}>`, 'Subject: Shared document: Q3 bonus list', `Authentication-Results: mx.google.com; dmarc=pass header.from=${ORG}`,
    'Content-Type: text/html', '', `<p>Hello Jordan,</p><p>Riley Chen shared "Q3 Bonus List.pdf" with you. Sign in at <a href="https://maple-schools-login.example/x">portal.${ORG}</a> to view it.</p><p>Best regards,<br>Riley Chen, Finance Office, Maple Schools</p>`].join('\r\n');

async function example(raw, label, mailbox = ME) {
    const facts = await readMessage(Buffer.from(raw));
    const r = await analyze(facts, { mailbox, orgDomains: [ORG], keepAiFacts: true });
    return T.deidentify(r.aiFacts, { people: facts.people, mailbox, orgDomains: [ORG], label });
}
const all = (f) => JSON.stringify(f) + E.modelInputText(f);

test('de-identified: the recipient is "your name", other people [NAME], the sender of genuine or inside mail [SENDER], numbers and the district\'s domain replaced', async () => {
    const p = await example(PARENT, 0);
    const text = all(p);
    for (const gone of ['Jordan', 'Reyes', 'Okafor', 'Dana', 'Whitfield', '20448812', '555-201-3344', 'dana.whitfield', ORG]) assert.ok(!text.includes(gone), `${gone} is gone: ${text}`);
    assert.equal(p.senderName, '[SENDER]');
    assert.equal(p.senderAddress, 'sender@freemail.example');
    assert.match(p.bodyText, /^Hi your name,/);
    assert.match(p.bodyText, /Ms\. \[NAME\] said/);
    assert.match(p.bodyText, /student ID is number\. Call me at phone number or address at freemail\.example/);
    assert.match(p.bodyText, /Thanks,\n\[SENDER\]$/);
    // Names nobody listed: marked for a person to decide.
    assert.match(p.subject, /^⟦Tyler⟧ absent Friday$/);
    assert.match(p.bodyText, /⟦Tyler⟧ will be absent/);
    assert.match(p.bodyText, /at ⟦Lakeside Pediatrics⟧\./);
    assert.equal(p.recipient, undefined, 'no recipient field');
    assert.equal(p.org, 'outside');

    const q = await example(INSIDE, 1);
    assert.equal(q.senderName, '[SENDER]', 'inside: a colleague\'s name');
    assert.equal(q.senderAddress, 'sender@[OUR-DOMAIN]');
    assert.equal(q.org, 'inside');
    assert.equal(q.links[0].host, 'maple-schools-login.example', 'the look-alike is the trick: kept');
    assert.equal(q.links[0].text, 'portal.[OUR-DOMAIN]');
    assert.match(q.bodyText, /^Hello your name,/);
    assert.match(q.bodyText, /\[SENDER\], Finance Office, ⟦Maple⟧ Schools$/, 'the district\'s own name is marked');
    assert.ok(!/Riley|Chen/.test(all(q)));
});

test('an outside phishing sender\'s name is kept for the model, but names in it are taken out or marked', async () => {
    const ts = Object.fromEntries(campaignTemplates().map(t => [t.id, t]));
    const gift = await example(ts.giftcard.make(ME), 1);
    assert.equal(gift.senderName, 'Dr. [NAME]', 'a title and a name: an attacker using a leader\'s name');
    assert.match(gift.bodyText, /Dr\. \[NAME\], Superintendent$/);
    const vendor = await example(ts.newvendor.make(ME), 1);
    assert.equal(vendor.senderName, '⟦Pat Delgado⟧');
    assert.match(vendor.bodyText, /Thanks, \[NAME\], Account Executive$/);
    const ms = await example(ts.microsoft.make(ME), 1);
    assert.equal(ms.senderName, 'Microsoft 365 Security', 'a brand stays');
    // A sender named after the reader, and the reader's name in capitals: "your name", as the model sees it.
    const storage = await example(ts.storage.make(ME), 1);
    assert.equal(storage.senderName, 'your name');
    const credit = await example(ts.credit.make(ME), 1);
    assert.match(credit.subject, /^your name! Apply/);
});

test('everyday words in made-up phishing and genuine mail are not marked; the text is cut to what the model reads', async () => {
    for (const t of campaignTemplates().filter(x => !['newvendor'].includes(x.id))) {
        const f = await example(t.make(ME), t.falseAlarm ? 0 : 1);
        assert.ok(!/⟦/.test(JSON.stringify(f)), `${t.id}: ${JSON.stringify(f)}`);
        assert.deepEqual(T.problems({ name: t.id, label: t.falseAlarm ? 0 : 1, facts: f }), [], t.id);
    }
    const long = ['From: "News" <news@bulletins.example>', `To: ${ME}`, 'Subject: Weekly news', 'Content-Type: text/plain', '', 'The library is open late this week. '.repeat(100)].join('\r\n');
    const f = await example(long, 0);
    assert.ok(f.bodyText.length <= T.BODY_CHARS && f.bodyText.length > T.BODY_CHARS * 0.8, String(f.bodyText.length));
});

test('the check: marks, addresses, numbers and a "text" field are refused; with --final, placeholders too', async () => {
    const p = await example(PARENT, 0);
    const found = T.problems({ name: 'x', label: 0, facts: p });
    assert.ok(found.some(x => /subject: a ⟦marked⟧ word/.test(x)) && found.some(x => /bodyText: a ⟦marked⟧ word/.test(x)), found.join('\n'));
    const fixed = JSON.parse(JSON.stringify(p).replace(/⟦Tyler⟧/g, '[NAME]').replace(/⟦Lakeside Pediatrics⟧/g, 'the clinic'));
    assert.deepEqual(T.problems({ name: 'x', label: 0, facts: fixed }), []);
    assert.ok(T.problems({ name: 'x', label: 0, facts: fixed }, { final: true }).some(x => /\[NAME\] is still there/.test(x)));
    const leaky = Object.assign({}, fixed, { bodyText: 'Write to pat.lee@elsewhere.example or call (555) 201-3344 about card 4111 1111 1111 1111.' });
    const lk = T.problems({ label: 0, facts: leaky });
    assert.ok(lk.some(x => /an email address/.test(x)) && lk.some(x => /a phone number/.test(x)) && lk.some(x => /a long number/.test(x)), lk.join('\n'));
    assert.ok(T.problems({ label: 2, text: 'x', facts: fixed }).some(x => /label must be/.test(x)));
    assert.ok(T.problems({ label: 1, text: 'x', facts: fixed }).some(x => /has "text"/.test(x)));
    // The command line: refuses, then passes once fixed; --final wants made-up names in place of the placeholders.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-train-'));
    const file = path.join(dir, 'x.jsonl');
    fs.writeFileSync(file, T.toJsonl([{ name: 'a', label: 0, facts: p }]));
    const run = (...a) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check-training-file.js'), ...a], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
    assert.equal(run(file).code, 1);
    fs.writeFileSync(file, T.toJsonl([{ name: 'a', label: 0, facts: fixed }]));
    const ok = run(file);
    assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /1 examples: 0 phishing, 1 genuine/);
    assert.equal(run('--final', file).code, 1);
    const final = JSON.parse(JSON.stringify(fixed).replace(/\[NAME\]/g, 'Avery').replace(/\[SENDER\]/g, 'Casey Morgan'));
    fs.writeFileSync(file, T.toJsonl([{ name: 'a', label: 0, facts: final }]));
    assert.equal(run('--final', file).code, 0);
    // The split keeps every third email of each kind aside, its variants with it.
    const rows = [1, 1, 1, 1, 0, 0, 0].map((label, i) => ({ name: `e${i}`, label, facts: final }));
    rows.push({ name: 'e2-v1', label: 1, facts: final });
    fs.writeFileSync(file, T.toJsonl(rows));
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'split-examples.js'), file]);
    const names = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l).name);
    assert.deepEqual(names(path.join(dir, 'x-held-out.jsonl')), ['e2', 'e6', 'e2-v1']);
    assert.deepEqual(names(path.join(dir, 'x-train.jsonl')), ['e0', 'e1', 'e3', 'e4', 'e5']);
    fs.writeFileSync(file, T.toJsonl([{ name: 'a', label: 0, facts: final }]));
    // The scorer reads the same file with the model the service runs.
    const sc = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'score-examples.js'), file], { encoding: 'utf8' });
    assert.match(sc, /Model phish-tiny .*: 0 phishing, 1 genuine\./);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the export: off by default; confirmed phishing only unless false alarms are asked for; one per campaign; read now, never stored', async () => {
    const store = new MemoryStore();
    const raws = new Map();
    const gmail = {
        raw: async (u, id) => { const b = raws.get(`${u}|${id}`); if (!b) throw Object.assign(new Error('gone'), { status: 404 }); return { id, threadId: 't', labelIds: ['INBOX'], historyId: null, internalDate: Date.now(), raw: b }; },
        labelId: async (u, n) => `L_${n}`, modify: async () => ({})
    };
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: ME, MODE: 'monitor' });
    const svc = new Service({ cfg, store, gmail, log: { error() {} } });
    const ts = Object.fromEntries(campaignTemplates().map(t => [t.id, t]));
    const users = [ME, `sam.okafor@${ORG}`, `avery.lee@${ORG}`];
    const judged = {};
    let n = 0;
    for (const [id, make] of [['microsoft', ts.microsoft.make], ['storage', ts.storage.make], ['deals', ts.deals.make], ['payroll', ts.payroll.make], ['parent', () => PARENT]]) {
        judged[id] = [];
        for (const u of users) {
            const raw = Buffer.from(make(u)); const mid = `m${++n}`;
            raws.set(`${u}|${mid}`, raw);
            const r = await svc.judge(u, { id: mid, threadId: 't', internalDate: Date.now() }, await readMessage(raw));
            if (r && r.key) judged[id].push(r.key);
        }
    }
    for (const id of ['microsoft', 'storage', 'deals', 'payroll']) assert.ok(judged[id].length === 3, `${id} recorded`);
    assert.equal((await svc.trainingExport({ by: 'it.head@maple-schools.example' })).error, 'off', 'off by default');
    await svc.setTrainingExport(true, `it.head@${ORG}`);
    assert.ok((await store.listEvents()).some(e => e.kind === 'settings' && /allowed the retraining export/.test(e.text)));
    // Marks: microsoft and storage confirmed (every copy), deals a false alarm, payroll both ways (left out).
    for (const k of [...judged.microsoft, ...judged.storage]) await svc.mark(k, false, `it.head@${ORG}`);
    for (const k of judged.deals) await svc.mark(k, true, `it.head@${ORG}`);
    await svc.mark(judged.payroll[0], false, `it.head@${ORG}`); await svc.mark(judged.payroll[1], true, `it.head@${ORG}`);
    // Every storage copy but one deleted since: that one is used. Every deals copy deleted but one, too.
    for (const k of judged.storage.slice(0, 2)) raws.delete(k);
    const dump = () => JSON.stringify([...store.records.values(), ...store.state.entries(), ...store.stats.entries(), ...store.campaignState.entries(), ...store.senders.entries()]);
    const before = dump();
    const recordsBefore = JSON.stringify(await store.listRecords({ sinceMs: 0 }));

    const a = await svc.trainingExport({ by: `it.head@${ORG}` });
    assert.equal(a.counts.conflicting, 1, 'payroll, marked both ways');
    assert.deepEqual(a.rows.map(r => r.label), [1, 1], 'phishing only by default, one per campaign');
    assert.equal(a.counts.gone, 0, 'a copy still in a mailbox replaces the deleted ones');
    assert.deepEqual(a.rows.map(r => r.facts.senderAddress).sort(), ['noreply@brt.greenpath-mail.example', 'security@micros0ft-support.example']);
    for (const r of a.rows) {
        assert.match(r.name, /^spruce-m\d+$/);
        assert.match(r.note, /^Confirmed as phishing or spam by an admin\. On arrival: /);
        assert.ok(!/it\.head|jordan|okafor|avery|lee@/i.test(JSON.stringify(r)), JSON.stringify(r));
        assert.ok(E.modelInputText(r.facts).length > 50, 'make-dataset.js can build the model\'s input from it');
    }
    const b = await svc.trainingExport({ by: `it.head@${ORG}`, falseAlarms: true });
    assert.equal(b.rows.filter(r => r.label === 0).length, 1, 'the false alarm, once');
    assert.equal(b.rows.find(r => r.label === 0).facts.senderName, '[SENDER]');
    // Nothing stored or counted: records, stats, state and senders are as they were (Activity aside).
    assert.equal(JSON.stringify(await store.listRecords({ sinceMs: 0 })), recordsBefore);
    assert.equal(dump(), before);
    assert.ok(!JSON.stringify(store.events).includes('Keep my password'), 'no email text in Activity');
    // Every copy gone: counted, and the campaign is left out.
    for (const k of judged.microsoft) raws.delete(k);
    const c = await svc.trainingExport({ by: 'x' });
    assert.equal(c.counts.gone, 1); assert.equal(c.rows.length, 1);
    const ev = (await store.listEvents()).filter(e => e.kind === 'training').sort((x, y) => x.at - y.at);
    assert.equal(ev.length, 3);
    assert.match(ev[0].text, /^it\.head@maple-schools\.example downloaded the retraining export: \d examples? \(\d phishing\) from the last 90 days/);
    assert.match(ev[1].text, /\(\d phishing, 1 false alarm\)/);
    // At most max examples.
    assert.equal((await svc.trainingExport({ by: 'x', falseAlarms: true, max: 1 })).rows.length, 1);
});

test('the dashboard: allowed in Settings, then a download (JSONL, with counts in its headers); refused when off', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: ORG });
    const { store, raws } = await buildDemo({ cfg, now: Date.now() });
    const gmail = { labelId: async (u, n) => `L_${n}`, modify: async () => ({}), raw: async (u, id) => { const b = raws.get(id); if (!b) throw Object.assign(new Error('gone'), { status: 404 }); return { id, labelIds: ['INBOX'], raw: b }; } };
    const service = new Service({ cfg, store, gmail, log: { error() {} } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = (p, body, headers = H) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
        assert.equal((await (await fetch(`${base}/api/settings`)).json()).trainingExport.enabled, false);
        assert.equal((await (await fetch(`${base}/api/health?days=30`)).json()).trainingExport, false);
        const off = await post('/api/training-export', { days: 30 });
        assert.equal(off.status, 403); assert.match((await off.json()).error, /is off/);
        assert.equal((await post('/api/training-export/allow', { enabled: true }, { 'content-type': 'application/json' })).status, 403, 'the dashboard\'s header is required');
        assert.equal((await post('/api/training-export/allow', { enabled: true })).status, 200);
        assert.equal((await (await fetch(`${base}/api/health?days=30`)).json()).trainingExport, true);
        const res = await post('/api/training-export', { days: 30, falseAlarms: true });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^application\/x-ndjson/);
        assert.match(res.headers.get('content-disposition'), /^attachment; filename="spruce-retraining-\d{4}-\d\d-\d\d\.jsonl"$/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const rows = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
        assert.equal(Number(res.headers.get('x-spruce-examples')), rows.length);
        assert.ok(rows.some(r => r.label === 1) && rows.some(r => r.label === 0), 'the demo\'s confirmed phishing and its false alarm');
        for (const r of rows) assert.deepEqual(Object.keys(r), ['name', 'label', 'note', 'facts']);
        assert.ok(!rows.some(r => /@maple-schools\.example/.test(JSON.stringify(r))), 'no staff address');
        const ev = (await (await fetch(`${base}/api/activity?days=1&kind=admin`)).json()).events;
        assert.ok(ev.some(e => e.kind === 'training'), 'listed under what admins did');
    } finally { await new Promise(r => srv.close(r)); }
});
