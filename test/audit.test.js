'use strict';
// 0.5.29: what was missed. Gmail refusing the service, emails left unchecked and many errors are alerts;
// downloading the email list or Activity, opening the dashboard and a project-ID lockout are recorded;
// Activity is kept AUDIT_DAYS (a year by default), searchable, and downloadable for an audit. Made-up people.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp } = require('../src/server');
const { buildDemo } = require('../src/demo/seed');

const ORG = 'maple-schools.example', ADMIN = `it.head@${ORG}`;
const cfgOf = (env = {}) => loadConfig(Object.assign({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `a@${ORG}` }, env));
const DAY = 24 * 3600 * 1000;

test('Gmail refusing the service is recognised (delegation removed, a token refused, 401/403), not a rate limit', () => {
    const yes = [new Error(`token for a@${ORG}: HTTP 401 {"error":"unauthorized_client"} (is domain-wide delegation set up for https://www.googleapis.com/auth/gmail.modify?)`),
        Object.assign(new Error('GET /history: HTTP 403 Delegation denied for a@maple-schools.example'), { status: 403 }), Object.assign(new Error('GET /messages/1: HTTP 401 invalid credentials'), { status: 401 })];
    const no = [Object.assign(new Error('GET /history: HTTP 403 rateLimitExceeded'), { status: 403 }), Object.assign(new Error('GET /messages/1: HTTP 500 backend'), { status: 500 }), new Error('Firestore deadline exceeded')];
    for (const e of yes) assert.equal(Service.isGmailAccessError(e), true, e.message);
    for (const e of no) assert.equal(!!Service.isGmailAccessError(e), false, e.message);
});

test('Gmail refusing the service is an alert, once a day, also when it fails before any email (the Pub/Sub path)', async () => {
    let now = Date.UTC(2026, 10, 12, 15);
    const store = new MemoryStore();
    const warned = [];
    const svc = new Service({ cfg: cfgOf(), store, gmail: {}, now: () => now, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    const e = new Error(`token for a@${ORG}: HTTP 401 unauthorized_client`);
    assert.equal(await svc.gmailTrouble(e, `a@${ORG}`), true);
    assert.equal(await svc.gmailTrouble(e, `b@${ORG}`), false, 'once a day');
    assert.equal(await svc.gmailTrouble(new Error('Firestore deadline exceeded'), `a@${ORG}`), false);
    assert.deepEqual(warned.map(w => w.spruceAlert), ['gmail-access']);
    assert.match(warned[0].message, /^Gmail refused the service for a@maple-schools\.example .*domain-wide delegation was removed or its scopes changed/);
    // Through the worker's Pub/Sub route: the notification is retried, and the admins are told.
    const cfg = loadConfig({ DEMO: '1', ORG_DOMAINS: ORG });
    const told = [];
    const fake = { handleNotification: async () => { throw e; }, gmailTrouble: async (err, user) => { told.push(user); return true; } };
    const srv = http.createServer(createApp({ cfg, store: new MemoryStore(), service: fake }));
    await new Promise(r => srv.listen(0, r));
    try {
        const data = Buffer.from(JSON.stringify({ emailAddress: `a@${ORG}`, historyId: '9' })).toString('base64');
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/pubsub/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { data } }) });
        assert.ok(res.status >= 500, 'retried later');
        assert.deepEqual(told, [`a@${ORG}`]);
    } finally { await new Promise(r => srv.close(r)); }
});

