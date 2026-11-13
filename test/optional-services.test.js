'use strict';
// 0.5.37: two optional services, off by default, each turned on on its Settings page with a key kept in
// Secret Manager: Spamhaus's free Data Query Service (DBL and ZRD, looked up per email, a daily cap under its
// 100,000 fair use) and abuse.ch (URLhaus and ThreatFox, downloaded like the phishing lists). Every domain,
// key and answer here is made up (fake resolver and fake downloads).
const test = require('node:test');
const assert = require('node:assert');
const spruce = require('../src/engine/spruce');
const { createSpamhaus, errorOf, TEST_DOMAIN } = require('../src/intel/spamhaus');
const { createApiKey } = require('../src/intel/apikey');
const { memorySecrets } = require('../src/intel/sbkey');
const { abusechFeeds, urlhausUrls, threatfoxIocs, URLHAUS } = require('../src/intel/abusech');
const { createFeeds } = require('../src/intel/feeds');
const { createHttp } = require('../src/intel/http');
const { MemoryStore } = require('../src/store/memory');
const { loadConfig } = require('../src/config');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const training = require('../src/training');

const E = spruce.load();
const ORG = 'maple-schools.example';
const KEY = 'abcdefghijklmnopqrstuvwxyz';                      // (made up, 26 characters)
const silent = { error() {}, warn() {} };
const cfgOf = (env = {}) => loadConfig(Object.assign({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `a@${ORG}` }, env));

// A fake resolver: what Spamhaus would answer for each name (with this key only).
function resolver(answers) {
    const asked = [];
    return { asked, resolve4: async (name) => {
        asked.push(name);
        const m = new RegExp(`^(.+)\\.${KEY}\\.(dbl|zrd)\\.dq\\.spamhaus\\.net$`).exec(name);
        const a = m && answers[`${m[2]}:${m[1]}`];
        if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
        return [].concat(a);
    } };
}
async function spamhausWith(answers, env = { SPAMHAUS: 'on' }) {
    const store = new MemoryStore();
    const cfg = cfgOf(env);
    const r = resolver(answers);
    const sh = createSpamhaus({ cfg, store, resolver: r, log: silent });
    const key = createApiKey({ id: 'spamhaus', label: 'Spamhaus', store, secrets: memorySecrets(), keyRe: /^[a-z0-9]{20,40}$/i, test: (k) => sh.testKey(k), log: silent });
    sh.setKey(key);
    return { sh, key, store, r, cfg };
}

test('Spamhaus: the DBL and ZRD answers read; full host names asked; errors and not listed told apart', async () => {
    const { sh, key, r } = await spamhausWith({ 'dbl:login.fresh-phish.example': '127.0.1.4', 'zrd:login.fresh-phish.example': '127.0.2.3', 'dbl:pages.hosting.example': ['127.0.1.2', '127.0.1.104'], [`dbl:${TEST_DOMAIN}`]: '127.0.1.2' });
    assert.equal((await sh.checkDomains(['login.fresh-phish.example'])).size, 0, 'no key yet: nothing asked');
    assert.equal(r.asked.length, 0);
    await key.save(KEY, `it@${ORG}`);
    const out = await sh.checkDomains(['login.fresh-phish.example', 'pages.hosting.example', 'clean.example']);
    assert.deepEqual(out.get('login.fresh-phish.example'), { dbl: { list: 'phishing', severity: 'danger' }, zrdHours: 3 });
    assert.equal(out.get('pages.hosting.example').dbl.severity, 'spam', 'every answer read: the strongest counts');
    assert.deepEqual(out.get('clean.example'), { dbl: null, zrdHours: null });
    assert.ok(r.asked.includes(`login.fresh-phish.example.${KEY}.dbl.dq.spamhaus.net`) && r.asked.includes(`login.fresh-phish.example.${KEY}.zrd.dq.spamhaus.net`));
    // Asked once an hour at most.
    const n = r.asked.length;
    await sh.checkDomains(['login.fresh-phish.example']);
    assert.equal(r.asked.length, n);
    assert.equal(errorOf('127.255.255.250'), 'the DQS key is disabled');
    assert.match(errorOf('127.255.255.249'), /an error from Spamhaus/);
    assert.equal(errorOf('127.0.1.4'), null);
});

