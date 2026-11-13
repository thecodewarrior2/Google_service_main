'use strict';
// 0.5.28: Status → Activity. An admin's own change that is also emailed (a policy change, an update started,
// a Safe Browsing key) is listed under "What admins did", not "Alerts"; an alert is what needs looking at.
// Made-up people only.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const A = require('../src/dashboard/aggregate');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/server');

const ADMIN = 'it.head@maple-schools.example';
const EVENTS = [
    { at: 9, kind: 'update', alert: true, admin: true, text: `${ADMIN} started an update from 0.5.26 to 0.5.27 on the dashboard (confirmed with the project ID and their own email address, and agreed).` },
    { at: 8, kind: 'update', alert: true, text: `${ADMIN} started an update from 0.5.25 to 0.5.26 on the dashboard (an older record: no admin mark).` },
    { at: 7, kind: 'update', alert: true, text: 'The update from 0.5.26 to 0.5.27 failed: the image didn\'t build.' },
    { at: 6, kind: 'update', text: 'Updated from 0.5.26 to 0.5.27.' },
    { at: 5, kind: 'settings', alert: true, policy: 'mode', text: `${ADMIN} switched to enforce mode on the dashboard.` },
    { at: 4, kind: 'campaign', alert: true, text: 'A large campaign: 50 copies of "Invoice" moved to Spam so far.' },
    { at: 3, kind: 'campaign', text: `${ADMIN} confirmed the campaign "Invoice" as phishing.` },
    { at: 2, kind: 'brake', alert: true, text: '500 emails were moved within the hour.' },
    { at: 1, kind: 'lists', admin: true, text: `${ADMIN} re-checked the phishing lists: none needed a download.` },
    { at: 0, kind: 'lists', text: 'HaGeZi Threat Intelligence Feeds downloaded again.' }
];
const texts = (kind) => A.activity(EVENTS, kind).map(e => e.at);

test('an admin\'s own changes are what admins did, even when emailed; alerts are what needs looking at', () => {
    assert.deepEqual(texts('alert'), [7, 4, 2], 'a failed update, a large campaign, the brake');
    assert.deepEqual(texts('admin'), [9, 8, 6, 5, 3, 1], 'updates started (old records too), an update done, a policy change, a campaign confirmed, a re-check');
    assert.equal(A.isAdminAction(EVENTS[0]), true);
    assert.equal(A.isAdminAction(EVENTS[2]), false, 'a failed update is an alert');
    assert.equal(texts('').length, EVENTS.length, 'everything');
});

test('the service: an admin\'s change is recorded under What admins did and not emailed; a problem is an alert, emailed', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: 'maple-schools.example' });
    const store = new MemoryStore();
    const warned = [];
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    await service.setPolicy('aiThreshold', 0.95, ADMIN);
    await service.alert('brake', '500 emails were moved within the hour.');
    assert.deepEqual(warned.map(w => w.spruceAlert), ['brake'], 'only the problem is emailed');
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const get = async (kind) => (await (await fetch(`http://127.0.0.1:${srv.address().port}/api/activity?days=7&kind=${kind}`)).json()).events;
    try {
        assert.deepEqual((await get('alert')).map(e => [e.kind, e.alert, e.adminAction]), [['brake', true, false]]);
        const mine = (await get('admin')).filter(e => e.kind !== 'signin');   // (0.5.29: opening the dashboard is noted too)
        assert.deepEqual(mine.map(e => [e.kind, !!e.alert, e.adminAction]), [['settings', false, true]]);
        assert.match(mine[0].text, /changed the AI move threshold/);
    } finally { await new Promise(r => srv.close(r)); }
});

