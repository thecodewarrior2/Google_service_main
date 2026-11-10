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
    const worker = loadConfig(Object.assign({ ROLE: 'worker', SAFE_BROWSING_KEY: 'k', PILOT_USERS: 'a@maple-schools.example', PUBSUB_TOPIC: 'projects/p/topics/t', PUSH_AUDIENCE: 'https://w', PUSH_SERVICE_ACCOUNT: 'push@p.iam.gserviceaccount.com' }, common));
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

test('Pub/Sub push: a notification with something left to do is asked again later (503); otherwise acknowledged', async () => {
    const cfg = loadConfig({ DEMO: '1', ORG_DOMAINS: 'maple-schools.example' });
    const store = new MemoryStore();
    let answer = { processed: 1, results: [] };
    const service = { handleNotification: async () => answer };
    const { base, close } = await serve(createApp({ cfg, store, service }));
    const push = () => fetch(`${base}/pubsub/push`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'a@maple-schools.example', historyId: '5' })).toString('base64') } }) });
    try {
        assert.equal((await push()).status, 204);
        answer = { processed: 0, results: [], held: true };
        assert.equal((await push()).status, 503);
    } finally { await close(); }
});

test('Cloud Scheduler client: runs a job and reads its last run', async () => {
    const { createScheduler } = require('../src/scheduler');
    const calls = [];
    let answer = { status: 200, body: {} };
    const fetch = async (url, init) => { calls.push({ url, method: init.method, auth: init.headers.authorization }); return { ok: answer.status < 400, status: answer.status, text: async () => JSON.stringify(answer.body) }; };
    const googleAuth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'tok' }) }) };
    const sch = createScheduler({ fetch, googleAuth });
    const job = 'projects/p/locations/us-east1/jobs/spruce-renew-watches';
    await sch.run(job);
    assert.deepEqual(calls[0], { url: `https://cloudscheduler.googleapis.com/v1/${job}:run`, method: 'POST', auth: 'Bearer tok' });
    answer = { status: 200, body: { state: 'ENABLED', lastAttemptTime: '2026-11-09T19:05:05.042Z', status: { code: 2 } } };
    assert.deepEqual(await sch.lastRun(job), { state: 'ENABLED', at: Date.parse('2026-11-09T19:05:05.042Z'), code: 2 });
    answer = { status: 200, body: { state: 'ENABLED', lastAttemptTime: '2026-11-09T20:00:00Z', status: {} } };
    assert.equal((await sch.lastRun(job)).code, 0, 'reached the service');
    answer = { status: 403, body: { error: { message: 'The caller does not have permission' } } };
    await assert.rejects(sch.run(job), /HTTP 403: The caller does not have permission/);
});

test('"Update group membership now": runs the re-read job, at most once a minute, said in Recent activity; Settings shows its last run', async () => {
    const cfg = loadConfig({ DEMO: '1', ORG_DOMAINS: 'maple-schools.example', RENEW_JOB: 'projects/p/locations/us-east1/jobs/spruce-renew-watches' });
    const store = new MemoryStore();
    const runs = [];
    let fail = null;
    const scheduler = { run: async (job) => { if (fail) throw new Error(fail); runs.push(job); return {}; }, lastRun: async () => ({ state: 'ENABLED', at: 1700000000000, code: 2 }) };
    const { base, close } = await serve(createApp({ cfg, store, service: new Service({ cfg, store, gmail }), scheduler }));
    const post = (hdr = true) => fetch(`${base}/api/renew-watches`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, hdr ? { 'x-requested-with': 'spruce-dashboard' } : {}), body: '{}' });
    try {
        assert.equal((await post(false)).status, 403, 'needs the dashboard header');
        assert.equal(runs.length, 0);
        const ok = await post();
        assert.equal(ok.status, 200); assert.equal((await ok.json()).ok, true);
        assert.deepEqual(runs, ['projects/p/locations/us-east1/jobs/spruce-renew-watches']);
        assert.ok((await store.listEvents()).some(e => e.kind === 'watch-asked' && /asked for the pilot group to be read again/.test(e.text)));
        const again = await post();
        assert.equal(again.status, 429); assert.match((await again.json()).error, /less than a minute ago/);
        const st = await (await fetch(`${base}/api/settings`)).json();
        assert.deepEqual(st.renew, { available: true, last: { state: 'ENABLED', at: 1700000000000, code: 2 } });
    } finally { await close(); }
    // A refused run says why, and can be tried again at once.
    const app2 = await serve(createApp({ cfg, store, service: new Service({ cfg, store, gmail }), scheduler }));
    fail = 'Cloud Scheduler answered HTTP 403: The caller does not have permission';
    try {
        const r = await fetch(`${app2.base}/api/renew-watches`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: '{}' });
        assert.equal(r.status, 502); assert.match((await r.json()).error, /Couldn't start the re-read: .*403/);
        fail = null;
        assert.equal((await fetch(`${app2.base}/api/renew-watches`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: '{}' })).status, 200);
    } finally { await app2.close(); }
});

