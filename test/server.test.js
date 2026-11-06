'use strict';
// The HTTP service: who may call what, and the dashboard API on the demo data.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp } = require('../src/server');
const { loadConfig, configProblems } = require('../src/config');
const { buildDemo } = require('../src/demo/seed');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const A = require('../src/dashboard/aggregate');

async function serve(app) {
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    return { base, close: () => new Promise(r => srv.close(r)) };
}
const gmail = { labelId: async (u, n) => `L_${n}`, modify: async () => ({}) };

test('real configuration: no IAP, no dashboard; no OIDC, no Pub/Sub or tasks; health check open', async () => {
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', PILOT_USERS: 'a@maple-schools.example', IAP_AUDIENCE: '/projects/1/global/backendServices/2', ADMIN_EMAILS: 'admin@maple-schools.example', PUSH_AUDIENCE: 'https://svc.example/pubsub/push', PUSH_SERVICE_ACCOUNT: 'push@proj.iam.gserviceaccount.com' });
    const store = new MemoryStore();
    const { base, close } = await serve(createApp({ cfg, store, service: new Service({ cfg, store, gmail }) }));
    try {
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        assert.equal((await fetch(`${base}/api/overview`)).status, 401);
        assert.equal((await fetch(`${base}/`)).status, 401);
        assert.equal((await fetch(`${base}/api/overview`, { headers: { 'x-goog-iap-jwt-assertion': 'forged.jwt.value' } })).status, 401);
        assert.equal((await fetch(`${base}/pubsub/push`, { method: 'POST', body: '{}' })).status, 403);
        assert.equal((await fetch(`${base}/pubsub/push`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer not.a.token' } })).status, 403);
        assert.equal((await fetch(`${base}/tasks/purge`, { method: 'POST' })).status, 403);
        const res = await fetch(`${base}/healthz`);
        assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    } finally { await close(); }
});

test('roles: the worker has no dashboard; the admin service has no Pub/Sub or task routes; each needs only its own settings', async () => {
    const common = { STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', DELEGATED_SA: 'd@p.iam.gserviceaccount.com' };
    const worker = loadConfig(Object.assign({ ROLE: 'worker', PILOT_USERS: 'a@maple-schools.example', PUBSUB_TOPIC: 'projects/p/topics/t', PUSH_AUDIENCE: 'https://w', PUSH_SERVICE_ACCOUNT: 'push@p.iam.gserviceaccount.com' }, common));
    const admin = loadConfig(Object.assign({ ROLE: 'admin', IAP_AUDIENCE: '/projects/1/locations/r/services/s', ADMIN_EMAILS: 'admin@maple-schools.example' }, common));
    assert.deepEqual(configProblems(worker), []); assert.deepEqual(configProblems(admin), []);
    for (const [cfg, open, closed] of [[worker, '/pubsub/push', '/api/overview'], [admin, '/api/overview', '/tasks/purge']]) {
        const store = new MemoryStore();
        const { base, close } = await serve(createApp({ cfg, store, service: new Service({ cfg, store, gmail }) }));
        try {
            assert.equal((await fetch(base + closed, { method: closed.startsWith('/api') ? 'GET' : 'POST' })).status, 404, `${cfg.role}: ${closed}`);
            assert.notEqual((await fetch(base + open, { method: open.startsWith('/api') ? 'GET' : 'POST' })).status, 404, `${cfg.role}: ${open}`);
            assert.equal((await fetch(`${base}/`)).status, cfg.role === 'worker' ? 404 : 401);
        } finally { await close(); }
    }
});

test('demo dashboard API: numbers agree with the records; release and marks work; POST needs the dashboard header; no path tricks', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'enforce', ORG_DOMAINS: 'maple-schools.example' });
    const { store } = await buildDemo({ cfg, now: Date.now() });
    const service = new Service({ cfg, store, gmail });
    const { base, close } = await serve(createApp({ cfg, store, service }));
    const get = async (p) => (await fetch(base + p)).json();
    const post = (p, body, hdr = true) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, hdr ? { 'x-requested-with': 'spruce-dashboard' } : {}), body: JSON.stringify(body) });
    try {
        const o = await get('/api/overview?days=30');
        const recs = await store.listRecords({});
        assert.equal(o.summary.moved, recs.filter(r => r.action === 'move').length);
        assert.equal(o.trend.length, 30);
        assert.ok(o.summary.scanned > 1000);
        assert.ok(o.campaigns[0].recipients >= o.campaigns[1].recipients);
        const camps = (await get('/api/campaigns?days=30')).campaigns;
        const msgs = await get(`/api/messages?days=30&campaign=${camps[0].campaign}`);
        assert.equal(msgs.total, camps[0].messages);
        const moved = msgs.messages.find(m => m.state === 'moved');
        assert.equal((await post('/api/release', { key: moved.key }, false)).status, 403, 'a POST without the dashboard header is refused');
        const rel = await (await post('/api/release', { key: moved.key })).json();
        assert.equal(rel.record.state, 'released'); assert.equal(rel.record.releasedBy, 'demo-admin@example.org');
        assert.equal((await post('/api/release', { key: moved.key })).status, 400);
        const one = await get(`/api/message?key=${encodeURIComponent(moved.key)}`);
        assert.equal(one.message.state, 'released');
        assert.equal((await fetch(`${base}/api/message?key=nope`)).status, 404);
        const health = await get('/api/health?days=30');
        assert.equal(health.buckets.length, 10); assert.equal(health.threshold, 0.85);
        assert.equal((await get('/api/settings')).demo, true);
        assert.equal((await fetch(`${base}/`)).status, 200);
        assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
        for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fsrc/server.js']) assert.equal((await fetch(base + p)).status, 404, p);
    } finally { await close(); }
});

test('aggregates: campaigns, users and model health from records', () => {
    const now = Date.now();
    const rec = (user, campaign, action, state, trigger, p) => ({ key: `${user}|${campaign}|${action}`, user, campaign, campaignLabel: campaign, subject: campaign, sender: { domain: 'x.example', address: 'a@x.example', name: '' }, processedAt: now - 1000, action, state, trigger, ai: { probability: p }, signals: [{ weight: 3, kind: 'hidden-filler', text: '' }], falseAlarm: state === 'released' ? true : null, releasedAt: now });
    const rs = [rec('a', 'c1', 'move', 'moved', 'rules+ai', 0.99), rec('b', 'c1', 'move', 'released', 'ai', 0.9), rec('c', 'c2', 'flag', 'inbox', null, 0.6)];
    const s = A.summary(rs, [{ day: A.dayOf(now), scanned: 100 }], now, 7);
    assert.deepEqual([s.moved, s.released, s.usersAffected, s.campaigns, s.flagged, s.scanned], [2, 1, 2, 1, 1, 100]);
    const c = A.campaigns(rs, now, 7);
    assert.deepEqual(c.map(x => [x.campaign, x.recipients, x.moved, x.released]), [['c1', 2, 2, 1], ['c2', 1, 0, 0]]);
    assert.equal(c[0].topReason, 'Hidden filler text');
    const h = A.modelHealth(rs, now, 7);
    assert.deepEqual(h.byTrigger.find(t => t.trigger === 'ai'), { trigger: 'ai', label: 'AI score', moved: 1, released: 1, rate: 1 });
    assert.equal(h.buckets[9].count, 2); assert.equal(h.buckets[6].count, 1);
    assert.deepEqual(A.users(rs, now, 7).map(u => u.user), ['a', 'b', 'c']);
    assert.equal(A.filterRecords(rs, { q: 'C2' }).length, 1);
});
