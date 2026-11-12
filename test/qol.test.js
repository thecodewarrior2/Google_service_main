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
    assert.match(raw, /^From: "S\.P\.R\.U\.C\.E Mail Protection Service" <spruce-directory@maple-schools\.example>$/m);
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
    const week = now - 7 * 24 * 3600 * 1000;   // (within the 32 days read first: test/retention.test.js has the longer periods)
    await store.saveRecord({ key: 'a', processedAt: now - 1000, action: 'flag' });
    assert.equal((await cache.list(week)).length, 1);
    await store.saveRecord({ key: 'b', processedAt: now, action: 'move' });
    assert.equal((await cache.list(week)).length, 1, 'within refreshMs: the copy');
    now += 2000;
    await new Promise(r => setTimeout(r, 2));
    assert.equal((await cache.list(week)).length, 2);
    await store.updateRecord('a', { action: 'move' });
    cache.stale();
    assert.equal((await cache.list(week)).find(r => r.key === 'a').action, 'move', 'changed records too');
    assert.equal(full, 1, 'read in full once'); assert.ok(changed >= 2);
});

test('review, suspicious queue: Phishing moves a suspicious email still in the Inbox to Spam in enforce mode only; not phishing, gone or monitor mode: nothing moved', async () => {
    const make = (mode) => {
        const store = new MemoryStore();
        const modified = [];
        const inInbox = new Set([`m0`, `m2`, `m3`]);
        const gmail = { labelId: async (u, n) => `L_${n}`, labels: async (u, id) => (inInbox.has(id) ? ['INBOX', 'UNREAD'] : ['CATEGORY_UPDATES']), modify: async (u, id, add, remove) => { modified.push({ id, add, remove }); return {}; } };
        const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `r@${ORG}`, MODE: mode });
        const svc = new Service({ cfg, store, gmail, log: { error() {} } });
        return { store, svc, modified };
    };
    const rec = (i, extra) => Object.assign({ key: `r@${ORG}|m${i}`, user: `r@${ORG}`, messageId: `m${i}`, processedAt: Date.now() - i * 1000, action: 'flag', state: 'inbox', trigger: null, falseAlarm: null, why: 'suspicious, below the move rules', sender: { address: 'billing@harbor-supply-invoices.example' } }, extra);
    let { store, svc, modified } = make('enforce');
    for (let i = 0; i < 4; i++) await store.saveRecord(rec(i));
    // Phishing, with move: moved to Spam with the service's label, the record says who and why, counted, in Activity.
    let out = await svc.mark(`r@${ORG}|m0`, false, `it.head@${ORG}`, { move: true });
    assert.equal(out.moved, 'moved');
    assert.deepEqual(modified, [{ id: 'm0', add: ['SPAM', 'L_SPRUCE/Moved'], remove: ['INBOX'] }]);
    assert.deepEqual([out.record.action, out.record.state, out.record.falseAlarm, out.record.markedBy, out.record.heldMovedBy], ['move', 'moved', false, `it.head@${ORG}`, `it.head@${ORG}`]);
    assert.match(out.record.why, /^suspicious, below the move rules; moved when it\.head@maple-schools\.example confirmed it as phishing$/);
    assert.equal(out.record.trigger, null, 'the AI and the rules didn\'t move it: an admin did');
    assert.ok((await store.listEvents()).some(e => e.kind === 'mark' && e.text === `it.head@${ORG} confirmed an email from billing@harbor-supply-invoices.example to r@${ORG} as phishing and moved it to Spam.`));
    assert.equal((await store.getStats('2000-01-01', '2999-12-31')).reduce((n, d) => n + (d.moved || 0), 0), 1);
    // Not in the Inbox any more (archived, deleted, moved by the user): marked, left where it is.
    out = await svc.mark(`r@${ORG}|m1`, false, `it.head@${ORG}`, { move: true });
    assert.equal(out.moved, 'gone'); assert.equal(out.record.state, 'inbox'); assert.equal(out.record.falseAlarm, false);
    // Not phishing: never moved, whatever move says.
    out = await svc.mark(`r@${ORG}|m2`, true, `it.head@${ORG}`, { move: true });
    assert.equal(out.moved, null); assert.equal(out.record.state, 'inbox');
    // Without move (as before): marked only.
    out = await svc.mark(`r@${ORG}|m3`, false, `it.head@${ORG}`);
    assert.equal(out.moved, null); assert.equal(out.record.state, 'inbox');
    assert.equal(modified.length, 1);
    // Already in Spam, or moved back by an admin (their decision stands): nothing moved.
    await store.saveRecord(rec(5, { state: 'released', action: 'move', releasedBy: `it.head@${ORG}` }));
    assert.equal((await svc.mark(`r@${ORG}|m5`, false, `it.head@${ORG}`, { move: true })).moved, 'not-in-inbox');
    // Monitor mode: nothing is moved, even by an admin's decision.
    ({ store, svc, modified } = make('monitor'));
    await store.saveRecord(rec(0));
    out = await svc.mark(`r@${ORG}|m0`, false, `it.head@${ORG}`, { move: true });
    assert.equal(out.moved, 'monitor'); assert.equal(out.record.state, 'inbox'); assert.equal(out.record.falseAlarm, false);
    assert.equal(modified.length, 0);
    // Several at once, in enforce mode: those still in the Inbox are moved, one entry in Activity.
    ({ store, svc, modified } = make('enforce'));
    for (let i = 0; i < 4; i++) await store.saveRecord(rec(i));
    const b = await svc.bulk([0, 1, 2].map(i => `r@${ORG}|m${i}`), 'phishing', `it.head@${ORG}`);
    assert.deepEqual(b, { done: 3, skipped: 0, failed: 0, moved: 2 });
    const ev = (await store.listEvents()).filter(e => e.kind === 'mark');
    assert.deepEqual(ev.map(e => e.text), [`it.head@${ORG} confirmed as phishing 3 emails at once (2 moved to Spam).`]);
});