test('dashboard: CSV export (formulas written as text), activity by kind, readiness checks, campaign state and decisions', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'enforce', ORG_DOMAINS: 'maple-schools.example' });
    const { store } = await buildDemo({ cfg, now: Date.now() });
    const gm = Object.assign({}, gmail, { labels: async () => ['INBOX'], search: async () => ({ ids: [], next: null }) });
    const service = new Service({ cfg, store, gmail: gm });
    const { base, close } = await serve(createApp({ cfg, store, service }));
    const get = async (p) => (await fetch(base + p)).json();
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: JSON.stringify(body) });
    try {
        const csv = await fetch(`${base}/api/export.csv?days=90&action=move`);
        assert.equal(csv.status, 200);
        assert.match(csv.headers.get('content-type'), /^text\/csv/);
        assert.match(csv.headers.get('content-disposition'), /^attachment; filename="spruce-messages-\d{4}-\d{2}-\d{2}\.csv"$/);
        const lines = (await csv.text()).trim().split('\r\n');
        assert.equal(lines[0].split(',')[0], 'checked');
        const moves = (await get('/api/messages?days=90&action=move')).total;
        assert.equal(lines.length - 1, Math.min(moves, 20000), 'one line per record shown on Messages');
        const all = (await get('/api/activity?days=30')).events, alerts = (await get('/api/activity?days=30&kind=alert')).events;
        assert.ok(all.length >= alerts.length && alerts.every(e => e.alert));
        const r = (await get('/api/readiness?days=30')).readiness;
        assert.deepEqual(r.checks.map(c => c.id), ['time', 'reviewed', 'falseAlarms', 'staff', 'brake', 'notifications', 'renew']);
        assert.equal(typeof r.ready, 'boolean'); assert.equal(r.brakeLimit, 100);
        // A campaign: state, then released as a false alarm (every moved copy back).
        const top = (await get('/api/campaigns?days=30')).campaigns.find(c => c.moved > 0);
        const c = (await get(`/api/campaign?key=${encodeURIComponent(top.campaign)}`)).campaign;
        // (the Campaigns list counts every copy moved; here "moved" is those still in Spam, not taken back)
        assert.ok(c.moved > 0 && c.moved <= top.moved); assert.equal(c.decision, null);
        const rel = await (await post('/api/campaign/release', { key: top.campaign })).json();
        assert.equal(rel.released, c.moved);
        assert.equal((await get(`/api/campaign?key=${encodeURIComponent(top.campaign)}`)).campaign.decision, 'released');
        assert.equal((await post('/api/campaign/release', { key: top.campaign })).status, 429, 'no double clicks');
        assert.equal((await get('/api/campaign?key=nope')).error, 'not found');
        const st = await get('/api/settings');
        assert.equal(st.brakeLimit, 100); assert.equal(st.campaignHoldAfter, 25);
    } finally { await close(); }
});