test('Spamhaus: off by default; a key is tested with its test entry; the key refused is noted and alerted', async () => {
    const off = await spamhausWith({ 'dbl:x.example': '127.0.1.4' }, {});
    await off.key.save(KEY, `it@${ORG}`).catch(() => {});
    assert.equal(off.cfg.spamhaus, false);
    assert.equal((await off.sh.checkDomains(['x.example'])).size, 0);
    const t = await spamhausWith({ [`dbl:${TEST_DOMAIN}`]: '127.0.1.2', 'dbl:x.example': '127.255.255.250' });
    await assert.rejects(t.key.save('not a key!', `it@${ORG}`), /doesn't look like a Spamhaus key/);
    const alerts = [];
    t.key.setAlert(async (text) => { alerts.push(text); });
    await t.key.save(KEY, `it@${ORG}`);
    assert.equal(JSON.stringify(await t.store.getState('spamhausKey')).includes(KEY), false, 'never the key in Firestore');
    assert.deepEqual((await t.key.status()).saved.by, `it@${ORG}`);
    await t.sh.checkDomains(['x.example']);
    assert.match(alerts[0], /Spamhaus didn't accept the service's lookups \(the DQS key is disabled\)/);
    const wrong = await spamhausWith({});
    await assert.rejects(wrong.key.save(KEY, `it@${ORG}`), /Spamhaus doesn't know this key/);
});

test('Spamhaus: the daily limit (under the 100,000 fair use) stops lookups for the day', async () => {
    const { sh, key, store, r } = await spamhausWith({ [`dbl:${TEST_DOMAIN}`]: '127.0.1.2' }, { SPAMHAUS: 'on', SPAMHAUS_DAILY_MAX: '1000' });
    await key.save(KEY, `it@${ORG}`);
    const day = new Date().toISOString().slice(0, 10);
    await store.incStats(`spamhaus-${day}`, { spamhausQueries: 999 });
    assert.equal((await sh.quota()).stopped, false);
    await store.incStats(`spamhaus-${day}`, { spamhausQueries: 5 });
    assert.equal((await sh.quota()).stopped, true);
    // (this instance reads the day's total every 5 minutes: a fresh one reads it at its first lookup)
    const before = r.asked.length;
    await sh.checkDomains(['a.example']);
    await sh.checkDomains(['b.example', 'c.example']);
    assert.ok(r.asked.length - before <= 2, 'stopped once the total is known');
});

test('in the checks: a link site on the DBL is dangerous; a new sender domain (ZRD) is a sign; nothing when off', async () => {
    const { sh, key } = await spamhausWith({ [`dbl:${TEST_DOMAIN}`]: '127.0.1.2', 'dbl:login.fresh-phish.example': '127.0.1.4', 'zrd:billing-notice.example': '127.0.2.5' });
    await key.save(KEY, `it@${ORG}`);
    const facts = await readMessage(Buffer.from(['From: Billing <help@billing-notice.example>', `To: pat@${ORG}`, 'Subject: Invoice', 'Authentication-Results: mx.google.com; dmarc=pass',
        'Content-Type: text/html; charset=utf-8', '', '<p>Your invoice is ready.</p><p><a href="https://login.fresh-phish.example/inv">View invoice</a></p>'].join('\r\n')));
    const r = await analyze(facts, { mailbox: `pat@${ORG}`, orgDomains: [ORG], intel: { spamhaus: sh } });
    assert.ok(r.links.some(l => l.severity === 'danger' && /Spamhaus's Domain Blocklist \(phishing\)/.test(l.reason)), JSON.stringify(r.links));
    assert.ok(r.signals.some(s => s.kind === 'zrd-sender' && s.weight === 3 && /about 5 hours ago/.test(s.text)));
    assert.equal(r.checks.spamhaus, 2);
    const none = await analyze(facts, { mailbox: `pat@${ORG}`, orgDomains: [ORG], intel: {} });
    assert.ok(!none.signals.some(s => /zrd|spamhaus/.test(s.kind || '')));
});

test('abuse.ch: URLhaus\'s CSV and ThreatFox\'s answer read; off (the default) nothing downloaded; on, matched like the phishing lists; the key never in an error', async () => {
    const csv = ['# URLhaus recent', '# id,dateadded,url,url_status,last_online,threat,tags,urlhaus_link,reporter',
        ...Array.from({ length: 25 }, (_, i) => `"${i}","2026-11-12 10:00:00","http://drop${i}.malware-host.example/inv.zip","online","2026-11-12 10:00:00","malware_download","zip","https://urlhaus.abuse.ch/url/${i}/","reporter"`)].join('\n');
    assert.equal(urlhausUrls(csv).split('\n')[0], 'http://drop0.malware-host.example/inv.zip');
    const tf = { query_status: 'ok', data: [...Array.from({ length: 25 }, (_, i) => ({ ioc: `c2-${i}.badnet.example`, ioc_type: 'domain' })), { ioc: 'http://pay.badnet.example/a', ioc_type: 'url' }, { ioc: '192.0.2.1:443', ioc_type: 'ip:port' }] };
    assert.equal(threatfoxIocs(tf, 'domain').split('\n').length, 25);
    assert.equal(threatfoxIocs(tf, 'url'), 'http://pay.badnet.example/a');
    assert.throws(() => threatfoxIocs({ query_status: 'unknown_auth_key' }, 'domain'), /unknown_auth_key/);

    const calls = [];
    const fetch = async (url, opts = {}) => {
        calls.push({ url, headers: opts.headers || {} });
        const u = new URL(url);
        const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o), headers: { get: () => null } });
        if (u.host === 'urlhaus-api.abuse.ch') return u.pathname.includes(`/${KEY}/`) ? { ok: true, status: 200, text: async () => csv, headers: { get: () => null } } : { ok: false, status: 401, text: async () => '{}', headers: { get: () => null } };
        if (u.host === 'threatfox-api.abuse.ch') return (opts.headers || {})['Auth-Key'] === KEY ? json(tf) : { ok: false, status: 401, json: async () => ({}), text: async () => '{}', headers: { get: () => null } };
        return { ok: true, status: 200, text: async () => Array.from({ length: 30 }, (_, i) => `bad${i}.example`).join('\n'), headers: { get: () => null } };
    };
    const store = new MemoryStore();
    const cfg = cfgOf({});
    const http = createHttp({ fetch });
    const key = createApiKey({ id: 'abusech', label: 'abuse.ch', store, secrets: memorySecrets(), keyRe: /^[A-Za-z0-9]{20,80}$/, test: async () => ({ ok: true }), log: silent });
    let on = false;
    const feedCfg = { get abusech() { return on; } };
    const feeds = createFeeds({ http, store, engine: E, log: silent, extra: () => abusechFeeds({ cfg: feedCfg, key, http }) });
    await feeds.sync();
    assert.ok(!calls.some(c => /abuse\.ch/.test(c.url)), 'off: nothing asked of abuse.ch');
    assert.deepEqual((await feeds.status()).filter(l => l.optional).map(l => [l.id, l.off]), [['urlhaus', true], ['threatfoxdomains', true], ['threatfoxurls', true]]);
    assert.equal(cfg.abusech, false, 'off by default');
    on = true;
    await feeds.sync({ only: ['urlhaus'] });
    assert.ok(!calls.some(c => /abuse\.ch/.test(c.url)), 'on without a key: still nothing');
    await key.save(KEY, `it@${ORG}`);
    const r = await feeds.sync({ only: ['urlhaus', 'threatfoxdomains', 'threatfoxurls'] });
    assert.deepEqual(r.feeds.map(f => [f.id, f.count]), [['urlhaus', 25], ['threatfoxdomains', 25], ['threatfoxurls', 1]]);
    assert.equal(calls.find(c => c.url.includes('urlhaus')).url, URLHAUS(KEY));
    assert.equal(calls.find(c => c.url.includes('threatfox')).headers['Auth-Key'], KEY);
    assert.equal(await feeds.urlHit('http://drop3.malware-host.example/inv.zip'), 'URLhaus (abuse.ch)');
    assert.equal(await feeds.domainHit('c2-7.badnet.example'), 'ThreatFox domains (abuse.ch)');
    // A refused key: an error that names the status, never the address (it holds the key).
    await key.save('ZYXWVUTSRQPONMLKJIHGFEDCBA', `it@${ORG}`);
    const bad = await feeds.sync({ force: true, only: ['urlhaus'] });
    assert.match(bad.feeds[0].error, /HTTP 401: the key was refused/);
    const everything = JSON.stringify([await feeds.status(), await store.getState('feedHealth'), store.events]);
    assert.ok(!everything.includes(KEY) && !everything.includes('ZYXWVUTSRQPONMLKJIHGFEDCBA'), 'no key anywhere');
    // Off again: its copy isn't used.
    on = false;
    await feeds.sync({ force: true, only: ['openphish'] });
    assert.equal(await feeds.urlHit('http://drop3.malware-host.example/inv.zip'), null);
});

test('the retraining export leaves out what abuse.ch and Spamhaus found (their terms: no AI training)', () => {
    const aiFacts = { subject: 'Invoice', senderName: 'Billing', senderAddress: 'help@billing-notice.example', bodyText: 'Your invoice is ready.', recipient: 'pat',
        links: [{ text: 'View', host: 'drop.malware-host.example', destHost: '', finding: 'listed as phishing by URLhaus (abuse.ch)' },
                { text: 'Pay', host: 'login.fresh-phish.example', destHost: '', finding: 'listed by Spamhaus\'s Domain Blocklist (phishing)' },
                { text: 'Docs', host: 'p0.example', destHost: '', finding: 'listed as phishing by OpenPhish community feed' }] };
    const out = training.deidentify(aiFacts, { mailbox: `pat@${ORG}`, orgDomains: [ORG], label: 'phishing' });
    assert.deepEqual(out.links.map(l => l.finding), ['', '', 'listed as phishing by OpenPhish community feed']);
});

test('0.5.41: Spamhaus refusing (its servers don\'t know the key: REFUSED) is said plainly, at Test and in the alert', async () => {
    const store = new MemoryStore();
    const cfg = cfgOf({ SPAMHAUS: 'on' });
    let code = 'EREFUSED';
    const refusing = { resolve4: async () => { throw Object.assign(new Error('queryA ' + code), { code }); } };
    const sh = createSpamhaus({ cfg, store, resolver: refusing, log: silent, retryMs: 1 });
    const key = createApiKey({ id: 'spamhaus', label: 'Spamhaus', store, secrets: memorySecrets(), keyRe: /^[a-z0-9]{20,40}$/i, test: (k) => sh.testKey(k), log: silent });
    sh.setKey(key);
    await assert.rejects(key.save(KEY, `it@${ORG}`), (e) => /Spamhaus refused the lookup: its servers don't know this key yet\. A new key can take up to an hour to sync across Spamhaus's servers/.test(e.message) && !e.message.includes(KEY));
    assert.equal(await store.getState('spamhausKey'), null, 'nothing saved');
    code = 'ESERVFAIL';
    await assert.rejects(key.save(KEY, `it@${ORG}`), /Spamhaus couldn't be reached through the service's DNS resolver \(ESERVFAIL\)/);
    // A key saved that Spamhaus stops knowing: lookups refused → the alert says why.
    const ok = await spamhausWith({ [`dbl:${TEST_DOMAIN}`]: '127.0.1.2' });
    await ok.key.save(KEY, `it@${ORG}`);
    const alerts = [];
    ok.key.setAlert(async (t) => { alerts.push(t); });
    const sh2 = createSpamhaus({ cfg: ok.cfg, store: ok.store, resolver: { resolve4: async () => { throw Object.assign(new Error('x'), { code: 'EREFUSED' }); } }, log: silent, retryMs: 1 });
    sh2.setKey(ok.key);
    await sh2.checkDomains(['x.example']);
    assert.match(alerts[0], /Spamhaus refused the lookups: its servers don't know the key/);
});

test('0.5.42: a refused lookup is asked again: while a new key syncs across Spamhaus\'s servers, one that knows it answers', async () => {
    const { REFUSED_TRIES, TEST_TRIES } = require('../src/intel/spamhaus');
    const store = new MemoryStore();
    const cfg = cfgOf({ SPAMHAUS: 'on' });
    // The first answers come from servers that don't know the key yet.
    let refusals = 2;
    const answers = { [`dbl:${TEST_DOMAIN}`]: '127.0.1.2', 'dbl:login.fresh-phish.example': '127.0.1.4' };
    const inner = resolver(answers);
    const syncing = { asked: [], resolve4: async (name) => { syncing.asked.push(name); if (refusals > 0) { refusals--; throw Object.assign(new Error('refused'), { code: 'EREFUSED' }); } return inner.resolve4(name); } };
    const sh = createSpamhaus({ cfg, store, resolver: syncing, log: silent, retryMs: 1 });
    const key = createApiKey({ id: 'spamhaus', label: 'Spamhaus', store, secrets: memorySecrets(), keyRe: /^[a-z0-9]{20,40}$/i, test: (k) => sh.testKey(k), log: silent });
    sh.setKey(key);
    assert.deepEqual(await sh.testKey(KEY), { ok: true }, 'refused twice, then answered');
    assert.equal(syncing.asked.length, 3);
    await key.save(KEY, `it@${ORG}`);
    refusals = 1;
    const out = await sh.checkDomains(['login.fresh-phish.example']);
    assert.equal(out.get('login.fresh-phish.example').dbl.list, 'phishing', 'an email\'s lookup is asked again too');
    // Every server refusing: refused after the tries, said plainly.
    refusals = 100;
    syncing.asked.length = 0;
    const t = await sh.testKey(KEY);
    assert.equal(syncing.asked.length, TEST_TRIES);
    assert.match(t.fix, /A new key can take up to an hour to sync across Spamhaus's servers, and this error is expected until then/);
    syncing.asked.length = 0;
    await sh.lookup('other.example', KEY);
    assert.equal(syncing.asked.length, 2 * REFUSED_TRIES, 'DBL and ZRD, each asked 3 times');
    assert.ok(REFUSED_TRIES <= 3 && TEST_TRIES <= 6, 'a few tries only (each counts toward the day\'s lookups)');
});
