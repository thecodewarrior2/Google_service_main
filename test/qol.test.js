'use strict';
// 0.3.1: the weekly summary email, bulk actions, the review queue, what needs an admin, the Status page's
// checks, and the dashboard's record cache. Every address is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/server');
const { buildDemo } = require('../src/demo/seed');
const { RecordCache } = require('../src/dashboard/cache');
const { buildDigest, isSummary } = require('../src/digest');

const ORG = 'maple-schools.example';
const PHISH = fs.readFileSync(path.join(__dirname, 'fixtures', 'phish-storage.eml'));
const DAY = 24 * 60 * 60 * 1000;
async function serve(app) {
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, r));
    return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) };
}
const H = { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' };

test('the weekly summary: off by default; Monday from 7 AM in TIME_ZONE, once a week; into each admin\'s Inbox; never judged', async () => {
    const store = new MemoryStore();
    const inserted = [];
    const gmail = {
        groupMembers: async () => [`a.lee@${ORG}`, `outside@elsewhere.example`],
        insert: async (user, raw, labels) => { inserted.push({ user, raw: Buffer.from(raw).toString('utf8'), labels }); return { id: `ins${inserted.length}` }; },
        labelId: async (u, n) => `L_${n}`, modify: async () => ({})
    };
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `reader@${ORG}`, MODE: 'monitor', TIME_ZONE: 'America/New_York', ADMIN_EMAILS: `it.head@${ORG}`, ADMIN_GROUP: `spruce-admins@${ORG}`, DIRECTORY_ADMIN: `spruce-directory@${ORG}`, DASHBOARD_URL: 'https://spruce-admin-1.us-east1.run.app' });
    let now = Date.parse('2026-11-09T11:30:00Z');   // Monday 6:30 AM in New York
    const svc = new Service({ cfg, store, gmail, now: () => now, log: { error() {} } });
    assert.equal(await svc.maybeDigest(), null, 'off by default');
    await svc.setDigest(true, `it.head@${ORG}`);
    assert.ok((await store.listEvents()).some(e => e.kind === 'settings' && /turned the weekly summary email on/.test(e.text)));
    assert.equal(await svc.maybeDigest(), null, 'not before 7 AM');
    now = Date.parse('2026-11-09T12:23:00Z');       // 7:23 AM
    const out = await svc.maybeDigest();
    assert.deepEqual(out.to.sort(), [`a.lee@${ORG}`, `it.head@${ORG}`], 'the admins in the organization only');
    assert.equal(out.sent, 2);
    assert.deepEqual(inserted[0].labels, ['INBOX', 'UNREAD']);
    const raw = inserted[0].raw;
    assert.match(raw, /^From: "S\.P\.R\.U\.C\.E\+ Mail Protection" <spruce-directory@maple-schools\.example>$/m);
    assert.match(raw, /^Subject: S\.P\.R\.U\.C\.E\+ weekly summary: 0 would be moved, Nov 2 to Nov 9$/m);
    const body = Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.match(body, /monitor mode: nothing is moved/); assert.match(body, /https:\/\/spruce-admin-1\.us-east1\.run\.app/); assert.match(body, /Turn it off there/);
    assert.ok(isSummary(Buffer.from(raw)), 'the service knows its own summary');
    assert.equal(await store.seen(inserted[0].user, 'ins1'), true, 'and never claims it to judge it');
    assert.equal(await store.seen(inserted[1].user, 'ins2'), true);
    now += 3600 * 1000;
    assert.equal(await svc.maybeDigest(), null, 'once a week');
    now = Date.parse('2026-11-10T12:23:00Z');
    assert.equal(await svc.maybeDigest(), null, 'Mondays only');
    // A summary that reaches a watched mailbox's history isn't judged.
    const g2 = Object.assign({}, gmail, { raw: async (u, id) => ({ id, threadId: 't', labelIds: ['INBOX'], historyId: null, internalDate: now, raw: Buffer.from(raw) }) });
    const svc2 = new Service({ cfg, store: new MemoryStore(), gmail: g2, log: { error() {} } });
    assert.equal(await svc2.checkMessage(`reader@${ORG}`, 'x1', 1), null);
    await svc.setDigest(false, `it.head@${ORG}`);
    now = Date.parse('2026-11-16T12:23:00Z');
    assert.equal(await svc.maybeDigest(), null, 'off again');
});

test('the summary\'s text: the week\'s numbers, what waits, the largest campaigns; enforce or monitor', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    const r = (i, extra) => Object.assign({ key: `k${i}`, user: `u${i}@${ORG}`, processedAt: now - DAY, campaign: 'c1', campaignLabel: 'bad.example: invoice', action: 'move', state: 'moved', evidence: 'strong', score: 9, sender: { address: 'x@bad.example' } }, extra);
    const recs = [r(1), r(2), r(3, { markedBy: 'it@x', falseAlarm: true }), r(4, { action: 'flag', state: 'inbox' })];
    const d = buildDigest(recs, [{ day: '2026-11-08', scanned: 1234 }], [{ at: now - DAY, alert: true }], { now, mode: 'enforce', timeZone: 'UTC', watched: 40, held: 1, brake: false });
    assert.match(d.subject, /^S\.P\.R\.U\.C\.E\+ weekly summary: 3 moved to Spam, Nov 2 to Nov 9$/);
    for (const re of [/Checked: 1,234 emails, in 40 watched mailboxes\./, /Moved to Spam: 3\. Recorded as "would move" \(monitor mode, or left in the Inbox by a brake\): 0\. On strong evidence: 3 of these 3\./, /Suspicious only \(not moved\): 1\./, /Marked as false alarms: 1\./,
        /Alerts: 1 /, /Waiting for you: moving paused for 1 campaign, waiting for your decision; 2 emails not reviewed yet/, /bad\.example: invoice \(4 copies, 3 moved\)/]) assert.match(d.text, re);
});