test('problems that last are emailed at most once a day: a lookup service down 30 minutes, Google refusing the key', async () => {
    const { createThreats, OUTAGE_MS } = require('../src/intel/threats');
    const { createHttp } = require('../src/intel/http');
    const { createSafeBrowsingKey, memorySecrets } = require('../src/intel/sbkey');
    const E = require('../src/engine/spruce').load();
    let now = Date.UTC(2026, 10, 12, 15, 0);
    const store = new MemoryStore();
    const warned = [];
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', PILOT_USERS: `a@maple-schools.example` });
    const service = new Service({ cfg, store, gmail: {}, now: () => now, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    const t = createThreats({ http: createHttp({ fetch: async () => { throw new Error('network down'); } }), cfg: { cloudflareThreats: true }, engine: E, now: () => now });
    t.setAlert((name, text) => service.alertDaily(`${name}-down`, text));
    await t.checkHosts(['site-one.example']);
    now += 10 * 60 * 1000; await t.checkHosts(['site-two.example']);
    assert.equal(warned.length, 0, 'not after 10 minutes');
    now += OUTAGE_MS; await t.checkHosts(['site-three.example']);
    now += 60 * 1000; await t.checkHosts(['site-four.example']);
    assert.deepEqual(warned.map(w => w.spruceAlert), ['cloudflare-down'], 'once');
    assert.match(warned[0].message, /^Cloudflare Security's lookups have all failed for \d+ minutes/);
    // Google refusing the key: at once, once a day.
    const k = createSafeBrowsingKey({ cfg: {}, store, secrets: memorySecrets(), now: () => now, log: { error() {} } });
    k.setAlert((text) => service.alertDaily('safe-browsing-key', text));
    await k.noteResult(false, 'HTTP 400: API key not valid.');
    await k.noteResult(false, 'HTTP 400: API key not valid.');
    assert.deepEqual(warned.map(w => w.spruceAlert), ['cloudflare-down', 'safe-browsing-key']);
    assert.match(warned[1].message, /Google Safe Browsing refuses the saved API key \(HTTP 400: API key not valid\.\)/);
    now += 24 * 60 * 60 * 1000;
    await k.noteResult(false, 'HTTP 400: API key not valid.');
    assert.equal(warned.length, 3, 'and again the next day while it lasts');
});

test('an update from the dashboard that failed or never finished: emailed once by the hourly job', async () => {
    let now = Date.UTC(2026, 10, 12, 15, 0);
    const store = new MemoryStore();
    const warned = [];
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', PILOT_USERS: `a@maple-schools.example` });
    const service = new Service({ cfg, store, gmail: {}, now: () => now, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    await store.setState('update', { phase: 'failed', version: '9.9.9', from: '0.5.27', by: ADMIN, at: now - 60000, message: 'the image didn\'t build' });
    assert.match(await service.updateProblems(), /^The update from 0\.5\.27 to 9\.9\.9 failed: the image didn't build\./);
    assert.equal(await service.updateProblems(), null, 'once');
    assert.deepEqual(warned.map(w => w.spruceAlert), ['update-failed']);
    assert.equal((await store.listEvents(0)).length, 0, 'the build recorded it in Activity already');
    await store.setState('update', { phase: 'building', version: '9.9.10', by: ADMIN, at: now - 50 * 60 * 1000 });
    assert.match(await service.updateProblems(), /didn't finish within 45 minutes/);
    assert.deepEqual(warned.map(w => w.spruceAlert), ['update-failed', 'update-failed']);
    assert.equal((await store.listEvents(0)).filter(e => e.alert).length, 1, 'a stalled one is recorded as an alert');
    await store.setState('update', { phase: 'building', version: '9.9.11', by: ADMIN, at: now - 5 * 60 * 1000 });
    assert.equal(await service.updateProblems(), null, 'still running');
});

test('0.5.45: the daily chart\'s data: moved and would-move apart, by trigger, and both together; the summary says what would move them', () => {
    const A = require('../src/dashboard/aggregate');
    const now = Date.UTC(2026, 10, 13, 15);
    const at = now - 2 * 3600e3;
    const rec = (action, trigger, state = action === 'move' ? 'moved' : 'inbox') => ({ processedAt: at, action, trigger, state });
    const recs = [rec('move', 'rules+ai'), rec('move', 'ai'), rec('would-move', 'rules+ai'), rec('would-move', 'rules+ai'), rec('would-move', 'rules'), rec('flag', null), rec('move', 'admin')];
    const day = A.trend(recs, [{ day: A.dayOf(at), scanned: 1900 }], now, 2).pop();
    assert.deepEqual([day.scanned, day['rules+ai'], day['wm:rules+ai'], day['by:rules+ai'], day.ai, day['by:ai'], day['wm:rules'], day['by:rules'], day.admin, day.wouldMove, day.flagged],
        [1900, 1, 2, 3, 1, 1, 1, 1, 1, 3, 1]);
    const sm = A.summary(recs, [], now, 2);
    assert.deepEqual(sm.wouldMoveBy, { rules: 1, ai: 0, 'rules+ai': 2, admin: 0 });
    assert.deepEqual(sm.movedBy, { rules: 0, ai: 1, 'rules+ai': 1, admin: 1 });
});