test('dashboard: Review\'s suspicious queue (not moved, still in the Inbox, unreviewed, newest first), both counts, and the mode with an email', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: ORG });
    const { store } = await buildDemo({ cfg, now: Date.now() });
    const gmail = { labelId: async (u, n) => `L_${n}`, modify: async () => ({}) };
    const service = new Service({ cfg, store, gmail });
    const { base, close } = await serve(createApp({ cfg, store, service }));
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
    try {
        const moved = await get('/api/review?days=90');
        const sus = await get('/api/review?days=90&queue=suspicious');
        assert.equal(moved.queue, 'moved'); assert.equal(sus.queue, 'suspicious');
        assert.ok(sus.total > 0, 'the demo has suspicious emails');
        assert.deepEqual(sus.counts, { moved: moved.total, suspicious: sus.total }); assert.deepEqual(moved.counts, sus.counts);
        assert.equal(sus.mode, 'monitor');
        const msgs = [];
        for (const k of sus.keys) msgs.push(await get(`/api/message?key=${encodeURIComponent(k)}`));
        assert.ok(msgs.every(x => x.message.action === 'flag' && x.message.state === 'inbox' && !x.message.markedBy && x.mode === 'monitor'));
        assert.ok(msgs.every((x, i) => !i || msgs[i - 1].message.processedAt >= x.message.processedAt), 'newest first');
        assert.ok(!sus.keys.some(k => moved.keys.includes(k)), 'the two queues don\'t overlap');
        // Marked (monitor mode: not moved): out of the queue at once; the other queue is unchanged.
        const r = await post('/api/mark', { key: sus.keys[0], falseAlarm: false, move: true });
        assert.equal(r.moved, 'monitor'); assert.equal(r.record.state, 'inbox');
        const after = await get('/api/review?days=90&queue=suspicious');
        assert.equal(after.total, sus.total - 1); assert.equal(after.counts.moved, moved.total);
        await post('/api/mark', { key: sus.keys[1], falseAlarm: true });
        assert.equal((await get('/api/review?days=90&queue=suspicious')).total, sus.total - 2);
    } finally { await close(); }
});