test('several emails at once: release and mark, with what was skipped; one entry in Activity', async () => {
    const store = new MemoryStore();
    const gmail = { labelId: async (u, n) => `L_${n}`, modify: async () => ({}) };
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `r@${ORG}`, MODE: 'enforce' });
    const svc = new Service({ cfg, store, gmail, log: { error() {} } });
    for (let i = 0; i < 4; i++) await store.saveRecord({ key: `r@${ORG}|m${i}`, user: `r@${ORG}`, messageId: `m${i}`, processedAt: Date.now(), action: 'move', state: i < 3 ? 'moved' : 'inbox', falseAlarm: null, sender: { address: 'x@bad.example' } });
    const out = await svc.bulk([0, 1, 2, 3].map(i => `r@${ORG}|m${i}`), 'release', `it@${ORG}`);
    assert.deepEqual(out, { done: 3, skipped: 1, failed: 0 });
    assert.equal((await store.listEvents()).filter(e => e.kind === 'release').length, 1, 'one entry, not one per email');
    const m = await svc.bulk([`r@${ORG}|m0`, `r@${ORG}|m3`], 'phishing', `it@${ORG}`);
    assert.equal(m.done, 2);
    assert.equal((await store.getRecord(`r@${ORG}|m3`)).falseAlarm, false);
});

test('dashboard: the review list, what needs an admin, the summary\'s switch and preview, bulk; the Status page\'s checks', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: ORG });
    const { store } = await buildDemo({ cfg, now: Date.now() });
    const gmail = { labelId: async (u, n) => `L_${n}`, modify: async () => ({}) };
    const service = new Service({ cfg, store, gmail });
    let iap = false;
    const cloudrun = { service: async () => ({ iap, image: `x:${require('../package.json').version}-src1`, url: '' }), invokers: async () => ['serviceAccount:spruce-invoker@demo.iam.gserviceaccount.com'] };
    const { base, close } = await serve(createApp({ cfg, store, service, cloudrun }));
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
    try {
        const rv = await get('/api/review?days=90');
        assert.ok(rv.total > 0 && rv.keys.length === Math.min(rv.total, 1000));
        const first = (await get(`/api/message?key=${encodeURIComponent(rv.keys[0])}`)).message;
        assert.ok(!first.markedBy && (first.action === 'would-move' || first.action === 'move'));
        const p = await get('/api/pending');
        assert.equal(typeof p.total, 'number'); assert.equal(p.unreviewed, (await get('/api/review?days=30')).total);
        // Marked through the dashboard: the list (from the cache) knows at once.
        await post('/api/mark', { key: rv.keys[0], falseAlarm: true });
        assert.equal((await get('/api/review?days=90')).total, rv.total - 1);
        const b = await (await post('/api/bulk', { action: 'phishing', keys: rv.keys.slice(1, 4) })).json();
        assert.equal(b.done, 3);
        assert.equal((await get('/api/review?days=90')).total, rv.total - 4);
        assert.equal((await post('/api/bulk', { action: 'delete', keys: rv.keys })).status, 400);
        // The weekly summary: off, then on (Activity says who), a preview.
        assert.equal((await get('/api/settings')).digest.enabled, false);
        await post('/api/digest', { enabled: true });
        const st = await get('/api/settings');
        assert.equal(st.digest.enabled, true); assert.match(st.digest.updatedBy, /^demo-admin/);
        assert.equal(st.timeZone, 'UTC');
        const pv = (await get('/api/digest/preview')).preview;
        assert.match(pv.subject, /^S\.P\.R\.U\.C\.E\+ weekly summary: \d+ would be moved, /);
        assert.equal((await (await post('/api/digest/send', {})).json()).demo, true);
        assert.equal((await post('/api/digest/send', {})).status, 429, 'not twice in a minute');
        // Status: works, then Identity-Aware Proxy on the worker shows as a problem with what to do.
        let s = (await get('/api/status')).checks;
        assert.equal(s.find(c => c.id === 'iap').ok, true); assert.equal(s.find(c => c.id === 'version').ok, true); assert.equal(s.find(c => c.id === 'invoker').ok, true);
        iap = true;
        s = (await get('/api/status')).checks;
        const c = s.find(x => x.id === 'iap');
        assert.equal(c.ok, false); assert.match(c.fix, /--no-iap/);
    } finally { await close(); }
});

test('the dashboard\'s record cache: one full read, then only what changed', async () => {
    const store = new MemoryStore();
    let full = 0, changed = 0;
    const listRecords = store.listRecords.bind(store), listChanged = store.listRecordsChangedSince.bind(store);
    store.listRecords = async (o) => { full++; return listRecords(o); };
    store.listRecordsChangedSince = async (ms, n) => { changed++; return listChanged(ms, n); };
    let now = Date.now();
    const cache = new RecordCache(store, { refreshMs: 1000, now: () => now });
    await store.saveRecord({ key: 'a', processedAt: now - 1000, action: 'flag' });
    assert.equal((await cache.list(0)).length, 1);
    await store.saveRecord({ key: 'b', processedAt: now, action: 'move' });
    assert.equal((await cache.list(0)).length, 1, 'within refreshMs: the copy');
    now += 2000;
    await new Promise(r => setTimeout(r, 2));
    assert.equal((await cache.list(0)).length, 2);
    await store.updateRecord('a', { action: 'move' });
    cache.stale();
    assert.equal((await cache.list(0)).find(r => r.key === 'a').action, 'move', 'changed records too');
    assert.equal(full, 1, 'read in full once'); assert.ok(changed >= 2);
});
