'use strict';
// 0.5.22: a phishing list that misses its download. Each list's last download is kept (when, the error, since
// when, how often); the overview says so with a link to Settings → About, which highlights the list with a red
// alert icon and has a Re-check button; the admins get an alert (emailed to ALERT_EMAIL), when a list newly
// fails and once a day while it keeps failing; a failing list is tried again every 3 hours. Made-up lists only.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const spruce = require('../src/engine/spruce');
const { createHttp } = require('../src/intel/http');
const { createFeeds, STALE_MS } = require('../src/intel/feeds');
const { MemoryStore } = require('../src/store/memory');
const { Service } = require('../src/pipeline');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');
const { buildDemo } = require('../src/demo/seed');

const E = spruce.load();
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const text = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body), headers: { get: () => null } });
const lines = (f) => Array.from({ length: 30 }, (_, i) => f(i)).join('\n');
// Every list answers, except those `down` names (503).
function net(down) {
    const calls = [];
    const fetch = async (url) => {
        const u = new URL(url); calls.push(u.host + u.pathname);
        const id = u.host === 'phishing.army' ? 'phishingarmy' : u.pathname.startsWith('/openphish/') ? 'openphish' : u.pathname.startsWith('/hagezi/') ? 'hagezitif' : u.pathname.startsWith('/0xDanielLopez/') ? 'tweetfeed' : 'sefinekemails';
        if (down.has(id)) return text('Service Unavailable', 503);
        if (id === 'openphish') return text(lines(i => `https://p${i}.example/x`));
        if (id === 'tweetfeed') return text(lines(i => `2026-11-01 00:00:00,researcher,domain,rep${i}.example,#phishing,https://x.com/r/${i}`));
        if (id === 'sefinekemails') return text(lines(i => `s${i}@scam.example`));
        return text(lines(i => `bad${i}.example`));
    };
    return { fetch, calls };
}
const silent = { error() {}, warn() {} };

test('a list that misses its download: kept with its error, since when and how often; the previous copy stays; the next success clears it', async () => {
    const down = new Set();
    const n = net(down);
    const store = new MemoryStore();
    let now = Date.UTC(2026, 10, 10, 6);
    const feeds = createFeeds({ http: createHttp({ fetch: n.fetch }), store, engine: E, now: () => now, log: silent });
    await feeds.sync();
    assert.ok((await feeds.status()).every(l => !l.missed && !l.error && l.lastAttempt === now));
    now += DAY; down.add('hagezitif');
    const r1 = await feeds.sync();
    assert.deepEqual(r1.feeds.filter(f => f.error).map(f => [f.id, f.name, f.error, f.newly]), [['hagezitif', 'HaGeZi Threat Intelligence Feeds', 'HTTP 503', true]]);
    let hz = (await feeds.status()).find(l => l.id === 'hagezitif');
    assert.deepEqual([hz.missed, hz.error, hz.failedSince, hz.failures, hz.updated, hz.count > 20], ['failed', 'HTTP 503', now, 1, now - DAY, true], 'the copy from the day before is kept');
    const firstFail = now;
    now += 3 * HOUR;
    assert.deepEqual((await feeds.sync()).feeds.filter(f => !f.skipped).map(f => f.id), ['hagezitif'], 'the others are recent: only the failing one (its copy is a day old)');
    now += 1 * HOUR;
    const r2 = await feeds.sync({ retryFailed: true, only: ['hagezitif'] });
    assert.deepEqual(r2.feeds.map(f => [f.id, f.newly]), [['hagezitif', false]]);
    hz = (await feeds.status()).find(l => l.id === 'hagezitif');
    assert.deepEqual([hz.failures, hz.failedSince], [3, firstFail], 'counted, since its first failure');
    // It comes back: cleared, noted in Activity.
    now += HOUR; down.delete('hagezitif');
    const r3 = await feeds.sync({ retryFailed: true });
    assert.deepEqual(r3.recovered, ['HaGeZi Threat Intelligence Feeds']);
    assert.deepEqual(r3.feeds.filter(f => !f.skipped).map(f => f.id), ['hagezitif'], 'Re-check downloads only what needs it');
    hz = (await feeds.status()).find(l => l.id === 'hagezitif');
    assert.deepEqual([hz.missed, hz.error, hz.failures, hz.updated], [null, null, 0, now]);
    const ev = (await store.listEvents(0)).map(e => e.text);
    assert.ok(ev.some(t => /^HaGeZi Threat Intelligence Feeds downloaded again \(30 entries\), after missing its download since 2026-11-11 06:00 UTC\.$/.test(t)), ev.join('\n'));
    assert.ok(ev.some(t => /HaGeZi Threat Intelligence Feeds could not be updated \(HTTP 503\)/.test(t)));
    // Not downloaded for over two days (the daily job isn't running): "stale".
    now += STALE_MS + HOUR;
    assert.ok((await feeds.status()).every(l => l.missed === 'stale'));
});