test('many errors in an hour are an alert (the hourly health check), once a day', async () => {
    let now = Date.UTC(2026, 10, 12, 15);
    const store = new MemoryStore();
    const warned = [];
    const svc = new Service({ cfg: cfgOf(), store, gmail: {}, now: () => now, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    await store.putUser(`a@${ORG}`, { watched: true, lastNotification: now - 60000, watchExpiration: now + 5 * DAY });
    for (let i = 0; i < 24; i++) await store.addEvent({ kind: 'error', at: now - 1000 * i, text: `failure ${i}` });
    assert.equal((await svc.health()).errorsLastHour, 24);
    assert.equal(warned.length, 0, 'under 25: not yet');
    await store.addEvent({ kind: 'error', at: now, text: 'failure 25' });
    await svc.health(); await svc.health();
    assert.deepEqual(warned.map(w => w.spruceAlert), ['errors']);
    assert.match(warned[0].message, /^25 errors in the last hour: something may have stopped working/);
});

test('Activity is kept AUDIT_DAYS (a year by default), the email records RETENTION_DAYS', async () => {
    assert.equal(cfgOf().auditDays, 365);
    assert.equal(cfgOf({ AUDIT_DAYS: '10' }).auditDays, 30, 'at least 30');
    assert.equal(cfgOf({ AUDIT_DAYS: '9999' }).auditDays, 1825, 'at most 5 years');
    const now = Date.UTC(2026, 10, 12, 15);
    const store = new MemoryStore();
    const svc = new Service({ cfg: cfgOf(), store, gmail: {}, now: () => now, log: { error() {} } });
    await store.saveRecord({ key: 'old', processedAt: now - 60 * DAY, action: 'move' });
    await store.addEvent({ kind: 'settings', admin: true, at: now - 60 * DAY, text: `${ADMIN} switched to enforce mode.` });
    await store.addEvent({ kind: 'settings', admin: true, at: now - 400 * DAY, text: `${ADMIN} changed the brake.` });
    await svc.purge();
    assert.equal(await store.getRecord('old'), null, 'the record: past 35 days');
    assert.deepEqual((await store.listEvents(0)).map(e => e.text), [`${ADMIN} switched to enforce mode.`], 'Activity: kept a year');
});

test('the dashboard: CSV downloads and opening it are recorded; Activity over a year, searched and downloaded; a lockout is an alert', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: ORG, GOOGLE_CLOUD_PROJECT: 'maple-mail-protection' });
    const { store } = await buildDemo({ cfg, now: Date.now() });
    const warned = [];
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    await store.addEvent({ kind: 'settings', admin: true, at: Date.now() - 200 * DAY, text: `${ADMIN} switched to enforce mode on the dashboard.` });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mine = async () => (await store.listEvents(0, { limit: 10000 })).filter(e => e.admin);
    try {
        // Opened: once a day.
        await fetch(`${base}/api/overview?days=7`); await fetch(`${base}/api/settings`);
        assert.equal((await mine()).filter(e => e.kind === 'signin').length, 1);
        assert.match((await mine()).find(e => e.kind === 'signin').text, /^demo-admin@example\.org opened the dashboard\.$/);
        // The email list as CSV: recorded.
        const csv = await fetch(`${base}/api/export.csv?days=30`);
        assert.equal(csv.status, 200);
        assert.ok((await mine()).some(e => e.kind === 'export' && /^demo-admin@example\.org downloaded \d+ email records? as CSV \(Email → Messages, last 30 days\)\.$/.test(e.text)));
        // Activity: 200 days ago is there for a year's view, not for 30 days; searched; downloaded (recorded).
        const a30 = await (await fetch(`${base}/api/activity?days=30&kind=admin`)).json();
        assert.equal(a30.maxDays, 365);
        assert.ok(!a30.events.some(e => /switched to enforce mode/.test(e.text)));
        const a365 = await (await fetch(`${base}/api/activity?days=365&kind=admin&q=${encodeURIComponent('switched to enforce')}`)).json();
        assert.deepEqual(a365.events.map(e => e.text), [`${ADMIN} switched to enforce mode on the dashboard.`]);
        assert.equal((await (await fetch(`${base}/api/activity?days=9999`)).json()).days, 365, 'no further back than kept');
        const dl = await fetch(`${base}/api/activity.csv?days=365&q=${encodeURIComponent('switched to enforce')}`);
        const text = await dl.text();
        assert.match(dl.headers.get('content-disposition'), /spruce-activity-\d{4}-\d{2}-\d{2}\.csv/);
        assert.match(text, /^at_utc,kind,alert,admin_action,mailbox,text\r\n\d{4}-\d{2}-\d{2}T[\d:.]+Z,settings,,yes,,it\.head@maple-schools\.example switched to enforce mode on the dashboard\.\r\n$/);
        assert.ok((await mine()).some(e => e.kind === 'export' && /downloaded 1 Activity entry as CSV \(last 365 days, filtered\)/.test(e.text)));
        // Five wrong project IDs: locked, and an alert.
        const post = (b) => fetch(`${base}/api/policy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: JSON.stringify(b) });
        for (let i = 0; i < 5; i++) assert.equal((await post({ key: i < 3 ? 'mode' : 'allowDomains', value: 'monitor', projectId: `wrong-project-${i}` })).status, 403);
        for (let i = 0; i < 3; i++) assert.equal((await post({ key: 'mode', value: 'monitor', projectId: 'maple-mail-protection' })).status, 429, 'locked');
        assert.deepEqual(warned.map(w => w.spruceAlert), ['lockout']);
        assert.match(warned[0].message, /^demo-admin@example\.org typed a wrong Google Cloud project ID or email address 5 times within 10 minutes/);
        // 0.5.30: every wrong try in What admins did (not emailed), what it was for, never what was typed; tries
        // while locked noted once.
        const denied = (await mine()).filter(e => e.kind === 'denied').sort((a, b) => a.at - b.at).map(e => e.text);
        assert.deepEqual(denied.slice(0, 5).map(t => (/\(try (\d) of 5 within 10 minutes\)/.exec(t) || [])[1]), ['1', '2', '3', '4', '5']);
        assert.match(denied[0], /^demo-admin@example\.org typed a wrong Google Cloud project ID to change the mode \(try 1 of 5 within 10 minutes\): nothing was changed\.$/);
        assert.match(denied[4], /to change the allowlisted domains \(try 5 of 5 within 10 minutes\): nothing was changed\. Changes from this account are locked for 10 minutes\.$/);
        assert.equal(denied.length, 6, 'five tries, and one note for the three tries while locked');
        assert.match(denied[5], /^demo-admin@example\.org tried to change the mode while locked after 5 wrong entries: refused/);
        assert.ok(!JSON.stringify(await store.listEvents(0, { limit: 10000 })).includes('wrong-project'), 'what was typed is never kept');
        assert.equal((await (await fetch(`${base}/api/activity?days=7&kind=alert`)).json()).events.filter(e => e.kind === 'denied').length, 0, 'a wrong try isn\'t an alert');
    } finally { await new Promise(r => srv.close(r)); }
});

test('AUDIT_LOG: each Activity entry is also written as a log line (for the spruce-audit log bucket)', async () => {
    const store = new MemoryStore();
    const lines = [];
    store.onEvent = (e) => lines.push(e);
    await store.addEvent({ kind: 'settings', admin: true, text: `${ADMIN} changed the brake.` });
    assert.equal(lines.length, 1);
    assert.equal(cfgOf().auditLog, false, 'off by default');
    assert.equal(cfgOf({ AUDIT_LOG: 'true' }).auditLog, true);
});

test('0.5.30: a wrong project ID or email address on Settings → Update is noted too, never what was typed', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: ORG });
    const store = new MemoryStore();
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn() {} } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const post = (b) => fetch(`http://127.0.0.1:${srv.address().port}/api/update`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: JSON.stringify(b) });
    try {
        assert.equal((await post({ agree: true, projectId: 'demo-project', email: 'someone.else@maple-schools.example', version: '9.9.9' })).status, 403);
        assert.equal((await post({ agree: true, projectId: 'not-this-one', email: 'demo-admin@example.org', version: '9.9.9' })).status, 403);
        const texts = (await store.listEvents(0)).filter(e => e.kind === 'denied').map(e => e.text).sort();
        assert.deepEqual(texts, [
            'demo-admin@example.org typed a wrong Google Cloud project ID to change the version installed (an update to 9.9.9) (try 2 of 5 within 10 minutes): nothing was changed.',
            'demo-admin@example.org typed a wrong email address (not the one they are signed in with) to change the version installed (an update to 9.9.9) (try 1 of 5 within 10 minutes): nothing was changed.']);
        assert.ok(!JSON.stringify(await store.listEvents(0)).match(/someone\.else|not-this-one/));
    } finally { await new Promise(r => srv.close(r)); }
});
