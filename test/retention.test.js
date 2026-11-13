'use strict';
// 0.5.0: how long records are kept (RETENTION_DAYS, 35 days by default), also changed on the dashboard
// (Settings → Policy); each record goes on its own date, the oldest first. And the dashboard's copy of the
// records: the last 32 days first, older ones when a page shows them. Every address is made up.
const test = require('node:test');
const assert = require('node:assert');
const { loadConfig, configProblems } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { RecordCache, OLDER_KEPT_MS } = require('../src/dashboard/cache');

const ORG = 'maple-schools.example';
const DAY = 24 * 60 * 60 * 1000;
const ENV = { STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `reader@${ORG}`, MODE: 'monitor', GOOGLE_CLOUD_PROJECT: 'maple-mail-protection' };

test('retention: 35 days by default, 14 to 365; changed on the dashboard, noted and alerted, and the cleanup follows it', async () => {
    assert.equal(loadConfig(ENV).retentionDays, 35);
    assert.equal(loadConfig(Object.assign({ RETENTION_DAYS: '90' }, ENV)).retentionDays, 90);
    for (const bad of ['7', '400', '30.5']) {
        assert.ok(configProblems(loadConfig(Object.assign({ RETENTION_DAYS: bad }, ENV))).some(p => /RETENTION_DAYS must be a whole number of days from 14 to 365/.test(p)), bad);
    }
    const store = new MemoryStore();
    const warned = [];
    const svc = new Service({ cfg: loadConfig(ENV), store, gmail: {}, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    for (const bad of [13, 366, 20.5, 'a month']) await assert.rejects(svc.setPolicy('retentionDays', bad, 'x'), { status: 400, message: /from 14 to 365/ });
    // Records of the last 40 days, one a day.
    for (let d = 0; d < 40; d++) await store.saveRecord({ key: `reader@${ORG}|m${d}`, user: `reader@${ORG}`, processedAt: Date.now() - d * DAY - 1000, action: 'flag' });
    // Longer: kept from now on; the ones saved keep their date.
    assert.deepEqual(await svc.setPolicy('retentionDays', 60, `it.head@${ORG}`), { key: 'retentionDays', value: 60, before: 35 });
    assert.equal(svc.cfg.retentionDays, 60);
    assert.equal(await svc.purge(), 0, 'nothing is older than 60 days');
    // Shorter: the older ones go, the oldest first (the cleanup, hourly with sync-feeds).
    await svc.setPolicy('retentionDays', 30, `it.head@${ORG}`);
    assert.equal(await svc.purge(), 10);
    assert.equal((await store.listRecords({ sinceMs: 0, limit: 100 })).length, 30);
    const ev = (await store.listEvents()).filter(e => e.kind === 'settings').map(e => e.text);
    assert.ok(ev.includes(`it.head@${ORG} changed how long records are kept from 35 days to 60 days on the dashboard (confirmed with the project ID). Records saved from now on are kept 60 days; the ones already saved keep the date they had (35 days after they arrived).`));
    assert.ok(ev.includes(`it.head@${ORG} changed how long records are kept from 60 days to 30 days on the dashboard (confirmed with the project ID). Records older than 30 days are deleted over the next hours, the oldest first.`));
    assert.deepEqual(warned, [], '0.5.28: noted under What admins did, not emailed');
    // Another instance (the worker) takes it at its next refresh; Settings shows where it comes from.
    const other = new Service({ cfg: loadConfig(ENV), store, gmail: {}, log: { error() {} } });
    await other.refreshPolicy({ force: true });
    assert.equal(other.cfg.retentionDays, 30);
    assert.deepEqual([other.policyInfo().retentionDays.value, other.policyInfo().retentionDays.env, other.policyInfo().retentionDays.changed.by], [30, 35, `it.head@${ORG}`]);
});

test('retention: Firestore documents expire after the setting in force when they are written', { skip: !(() => { try { require.resolve('@google-cloud/firestore'); return true; } catch (e) { return false; } })() }, () => {
    const { FirestoreStore } = require('../src/store/firestore');
    const cfg = loadConfig(Object.assign({}, ENV, { STORE: 'firestore' }));
    const store = new FirestoreStore(cfg);   // (no call reaches Firestore here)
    assert.equal(store.expiry(0).toMillis(), 35 * DAY);
    cfg.setPolicyValues(Object.assign({}, cfg.envPolicy, { retentionDays: 90 }));
    assert.equal(store.expiry(0).toMillis(), 90 * DAY, 'the dashboard\'s value, once in force');
    assert.equal(store.expiry(0, 2 * DAY).toMillis(), 2 * DAY, 'the brake\'s counters keep their own');
});

test('the dashboard\'s copy of the records: the last 32 days first, older ones when a page shows them (and forgotten after an hour without), never past retention', async () => {
    const store = new MemoryStore();
    let now = Date.UTC(2026, 9, 1, 12);
    for (let d = 0; d < 100; d++) await store.saveRecord({ key: `k${d}`, user: `reader@${ORG}`, processedAt: now - d * DAY - 1000, action: 'flag' });
    const reads = [];
    const listRecords = store.listRecords.bind(store);
    store.listRecords = async (o) => { reads.push([Math.round((now - o.sinceMs) / DAY), o.untilMs === Number.MAX_SAFE_INTEGER ? null : Math.round((now - o.untilMs) / DAY)]); return listRecords(o); };
    let keep = 92;
    const cache = new RecordCache(store, { keepDays: () => keep, refreshMs: 1000, now: () => now });
    // The Overview (30 days, from the midnight before): read once, 32 days.
    assert.equal((await cache.list(now - 31 * DAY)).length, 31);
    assert.deepEqual(reads, [[32, null]]);
    assert.equal(cache.byKey.size, 32);
    // Last 90 days: the older ones read once, then from the copy.
    assert.equal((await cache.list(now - 90 * DAY)).length, 90);
    assert.deepEqual(reads, [[32, null], [90, 32]]);
    assert.equal((await cache.list(now - 90 * DAY)).length, 90);
    assert.equal(reads.length, 2);
    // An hour without a page that needs them: forgotten (the next one reads them again).
    now += OLDER_KEPT_MS + 2000;
    assert.equal((await cache.list(now - 31 * DAY)).length, 31);
    assert.ok(cache.byKey.size <= 33, String(cache.byKey.size));
    assert.equal(reads.length, 2, 'the 30 days need no read');
    assert.equal((await cache.list(now - 90 * DAY)).length, 90, 'read again');
    assert.equal(reads.length, 3);
    // Retention lowered on the dashboard (to 20 days): the copy forgets what is older, and a longer period
    // shows 20 days.
    keep = 20;
    now += 2000;
    assert.equal((await cache.list(now - 90 * DAY)).length, 20);
    assert.ok([...cache.byKey.values()].every(r => r.processedAt >= now - 20 * DAY));
    assert.equal(reads.length, 3, 'nothing read: it was in the copy');
    // Raised again: the days between are read when a page asks.
    keep = 92;
    assert.equal((await cache.list(now - 31 * DAY)).length, 31);
    assert.equal(reads.length, 4);
    // A record changed long ago (older than the copy holds) isn't kept by the update; it is read with its period.
    await store.updateRecord('k80', { action: 'move' });
    now += 2000;
    await cache.list(now - 31 * DAY);
    assert.ok(!cache.byKey.has('k80'));
    assert.equal((await cache.list(now - 90 * DAY)).find(r => r.key === 'k80').action, 'move');
});
