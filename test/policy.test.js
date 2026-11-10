'use strict';
// 0.3.6: the policy changed on the dashboard (Settings → Policy): mode, AI move threshold, brake, time
// zone; each needs the Google Cloud project ID, enforce mode the agreement too. Every address is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/server');
const { readMessage } = require('../src/engine/mime');

const ORG = 'maple-schools.example';
const PHISH = fs.readFileSync(path.join(__dirname, 'fixtures', 'phish-storage.eml'));
const H = { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' };
const ENV = { STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `reader@${ORG}`, MODE: 'monitor', GOOGLE_CLOUD_PROJECT: 'maple-mail-protection' };
const gmail = () => { const moved = []; return { moved, labelId: async (u, n) => `L_${n}`, modify: async (u, id, add) => { moved.push({ u, id, add }); return {}; } }; };

test('a change applies at once here, within the refresh everywhere, is noted and alerted; settings.env changed later wins', async () => {
    const store = new MemoryStore();
    const g = gmail();
    const warned = [];
    const a = new Service({ cfg: loadConfig(ENV), store, gmail: g, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    // Values are checked.
    await assert.rejects(a.setPolicy('mode', 'off', 'x'), { status: 400, message: /monitor or enforce/ });
    await assert.rejects(a.setPolicy('aiThreshold', 0.5, 'x'), { status: 400 });
    await assert.rejects(a.setPolicy('brakePerHour', 5, 'x'), { status: 400 });
    await assert.rejects(a.setPolicy('timeZone', 'Mars/Olympus', 'x'), { status: 400 });
    await assert.rejects(a.setPolicy('retentionDays', 1, 'x'), { status: 400 });
    // Monitor: a phishing email is only recorded.
    let r = await a.judge(`reader@${ORG}`, { id: 'p1', threadId: 't', internalDate: Date.now() }, await readMessage(PHISH));
    assert.equal(r.action, 'would-move'); assert.equal(g.moved.length, 0);
    // Enforce, set on the dashboard: the next one is moved.
    assert.deepEqual(await a.setPolicy('mode', 'enforce', `it.head@${ORG}`), { key: 'mode', value: 'enforce', before: 'monitor' });
    r = await a.judge(`reader@${ORG}`, { id: 'p2', threadId: 't', internalDate: Date.now() }, await readMessage(PHISH));
    assert.equal(r.action, 'move'); assert.equal(g.moved.length, 1);
    assert.deepEqual(await a.setPolicy('mode', 'enforce', 'x'), { key: 'mode', value: 'enforce', unchanged: true });
    await a.setPolicy('aiThreshold', 0.92, `it.head@${ORG}`);
    await a.setPolicy('brakePerHour', 250, `it.head@${ORG}`);
    await a.setPolicy('timeZone', 'America/Chicago', `it.head@${ORG}`);
    assert.equal(await a.brakeLimit(), 250);
    const ev = (await store.listEvents()).filter(e => e.kind === 'settings').map(e => e.text);
    assert.ok(ev.includes(`it.head@${ORG} switched to enforce mode on the dashboard (confirmed with the project ID, and agreed): from now on, emails the policy flags are moved to Spam.`));
    assert.ok(ev.includes(`it.head@${ORG} changed the AI move threshold from 85% to 92% on the dashboard (confirmed with the project ID).`));
    assert.ok(ev.includes(`it.head@${ORG} changed the brake from automatic (half the watched mailboxes, at least 100) to 250 moves an hour on the dashboard (confirmed with the project ID).`));
    assert.ok(ev.some(t => /changed the time zone from UTC to America\/Chicago .*the nightly jobs move to it the next time deploy\/install\.sh runs\./.test(t)));
    assert.deepEqual(warned.map(w => w.spruceAlert), ['settings', 'settings', 'settings'], 'emailed as alerts, the time zone aside');
    // Another instance (its own copy of the settings) sees them at its next refresh.
    const b = new Service({ cfg: loadConfig(ENV), store, gmail: gmail(), log: { error() {} } });
    assert.equal(b.cfg.mode, 'monitor');
    await b.refreshPolicy({ force: true });
    assert.deepEqual([b.cfg.mode, b.cfg.aiThreshold, b.cfg.brakePerHour, b.cfg.timeZone], ['enforce', 0.92, 250, 'America/Chicago']);
    assert.deepEqual(b.policyInfo().mode.changed && b.policyInfo().mode.changed.by, `it.head@${ORG}`);
    // A worker refreshes on every notification (at most every 30 s).
    const c = new Service({ cfg: loadConfig(ENV), store, gmail: gmail(), log: { error() {} } });
    await c.handleNotification({ emailAddress: `nobody@${ORG}`, historyId: '1' });
    assert.equal(c.cfg.mode, 'enforce');
    // settings.env changed since (another threshold, then install.sh): that one is newer and applies.
    const d = new Service({ cfg: loadConfig(Object.assign({}, ENV, { AI_MOVE_THRESHOLD: '0.8' })), store, gmail: gmail(), log: { error() {} } });
    await d.refreshPolicy({ force: true });
    assert.equal(d.cfg.aiThreshold, 0.8);
    assert.equal(d.cfg.mode, 'enforce', 'the others are still the dashboard\'s');
    assert.deepEqual(d.policyInfo().aiThreshold.replaced, { by: `it.head@${ORG}`, at: d.policyInfo().aiThreshold.replaced.at, value: 0.92 });
});

async function serve(cfg, store) {
    const service = new Service({ cfg, store, gmail: gmail(), log: { error() {}, warn() {} } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = async (body, headers = H) => { const res = await fetch(`${base}/api/policy`, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
    const settings = async () => (await fetch(`${base}/api/settings`)).json();
    return { post, settings, service, close: () => new Promise(r => srv.close(r)) };
}

test('the dashboard: the project ID is required, wrong ones lock it for a while, enforce needs the agreement', async () => {
    // (demo mode: anyone is an admin, and the project ID is demo-project)
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: ORG });
    const s = await serve(cfg, new MemoryStore());
    try {
        let st = await s.settings();
        assert.equal(st.projectKnown, true); assert.equal(st.demoProjectId, 'demo-project');
        assert.deepEqual(st.policy.mode, { value: 'monitor', env: 'monitor', changed: null, replaced: null });
        assert.equal((await s.post({ key: 'aiThreshold', value: 0.9, projectId: 'demo-project' }, { 'content-type': 'application/json' })).status, 403, 'the dashboard\'s header is required');
        let r = await s.post({ key: 'aiThreshold', value: 0.9, projectId: 'some-other-project' });
        assert.equal(r.status, 403); assert.match(r.body.error, /isn't the Google Cloud project ID of this service\. Nothing was changed\./);
        r = await s.post({ key: 'mode', value: 'enforce', projectId: 'demo-project' });
        assert.equal(r.status, 400); assert.match(r.body.error, /Tick "I agree"/);
        assert.equal(cfg.mode, 'monitor', 'nothing changed');
        r = await s.post({ key: 'mode', value: 'enforce', projectId: ' Demo-Project ', agree: true });
        assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.changed.value, 'enforce'); assert.equal(cfg.mode, 'enforce');
        r = await s.post({ key: 'aiThreshold', value: 0.3, projectId: 'demo-project' });
        assert.equal(r.status, 400); assert.match(r.body.error, /more than 50%.*Nothing was changed\./);
        r = await s.post({ key: 'timeZone', value: 'America/Denver', projectId: 'demo-project' });
        assert.equal(r.status, 200);
        st = await s.settings();
        assert.equal(st.mode, 'enforce'); assert.equal(st.timeZone, 'America/Denver');
        assert.equal(st.policy.mode.changed.by, 'demo-admin@example.org');
        // Back to monitor: the project ID, no agreement needed.
        r = await s.post({ key: 'mode', value: 'monitor', projectId: 'demo-project' });
        assert.equal(r.status, 200); assert.equal(cfg.mode, 'monitor');
        // Five wrong project IDs: locked, even for the right one, for 10 minutes.
        for (let i = 0; i < 5; i++) assert.equal((await s.post({ key: 'brakePerHour', value: 300, projectId: `guess-${i}` })).status, 403);
        r = await s.post({ key: 'brakePerHour', value: 300, projectId: 'demo-project' });
        assert.equal(r.status, 429); assert.match(r.body.error, /Too many wrong project IDs/);
        assert.equal(cfg.brakePerHour, 0);
    } finally { await s.close(); }
});

test('the project ID that counts: GOOGLE_CLOUD_PROJECT (set by install.sh), demo-project in demo mode, none otherwise', () => {
    const { expectedProject } = require('../src/server');
    assert.equal(expectedProject(loadConfig(ENV)), 'maple-mail-protection');
    assert.equal(expectedProject(loadConfig(Object.assign({}, ENV, { GOOGLE_CLOUD_PROJECT: '' }))), '', 'unknown: the route refuses (409)');
    assert.equal(expectedProject(loadConfig({ DEMO: '1', ORG_DOMAINS: ORG })), 'demo-project');
});
