'use strict';
// 0.5.27: the dashboard's days are the organization's (TIME_ZONE, Settings → Policy), not UTC's. In New York,
// 10:13 PM on Thursday 12 November is 03:13 UTC on the 13th: it counts on the 12th. Made-up data only.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const A = require('../src/dashboard/aggregate');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/server');

const EVENING = Date.UTC(2026, 10, 13, 3, 13);   // 10:13 PM, 12 Nov 2026, in New York (EST)

test('a day in the organization\'s time zone; UTC when none is set or it is unknown', () => {
    assert.equal(A.dayIn(EVENING, 'America/New_York'), '2026-11-12');
    assert.equal(A.dayIn(EVENING, 'UTC'), '2026-11-13');
    assert.equal(A.dayIn(EVENING, ''), '2026-11-13');
    assert.equal(A.dayIn(EVENING, 'Not/AZone'), '2026-11-13');
    assert.equal(A.dayIn(EVENING, 'Pacific/Kiritimati'), '2026-11-13');   // UTC+14: already the 13th afternoon
    assert.equal(A.dayIn(Date.UTC(2026, 10, 12, 23, 30), 'Pacific/Kiritimati'), '2026-11-13');
    // Calendar arithmetic, the same anywhere, across month ends and clock changes.
    assert.deepEqual([A.addDays('2026-11-01', -1), A.addDays('2026-10-31', 1), A.addDays('2026-12-31', 1), A.addDays('2026-03-08', 1)], ['2026-10-31', '2026-11-01', '2027-01-01', '2026-03-09']);
});

test('the chart: emails and daily counters on the organization\'s days, each day once, across the clock change', () => {
    A.setTimeZone('America/New_York');
    try {
        const records = [{ processedAt: EVENING, action: 'would-move', trigger: 'ai', user: 'a@maple-schools.example' }];
        const t = A.trend(records, [{ day: '2026-11-12', scanned: 24 }], EVENING, 3);
        assert.deepEqual(t.map(d => d.day), ['2026-11-10', '2026-11-11', '2026-11-12'], 'today is the 12th in New York');
        assert.deepEqual([t[2].scanned, t[2].wouldMove], [24, 1]);
        // 1 November 2026: clocks go back at 2 AM (a 25-hour day). Just before midnight on the 1st, the last
        // three days are the 30th, the 31st and the 1st, each once.
        const late = Date.UTC(2026, 10, 2, 4, 50);   // 11:50 PM EST, 1 Nov
        assert.deepEqual(A.trend([], [], late, 3).map(d => d.day), ['2026-10-30', '2026-10-31', '2026-11-01']);
        A.setTimeZone('UTC');
        assert.deepEqual(A.trend([], [], EVENING, 1).map(d => d.day), ['2026-11-13'], 'UTC as before');
    } finally { A.setTimeZone('UTC'); }
});

test('the worker counts each email on the organization\'s day (the daily counters), and follows a time zone changed on the dashboard', async () => {
    const store = new MemoryStore();
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', PILOT_USERS: 'a@maple-schools.example', TIME_ZONE: 'America/New_York' });
    const svc = new Service({ cfg, store, gmail: {}, now: () => EVENING, log: { error() {}, warn() {} } });
    assert.equal(svc.dayOf(EVENING), '2026-11-12');
    await svc.count(svc.dayOf(EVENING), 'scanned');
    assert.deepEqual((await store.getStats('2026-11-12', '2026-11-13')).map(s => [s.day, s.scanned]), [['2026-11-12', 1]]);
    await svc.setPolicy('timeZone', 'Asia/Tokyo', 'admin@maple-schools.example');
    assert.equal(svc.dayOf(EVENING), '2026-11-13', '12:13 PM on the 13th in Tokyo');
});

test('the dashboard\'s overview ends on today in the organization\'s time zone', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: 'maple-schools.example', TIME_ZONE: 'America/New_York' });
    const store = new MemoryStore();
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn() {} } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    try {
        const o = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/overview?days=7`)).json();
        assert.equal(o.trend.length, 7);
        assert.equal(o.trend[6].day, A.dayIn(Date.now(), 'America/New_York'));
        assert.equal(new Set(o.trend.map(d => d.day)).size, 7);
    } finally { await new Promise(r => srv.close(r)); A.setTimeZone('UTC'); }
});