test('the hourly job: an alert when a list newly misses its download, once a day while it keeps failing; retried every 3 hours', async () => {
    const down = new Set(['tweetfeed']);
    const n = net(down);
    const store = new MemoryStore();
    let now = Date.UTC(2026, 10, 10, 6);
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', PILOT_USERS: 'a@maple-schools.example' });
    const alerts = [];
    const svc = new Service({ cfg, store, gmail: {}, now: () => now, log: { error() {}, warn: (l) => alerts.push(JSON.parse(l)) } });
    svc.intel = { feeds: createFeeds({ http: createHttp({ fetch: n.fetch }), store, engine: E, now: () => now, log: silent }) };
    svc.health = async () => ({});
    svc.purge = async () => 0;
    const listAlerts = () => alerts.filter(a => a.spruceAlert === 'list-download');
    await svc.syncFeeds();
    assert.equal(listAlerts().length, 1);
    assert.equal(listAlerts()[0].message, 'A phishing list missed its download: TweetFeed (researchers\' reports) (HTTP 503). The previous copy is still used, and the download is tried again every 3 hours. Dashboard: Settings → About shows each list\'s state, with a Re-check button.');
    assert.ok((await store.listEvents(0)).some(e => e.alert && e.kind === 'list-download'), 'in Recent activity too');
    // An hour later: not yet retried; three hours later: only TweetFeed, and no second alert the same day.
    now += HOUR; n.calls.length = 0;
    assert.equal((await svc.syncFeeds()).skipped, 'checked within the day');
    now += 2 * HOUR;
    const retry = await svc.syncFeeds();
    assert.equal(retry.retry, true);
    assert.deepEqual(n.calls, ['raw.githubusercontent.com/0xDanielLopez/TweetFeed/master/month.csv']);
    assert.equal(listAlerts().length, 1, 'not again within the day');
    // The next day's download: another list newly fails: an alert at once, naming both.
    now += 18 * HOUR; down.add('phishingarmy');
    assert.equal((await svc.syncFeeds()).retry, undefined, 'the daily download');
    assert.equal(listAlerts().length, 2);
    assert.match(listAlerts()[1].message, /^2 phishing lists missed their download: Phishing Army \(extended\) \(HTTP 503\); TweetFeed \(researchers' reports\) \(HTTP 503\)\./);
    // A day on, still failing: a reminder.
    now += DAY + HOUR;
    await svc.syncFeeds();
    assert.equal(listAlerts().length, 3);
    // Back: no alert, noted in Activity.
    down.clear(); now += 3 * HOUR;
    const back = await svc.syncFeeds();
    assert.deepEqual(back.recovered.sort(), ['Phishing Army (extended)', 'TweetFeed (researchers\' reports)']);
    assert.equal(listAlerts().length, 3);
    assert.ok((await svc.intel.feeds.status()).every(l => !l.missed));
});

test('dashboard: the overview names the lists that missed their download; Re-check downloads them again (at most once a minute)', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: 'maple-schools.example' });
    const { store, intel } = await buildDemo({ cfg, now: Date.now() });
    const service = new Service({ cfg, store, gmail: {}, intel });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const post = (p, hdr = true) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, hdr ? { 'x-requested-with': 'spruce-dashboard' } : {}), body: '{}' });
    try {
        const o = await get('/api/overview?days=30');
        assert.deepEqual(o.missedLists.map(l => [l.id, l.missed, l.error]), [['hagezitif', 'failed', 'HTTP 503']]);
        const st = await get('/api/settings');
        assert.deepEqual(st.lists.filter(l => !l.optional).map(l => l.id), ['openphish', 'phishingarmy', 'hagezitif', 'tweetfeed', 'sefinekemails']);
        // (abuse.ch's, 0.5.37: listed, off until turned on with a key)
        assert.deepEqual(st.lists.filter(l => l.optional).map(l => [l.id, l.off]), [['urlhaus', true], ['threatfoxdomains', true], ['threatfoxurls', true]]);
        assert.equal(st.lists.find(l => l.id === 'tweetfeed').confidence, 'report');
        assert.equal((await post('/api/lists/recheck', false)).status, 403, 'only from the dashboard');
        const r = await post('/api/lists/recheck');
        assert.equal(r.status, 200);
        const out = await r.json();
        assert.deepEqual(out.recovered, ['HaGeZi Threat Intelligence Feeds']);
        assert.ok(out.lists.every(l => !l.missed));
        assert.deepEqual((await get('/api/overview?days=30')).missedLists, []);
        assert.equal((await post('/api/lists/recheck')).status, 429, 'at most once a minute');
        assert.ok((await store.listEvents(0)).some(e => e.kind === 'lists' && /re-checked the phishing lists: HaGeZi Threat Intelligence Feeds downloaded\./.test(e.text)));
    } finally { await new Promise(r => srv.close(r)); }
});
