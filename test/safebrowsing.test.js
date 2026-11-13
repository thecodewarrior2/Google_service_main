'use strict';
// 0.5.23: Google Safe Browsing from the dashboard. An admin pastes the API key on Settings → Safe Browsing: it
// is tried with Google first, kept in Secret Manager only (never in Firestore, the logs or an answer), every
// instance notices it within 30 seconds; Safe Browsing is turned on and off like a policy setting; Remove the
// key destroys it. The keys here are made up, and nothing reaches Google.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSafeBrowsingKey, memorySecrets, keyProblem, TEST_URL } = require('../src/intel/sbkey');
const { createSecrets } = require('../src/secrets');
const { createThreats } = require('../src/intel/threats');
const { createHttp } = require('../src/intel/http');
const { MemoryStore } = require('../src/store/memory');
const { Service, policyValue } = require('../src/pipeline');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');
const { buildDemo } = require('../src/demo/seed');
const spruce = require('../src/engine/spruce');

const E = spruce.load();
const GOOD = 'made-up-test-key-0123456789abcdefghij', OTHER = 'made-up-test-key-9876543210zyxwvutsrq';
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
// Google, as far as these tests need it: GOOD and OTHER work; "disabled-…" is a key whose project hasn't
// enabled the API; anything else isn't a key.
function fakeGoogle() {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const key = (init.headers || {})['x-goog-api-key'];
        calls.push({ url: String(url), key, body: init.body ? JSON.parse(init.body) : null });
        if (key === GOOD || key === OTHER) {
            const entries = JSON.parse(init.body).threatInfo.threatEntries;
            return json({ matches: entries.filter(e => /phish-page|malware\.testing/.test(e.url)).map(e => ({ threatType: 'SOCIAL_ENGINEERING', threat: { url: e.url } })) });
        }
        if (/^disabled-/.test(key)) return json({ error: { code: 403, message: 'Safe Browsing API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }, 403);
        return json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
    };
    return { fetch, calls };
}
const everything = (store) => JSON.stringify([...store.state.entries(), store.events]);

test('the key: tried with Google first; only a working one is saved, in Secret Manager; Firestore keeps who and when, never the key', async () => {
    const g = fakeGoogle();
    const store = new MemoryStore(), secrets = memorySecrets();
    let now = 1_800_000_000_000;
    const k = createSafeBrowsingKey({ cfg: {}, store, secrets, http: createHttp({ fetch: g.fetch }), now: () => now, log: { error() {} } });
    assert.equal(await k.get(), null);
    // Not a key, a wrong one, one whose project hasn't enabled the API: refused, saying what to do; nothing saved.
    await assert.rejects(k.save('not a key', 'admin@maple-schools.example'), (e) => e.status === 400 && /doesn't look like a Google API key/.test(e.message));
    assert.equal(g.calls.length, 0, 'a malformed key isn\'t even sent');
    await assert.rejects(k.save('made-up-wrong-key-000000000000000000000', 'admin@maple-schools.example'), (e) => /isn't a valid API key/.test(e.message));
    await assert.rejects(k.save('disabled-made-up-key-0000000000000000000', 'admin@maple-schools.example'), (e) => /Safe Browsing API isn't enabled/.test(e.message) && /APIs & Services → Library/.test(e.message));
    assert.equal(await secrets.latest(), null);
    // The test lookup is Google's own test address, nothing else.
    assert.deepEqual(g.calls.map(c => c.body.threatInfo.threatEntries.map(x => x.url)), [[TEST_URL], [TEST_URL]]);
    assert.ok(g.calls.every(c => !c.url.includes('key=')), 'the key in a header, never the address');
    const out = await k.save(`  ${GOOD} `, 'admin@maple-schools.example');
    assert.deepEqual(out, { version: '1', tested: true });
    assert.equal((await secrets.latest()).value, GOOD, 'trimmed, in Secret Manager');
    assert.equal(await k.get(), GOOD);
    const st = await k.status();
    assert.deepEqual([st.available, st.saved, st.envKey, st.health.ok], [true, { by: 'admin@maple-schools.example', at: now }, false, true]);
    assert.ok(!everything(store).includes(GOOD) && !JSON.stringify(st).includes(GOOD), 'never in Firestore or the status');
    // Removed: every version destroyed.
    await k.remove('admin@maple-schools.example');
    assert.equal(await secrets.latest(), null);
    assert.equal(await k.get(), null);
    assert.deepEqual((await k.status()).removed, { by: 'admin@maple-schools.example', at: now });
});

test('every instance notices a new or removed key within 30 seconds; the environment\'s key is used when none is saved', async () => {
    const store = new MemoryStore(), secrets = memorySecrets();
    let now = 1_800_000_000_000;
    const g = fakeGoogle();
    const opts = { store, secrets, http: createHttp({ fetch: g.fetch }), now: () => now, log: { error() {} } };
    const admin = createSafeBrowsingKey(Object.assign({ cfg: {} }, opts));
    const worker = createSafeBrowsingKey(Object.assign({ cfg: { safeBrowsingKey: 'env-made-up-key-000000000000000000000' } }, opts));
    assert.equal(await worker.get(), 'env-made-up-key-000000000000000000000', 'none saved: the environment\'s');
    await admin.save(GOOD, 'a@maple-schools.example');
    assert.equal(await worker.get(), 'env-made-up-key-000000000000000000000', 'within the 30 seconds');
    now += 31 * 1000;
    assert.equal(await worker.get(), GOOD);
    await admin.save(OTHER, 'a@maple-schools.example');
    now += 31 * 1000;
    assert.equal(await worker.get(), OTHER, 'a replaced key');
    await admin.remove('a@maple-schools.example');
    now += 31 * 1000;
    assert.equal(await worker.get(), 'env-made-up-key-000000000000000000000');
    // Without Secret Manager (an install before 0.5.23): the environment's key only; nothing can be saved.
    const old = createSafeBrowsingKey({ cfg: { safeBrowsingKey: 'env-made-up-key-000000000000000000000' }, store, http: createHttp({ fetch: g.fetch }) });
    assert.equal(await old.get(), 'env-made-up-key-000000000000000000000');
    await assert.rejects(old.save(GOOD, 'a@maple-schools.example'), (e) => e.status === 409 && /bash deploy\/update\.sh .*bash deploy\/upgrade\.sh/.test(e.message));
});

test('what Google\'s refusals mean', () => {
    assert.match(keyProblem(403, { message: 'Requests to this API safebrowsing.googleapis.com method are blocked.', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] }).fix, /API restrictions add "Safe Browsing API"/);
    assert.match(keyProblem(403, { message: 'Requests from this IP address are blocked.', details: [{ reason: 'API_KEY_IP_ADDRESS_BLOCKED' }] }).fix, /Application restrictions to None/);
    assert.match(keyProblem(429, { message: 'Quota exceeded' }).why, /quota/);
    assert.match(keyProblem(500, { message: 'Internal error' }).why, /HTTP 500: Internal error/);
});

test('lookups: only when on and a key can be used, the key read at each lookup; Google refusing it is noted, a network blip isn\'t', async () => {
    const g = fakeGoogle();
    const store = new MemoryStore(), secrets = memorySecrets();
    let now = 1_800_000_000_000;
    const cfg = { cloudflareThreats: false, safeBrowsing: false };
    const sbKey = createSafeBrowsingKey({ cfg, store, secrets, http: createHttp({ fetch: g.fetch }), now: () => now, log: { error() {} } });
    const t = createThreats({ http: createHttp({ fetch: g.fetch }), cfg, engine: E, sbKey });
    const links = [{ url: 'https://phish-page.example/login', text: 'Sign in' }, { url: 'https://fine.example/news', text: 'News' }];
    assert.equal(t.enabled.safeBrowsing, false);
    assert.equal((await t.checkUrls(links)).get(links[0].url).reason, 'Safe Browsing is off');
    cfg.safeBrowsing = true;                                // (turned on: the policy setting, read at each lookup)
    assert.equal(t.enabled.safeBrowsing, true);
    assert.match((await t.checkUrls(links)).get(links[0].url).reason, /no API key is saved/);
    assert.equal(g.calls.length, 0);
    await sbKey.save(GOOD, 'a@maple-schools.example');
    g.calls.length = 0;
    const r = await t.checkUrls(links);
    assert.deepEqual([r.get(links[0].url).verdict, r.get(links[1].url).verdict], ['unsafe', 'clean']);
    assert.deepEqual(g.calls.map(c => [c.key, c.url]), [[GOOD, 'https://safebrowsing.googleapis.com/v4/threatMatches:find']]);
    // The key revoked at Google: "not checked" (never safe), and noted for Settings and Status.
    await secrets.replace('made-up-revoked-key-00000000000000000000');
    await store.setState('safeBrowsingKey', { set: true, version: '9', by: 'a@maple-schools.example', at: now });
    now += 31 * 1000;
    const r2 = await t.checkUrls([{ url: 'https://another.example/x', text: 'x' }]);
    assert.equal(r2.get('https://another.example/x').verdict, 'unknown');
    const h = await store.getState('safeBrowsingHealth');
    assert.equal(h.ok, false);
    assert.match(h.error, /HTTP 400: API key not valid/);
    // The network down: not checked, and nothing noted against the key.
    const down = createThreats({ http: createHttp({ fetch: async () => { throw new Error('network down'); } }), cfg, engine: E, sbKey });
    await store.setState('safeBrowsingHealth', { ok: true, at: now });
    await sbKey.noteResult(true, null, { force: true });
    assert.equal((await down.checkUrls([{ url: 'https://third.example/y', text: 'y' }])).get('https://third.example/y').verdict, 'unknown');
    assert.equal((await store.getState('safeBrowsingHealth')).ok, true);
});

test('Secret Manager: the latest version read, a new one added and the older ones destroyed, all destroyed on removal', async () => {
    const calls = [];
    let versions = [{ name: 'projects/p/secrets/s/versions/1', state: 'ENABLED', value: 'old-made-up-key' }];
    const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    const fetch = async (url, init = {}) => {
        const path = url.replace('https://secretmanager.googleapis.com/v1/', '');
        calls.push(`${init.method} ${path.split('?')[0]}`);
        assert.equal(init.headers.authorization, 'Bearer made-up-token');
        if (path === 'projects/p/secrets/s/versions/latest:access') {
            const v = versions.filter(x => x.state === 'ENABLED').pop();
            return v ? res({ name: v.name, payload: { data: Buffer.from(v.value).toString('base64') } }) : res({ error: { message: 'not found', status: 'NOT_FOUND' } }, 404);
        }
        if (path === 'projects/p/secrets/s:addVersion') {
            const v = { name: `projects/p/secrets/s/versions/${versions.length + 1}`, state: 'ENABLED', value: Buffer.from(JSON.parse(init.body).payload.data, 'base64').toString() };
            versions.push(v); return res({ name: v.name, state: 'ENABLED' });
        }
        if (path.startsWith('projects/p/secrets/s/versions?')) return res({ versions: versions.filter(x => x.state !== 'DESTROYED').map(x => ({ name: x.name, state: x.state })) });
        const m = /^(projects\/p\/secrets\/s\/versions\/\d+):destroy$/.exec(path);
        if (m) { const v = versions.find(x => x.name === m[1]); v.state = 'DESTROYED'; v.value = ''; return res({ name: v.name, state: 'DESTROYED' }); }
        return res({ error: { message: 'unexpected' } }, 500);
    };
    const s = createSecrets({ name: 'projects/p/secrets/s', fetch, googleAuth: { getClient: async () => ({ getAccessToken: async () => ({ token: 'made-up-token' }) }) } });
    assert.deepEqual(await s.latest(), { value: 'old-made-up-key', version: '1' });
    assert.equal(await s.replace(GOOD), '2');
    assert.deepEqual(versions.map(v => v.state), ['DESTROYED', 'ENABLED'], 'the old key destroyed');
    assert.deepEqual(await s.latest(), { value: GOOD, version: '2' });
    assert.equal(await s.destroyAll(), 1);
    assert.equal(await s.latest(), null);
    assert.ok(calls.includes('POST projects/p/secrets/s:addVersion') && calls.includes('POST projects/p/secrets/s/versions/2:destroy'));
});

test('the policy setting: on or off, like the others', () => {
    assert.equal(policyValue('safeBrowsing', 'on'), true);
    assert.equal(policyValue('safeBrowsing', false), false);
    assert.throws(() => policyValue('safeBrowsing', 'maybe'), /Google Safe Browsing is on or off/);
});

test('dashboard: save a key (project ID; tested; turned on), it never comes back; on needs a key; Remove destroys it and turns it off', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: 'maple-schools.example' });
    const { store, intel } = await buildDemo({ cfg, now: Date.now() });
    const service = new Service({ cfg, store, gmail: {}, intel, log: { error() {}, warn() {} } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
    try {
        let st = await get('/api/settings');
        const project = st.demoProjectId;
        assert.deepEqual([st.safeBrowsing.available, st.safeBrowsing.on, st.safeBrowsing.saved, st.checks.safeBrowsing], [true, false, null, false]);
        // On without a key: refused.
        let r = await post('/api/policy', { key: 'safeBrowsing', value: true, projectId: project });
        assert.equal(r.status, 400); assert.match(r.text, /Save an API key first/);
        // The project ID is needed; a malformed key is refused.
        r = await post('/api/safe-browsing/key', { apiKey: GOOD, projectId: 'someone-elses-project', turnOn: true });
        assert.equal(r.status, 403);
        r = await post('/api/safe-browsing/key', { apiKey: 'short', projectId: project, turnOn: true });
        assert.equal(r.status, 400); assert.match(r.text, /doesn't look like a Google API key/);
        await new Promise(res => setTimeout(res, 5100));   // (one save every 5 seconds per admin)
        r = await post('/api/safe-browsing/key', { apiKey: GOOD, projectId: project, turnOn: true });
        assert.equal(r.status, 200, r.text);
        const out = JSON.parse(r.text);
        assert.deepEqual([out.saved, out.turnedOn, out.safeBrowsing.on, out.safeBrowsing.working], [true, true, true, true]);
        assert.ok(!r.text.includes(GOOD), 'the key never comes back');
        st = await get('/api/settings');
        assert.equal(st.checks.safeBrowsing, true);
        assert.ok(st.safeBrowsing.saved && st.safeBrowsing.saved.by);
        assert.ok(!JSON.stringify(st).includes(GOOD) && !everything(store).includes(GOOD), 'not in any answer, nor in the records');
        const ev = (await store.listEvents(0)).filter(e => e.alert && e.kind === 'settings').map(e => e.text);
        assert.ok(ev.some(t => /saved a new Google Safe Browsing API key on the dashboard/.test(t)));
        assert.ok(ev.some(t => /turned on Google Safe Browsing on the dashboard/.test(t)));
        // Status says it works.
        const line = (await get('/api/status')).checks.find(c => c.id === 'safe-browsing');
        assert.deepEqual([line.ok, line.text], [true, 'Google Safe Browsing is on, and its key works.']);
        // Off, then Remove: destroyed, and off.
        r = await post('/api/policy', { key: 'safeBrowsing', value: false, projectId: project });
        assert.equal(r.status, 200, r.text);
        await new Promise(res => setTimeout(res, 5100));
        r = await post('/api/safe-browsing/remove', { projectId: project });
        assert.equal(r.status, 200, r.text);
        st = await get('/api/settings');
        assert.deepEqual([st.safeBrowsing.on, st.safeBrowsing.saved, st.checks.safeBrowsing], [false, null, false]);
        assert.equal(await intel.sbKey.get(), null);
    } finally { await new Promise(r => srv.close(r)); }
});