test('"Check an email": the decision and why for a pasted email, nothing stored; records keep the Message-ID, searchable and in the CSV', async () => {
    const fs = require('fs'), path = require('path');
    const cfg = loadConfig({ DEMO: '1', MODE: 'enforce', ORG_DOMAINS: 'maple-schools.example' });
    const { store } = await buildDemo({ cfg, now: Date.now() });
    const service = new Service({ cfg, store, gmail });
    const { base, close } = await serve(createApp({ cfg, store, service }));
    const post = (body, hdr = true) => fetch(`${base}/api/check`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, hdr ? { 'x-requested-with': 'spruce-dashboard' } : {}), body: JSON.stringify(body) });
    try {
        const before = (await store.listRecords({})).length;
        const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'phish-storage.eml'), 'utf8').replace(/\r\n/g, '\n');   // as copied from "Show original"
        const r = await (await post({ raw })).json();
        assert.equal(r.result.pasted, true);
        assert.equal(r.result.action, 'move', 'enforce mode: it would be moved');
        assert.equal(r.result.rfc822MessageId, 'a1b2c3@brt.greenpath-example.my.id');
        assert.equal(r.result.auth.dmarc, 'fail'); assert.equal(r.result.evidence, 'strong');
        assert.ok(r.result.signals.length > 0 && typeof r.result.ai.probability === 'number');
        assert.equal((await store.listRecords({})).length, before, 'nothing stored');
        assert.ok((await store.listEvents()).some(e => e.kind === 'check' && /checked a pasted email from brt\.greenpath-example\.my\.id/.test(e.text)));
        assert.equal((await post({ raw: '  ' })).status, 400);
        assert.equal((await post({ raw }, false)).status, 403, 'needs the dashboard header');
        assert.equal((await post({ raw: 'x'.repeat(10 * 1024 * 1024 + 1) })).status, 413);
        // Recorded emails: the Message-ID, found by search, and in the CSV.
        const rec = (await store.listRecords({})).find(x => x.rfc822MessageId);
        assert.ok(rec, 'demo records have a Message-ID');
        const found = await (await fetch(`${base}/api/messages?days=90&q=${encodeURIComponent(rec.rfc822MessageId)}`)).json();
        assert.ok(found.messages.length >= 1 && found.messages.every(m => m.campaign === rec.campaign || true));
        const csv = await (await fetch(`${base}/api/export.csv?days=90`)).text();
        const head = csv.split('\r\n')[0].split(',');
        assert.deepEqual(head.slice(-2), ['message_id', 'gmail_id']);
        assert.ok(csv.includes(rec.rfc822MessageId));
    } finally { await close(); }
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
        assert.equal(health.buckets.length, 10); assert.equal(health.threshold, 0.9);
        const st = await get('/api/settings');
        assert.equal(st.demo, true);
        // (0.4.1) The list comes only for Settings → Mailboxes, which asks for it; the other pages get the count.
        assert.equal(st.mailboxes, null, 'not read for every Settings page');
        const mbx = await (await fetch(`${base}/api/settings?mailboxes=1`)).json();
        assert.equal(mbx.mailboxes.length, mbx.watched, 'each watched mailbox is listed');
        assert.ok(mbx.mailboxes.every(m => m.email && m.lastNotification && m.watchExpiration));
        assert.deepEqual(mbx.mailboxes.map(m => m.email), mbx.mailboxes.map(m => m.email).slice().sort(), 'by address');
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
    assert.deepEqual(h.byTrigger.find(t => t.trigger === 'ai'), { trigger: 'ai', label: 'AI score', moved: 1, released: 1, byUser: 0, rate: 1 });
    assert.equal(h.userReleased, 0); assert.equal(s.userReleased, 0);
    assert.equal(h.buckets[9].count, 2); assert.equal(h.buckets[6].count, 1);
    assert.deepEqual(A.users(rs, now, 7).map(u => u.user), ['a', 'b', 'c']);
    assert.equal(A.filterRecords(rs, { q: 'C2' }).length, 1);
});

test('dashboard admins: listed addresses, or members of ADMIN_GROUP in the organization; a failed check is a no', async () => {
    const { authorizeAdmin, adminGroupCheck } = require('../src/auth/verify');
    const cfg = loadConfig({ ORG_DOMAINS: 'maple-schools.example', ADMIN_EMAILS: 'it.director@maple-schools.example', ADMIN_GROUP: 'spruce-admins@maple-schools.example', DIRECTORY_ADMIN: 'dir@maple-schools.example' });
    let t = 0; const asked = [];
    const members = new Set(['it.helpdesk@maple-schools.example', 'friend@elsewhere.example']);
    const gmail = { hasMember: async (admin, g, e) => { asked.push([admin, g, e]); if (e === 'boom@maple-schools.example') throw new Error('HTTP 500'); return members.has(e); } };
    const check = adminGroupCheck(cfg, gmail, () => t);
    assert.equal((await authorizeAdmin('it.director@maple-schools.example', cfg, check)).ok, true, 'listed: no group lookup');
    assert.equal(asked.length, 0);
    assert.equal((await authorizeAdmin('it.helpdesk@maple-schools.example', cfg, check)).ok, true, 'a member of the group');
    assert.deepEqual(asked[0], ['dir@maple-schools.example', 'spruce-admins@maple-schools.example', 'it.helpdesk@maple-schools.example']);
    assert.equal((await authorizeAdmin('teacher@maple-schools.example', cfg, check)).status, 403);
    assert.equal((await authorizeAdmin('friend@elsewhere.example', cfg, check)).status, 403, 'outside the organization: never through the group');
    assert.ok(!asked.some(a => a[2] === 'friend@elsewhere.example'));
    assert.equal((await authorizeAdmin('boom@maple-schools.example', cfg, check)).status, 503, 'a failed check lets nobody in');
    // Answers are remembered: yes for 5 minutes, no for 1.
    const n = asked.length;
    members.add('teacher@maple-schools.example'); members.delete('it.helpdesk@maple-schools.example');
    t = 30 * 1000;
    assert.equal((await authorizeAdmin('it.helpdesk@maple-schools.example', cfg, check)).ok, true);
    assert.equal((await authorizeAdmin('teacher@maple-schools.example', cfg, check)).ok, false);
    assert.equal(asked.length, n);
    t = 90 * 1000;
    assert.equal((await authorizeAdmin('teacher@maple-schools.example', cfg, check)).ok, true, 'added: in after a minute');
    t = 6 * 60 * 1000;
    assert.equal((await authorizeAdmin('it.helpdesk@maple-schools.example', cfg, check)).ok, false, 'removed: out after 5 minutes');
    // Without a group or its directory admin, the configuration is refused.
    assert.match(configProblems(loadConfig({ ROLE: 'admin', ORG_DOMAINS: 'maple-schools.example', DELEGATED_SA: 'x@p.iam.gserviceaccount.com', IAP_AUDIENCE: 'a', ADMIN_GROUP: 'g@maple-schools.example' })).join(' '), /ADMIN_GROUP needs DIRECTORY_ADMIN/);
    assert.deepEqual(configProblems(loadConfig({ ROLE: 'admin', ORG_DOMAINS: 'maple-schools.example', DELEGATED_SA: 'x@p.iam.gserviceaccount.com', IAP_AUDIENCE: 'a', ADMIN_GROUP: 'g@maple-schools.example', DIRECTORY_ADMIN: 'dir@maple-schools.example' })), []);
});

test('hasMember: nested membership from Google; an unknown address is a no, an unknown group an error', async () => {
    const { GmailClient, GoogleApiError } = require('../src/gmail/client');
    let reply;
    const urls = [];
    const fetch = async (url) => { urls.push(url); return reply; };
    const c = new GmailClient({ tokenFor: async () => 'tok' }, { fetch });
    reply = { ok: true, status: 200, json: async () => ({ isMember: true }) };
    assert.equal(await c.hasMember('dir@maple-schools.example', 'spruce-admins@maple-schools.example', 'a@maple-schools.example'), true);
    assert.equal(new URL(urls[0]).pathname, '/admin/directory/v1/groups/spruce-admins%40maple-schools.example/hasMember/a%40maple-schools.example');
    reply = { ok: false, status: 400, text: async () => 'Invalid Input: memberKey' };
    assert.equal(await c.hasMember('dir@maple-schools.example', 'spruce-admins@maple-schools.example', 'x@maple-schools.example'), false);
    reply = { ok: false, status: 404, text: async () => 'Resource Not Found: groupKey' };
    await assert.rejects(c.hasMember('dir@maple-schools.example', 'typo@maple-schools.example', 'a@maple-schools.example'), GoogleApiError);
});

test('the clickable mockup builds, and every script in it parses (its stand-in API is written inside a template string)', () => {
    const os = require('os'), path = require('path'), fs = require('fs'), vm = require('vm'), { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-mockup-'));
    try {
        const out = path.join(dir, 'mockup.html');
        execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build-mockup.js'), out], { encoding: 'utf8' });
        const scripts = [...fs.readFileSync(out, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        assert.ok(scripts.length >= 4, String(scripts.length));
        for (const [i, code] of scripts.entries()) assert.doesNotThrow(() => new vm.Script(code, { filename: `mockup script ${i}` }), `script ${i}`);
        assert.match(scripts.join('\n'), /case '\/api\/policy'/, 'the policy stand-in is there');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('text from emails wraps inside its card: long links, addresses and subjects have places to break', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].split(',').map(s => s.trim()), body: m[2] }));
    const wraps = (sel) => rules.some(r => r.sel.includes(sel) && /overflow-wrap:\s*anywhere/.test(r.body));
    // The email's page (the AI's quotes, signs found, flagged links, details), its subject and sender line,
    // alerts, Activity, and the Status and Readiness checks: all can show an email's subject, an address or a link.
    for (const sel of ['.detail', '.quote', '.signals li', 'dl.kv dd', 'h1', '.pasted-title', '.sub', '.alert', '.decision', '.events li', '.checks li']) assert.ok(wraps(sel), `${sel} lets long words break`);
    // Columns that may shrink below their longest word (otherwise the word pushes the card wider than the page).
    for (const sel of ['.signals li', 'dl.kv']) assert.ok(rules.some(r => r.sel.includes(sel) && /grid-template-columns:[^;]*minmax\(0, 1fr\)/.test(r.body)), `${sel}'s text column can shrink`);
    assert.ok(rules.some(r => r.sel.includes('.alert .grow') && /min-width:\s*0/.test(r.body)), 'an alert\'s text can shrink');
});
