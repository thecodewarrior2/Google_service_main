'use strict';
// The network checks with a fake network: Cloudflare Security DNS, Google Safe Browsing, the phishing
// lists, registry dates, and how their findings change a verdict. Every domain and address is made up.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const spruce = require('../src/engine/spruce');
const { createHttp } = require('../src/intel/http');
const { createThreats } = require('../src/intel/threats');
const { createFeeds } = require('../src/intel/feeds');
const { createRdap } = require('../src/intel/rdap');
const { createIntel } = require('../src/intel');
const { MemoryStore } = require('../src/store/memory');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const { loadConfig, configProblems } = require('../src/config');

const E = spruce.load();
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
const text = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body), headers: { get: () => null } });

// A fake internet: Cloudflare (filtered and unfiltered), Safe Browsing, the lists, IANA and a registry.
function fakeNet(opts = {}) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const u = new URL(url);
        calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
        if (opts.fail && opts.fail.test(u.host)) throw new Error('network down');
        if (u.host === 'security.cloudflare-dns.com' || u.host === 'cloudflare-dns.com') {
            const name = u.searchParams.get('name');
            const filtered = u.host === 'security.cloudflare-dns.com';
            if (name === 'evil-login.example') return json(filtered ? { Status: 0, Answer: [{ type: 1, data: '0.0.0.0' }] } : { Status: 0, Answer: [{ type: 1, data: '203.0.113.9' }] });
            if (name === 'blocked-nx.example') return json(filtered ? { Status: 3 } : { Status: 0, Answer: [{ type: 1, data: '203.0.113.10' }] });
            if (name === 'no-such-site.example') return json({ Status: 3 });
            return json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] });
        }
        if (u.host === 'safebrowsing.googleapis.com') {
            const entries = JSON.parse(init.body).threatInfo.threatEntries;
            return json({ matches: entries.filter(e => /phish-page/.test(e.url)).map(e => ({ threatType: 'SOCIAL_ENGINEERING', threat: { url: e.url } })) });
        }
        if (u.host === 'raw.githubusercontent.com' && u.pathname.startsWith('/openphish/')) return text(['https://listed-site.example/login', 'https://www.maple-schools.example/hacked/login.php', ...Array.from({ length: 30 }, (_, i) => `https://other${i}.example/x`)].join('\n'));
        if (u.host === 'phishing.army') return text(['# comment', 'phish-domain.example', 'maple-schools.example', 'paypal.com', 'storage.googleapis.com', ...Array.from({ length: 30 }, (_, i) => `bad${i}.example`)].join('\n'));
        // HaGeZi's wildcard format ("*.domain"), with its header.
        if (u.host === 'raw.githubusercontent.com' && u.pathname.startsWith('/hagezi/')) return text(['# Title: HaGeZi\'s Threat Intelligence Feeds - medium version', '# Expires: 8 hours', '*.tif-listed.example', '*.paypal.com', ...Array.from({ length: 30 }, (_, i) => `*.tif${i}.example`)].join('\n'));
        if (u.host === 'raw.githubusercontent.com') return text(['Scammer@Freemail.example', 'service@paypal.com', ...Array.from({ length: 30 }, (_, i) => `s${i}@scam.example`)].join('\n'));
        // TweetFeed's JSON: domains researchers reported, with their tags.
        if (u.host === 'api.tweetfeed.live') return json([{ date: '2026-11-01 00:00:00', user: 'researcher', type: 'domain', value: 'reported-site.example', tags: ['#phishing'] },
            { type: 'url', value: 'https://not-a-domain-entry.example/x' }, { type: 'domain', value: 'google.com', tags: ['#phishing'] },
            ...Array.from({ length: 30 }, (_, i) => ({ type: 'domain', value: `rep${i}.example`, tags: ['#malware'] }))]);
        if (u.host === 'data.iana.org') return json({ services: [[['example'], ['https://rdap.registry.example/']]] });
        if (u.host === 'rdap.registry.example') {
            const d = decodeURIComponent(u.pathname.split('/domain/')[1] || '');
            if (d === 'slow-registry.example') await new Promise(r => setTimeout(r, 6000));
            const age = { 'brand-new.example': 3, 'evil-login.example': 5, 'young-sender.example': 10, 'micros0ft.example': 7 }[d] ?? 4000;
            return json({ events: [{ eventAction: 'registration', eventDate: new Date(Date.now() - age * DAY).toISOString() }] });
        }
        return text('not found', 404);
    };
    return { fetch, calls };
}

test('Cloudflare Security: 0.0.0.0 is a block; a filtered NXDOMAIN the plain resolver answers is a block; a real NXDOMAIN is "does not exist"; failures are "unknown"', async () => {
    const net = fakeNet();
    const t = createThreats({ http: createHttp({ fetch: net.fetch }), cfg: { cloudflareThreats: true }, engine: E });
    const r = await t.checkHosts(['evil-login.example', 'blocked-nx.example', 'no-such-site.example', 'fine.example', 'not a host!']);
    assert.equal(r.get('evil-login.example').verdict, 'unsafe');
    assert.equal(r.get('blocked-nx.example').verdict, 'unsafe');
    assert.equal(r.get('no-such-site.example').verdict, 'nonexistent');
    assert.equal(r.get('fine.example').verdict, 'clean');
    assert.ok(!r.has('not a host!'), 'only real host names are sent');
    assert.ok(net.calls.every(c => !c.url.includes('/login')), 'only names are sent to DNS, never paths');
    const n = net.calls.length;
    await t.checkHosts(['evil-login.example']);
    assert.equal(net.calls.length, n, 'remembered');
    const down = createThreats({ http: createHttp({ fetch: fakeNet({ fail: /cloudflare/ }).fetch }), cfg: { cloudflareThreats: true }, engine: E });
    assert.equal((await down.checkHosts(['x.example'])).get('x.example').verdict, 'unknown');
});

test('Safe Browsing: one batched request; no #part ever, no query for one-time links; no key, no lookup; failures "unknown"', async () => {
    const net = fakeNet();
    const t = createThreats({ http: createHttp({ fetch: net.fetch }), cfg: { cloudflareThreats: false, safeBrowsing: true, safeBrowsingKey: 'k-123' }, engine: E });
    const links = [{ url: 'https://phish-page.example/a?x=1#frag', text: 'Open' }, { url: 'https://fine.example/news', text: 'News' },
                   { url: 'https://accounts.example/reset-password?token=SECRET123', text: 'Reset your password' }];
    const r = await t.checkUrls(links);
    assert.equal(r.get(links[0].url).verdict, 'unsafe');
    assert.match(r.get(links[0].url).reason, /phishing or a deceptive site/);
    assert.equal(r.get(links[1].url).verdict, 'clean');
    const sb = net.calls.filter(c => /safebrowsing/.test(c.url));
    assert.equal(sb.length, 1, 'one request for all links');
    const sent = sb[0].body.threatInfo.threatEntries.map(e => e.url);
    assert.ok(sent.includes('https://phish-page.example/a?x=1'), 'the fragment is dropped');
    assert.ok(!sent.some(u => /SECRET123|#/.test(u)), JSON.stringify(sent));
    assert.match(sb[0].url, /key=k-123/);
    const off = createThreats({ http: createHttp({ fetch: net.fetch }), cfg: { cloudflareThreats: false, safeBrowsing: true, safeBrowsingKey: '' }, engine: E });
    assert.equal((await off.checkUrls(links)).get(links[0].url).verdict, 'unknown');
    const down = createThreats({ http: createHttp({ fetch: fakeNet({ fail: /safebrowsing/ }).fetch }), cfg: { safeBrowsingKey: 'k' }, engine: E });
    assert.equal((await down.checkUrls(links)).get(links[0].url).verdict, 'unknown');
});

test('phishing lists: synced once a day into the shared store, sanitized like the extension, matched locally', async () => {
    const net = fakeNet();
    const store = new MemoryStore();
    let now = Date.now();
    const feeds = createFeeds({ http: createHttp({ fetch: net.fetch }), store, engine: E, now: () => now, log: { error() {} } });
    const out = await feeds.sync();
    assert.deepEqual(out.feeds.map(f => f.id), ['openphish', 'phishingarmy', 'hagezitif', 'tweetfeed', 'sefinekemails']);
    assert.ok(out.feeds.every(f => f.count > 20), JSON.stringify(out));
    const blob = await store.getBlob('feed_phishingarmy');
    const entries = zlib.gunzipSync(blob.bytes).toString().split('\n');
    assert.ok(entries.includes('phish-domain.example'));
    assert.ok(!entries.includes('paypal.com') && !entries.includes('storage.googleapis.com'), 'never a protected brand\'s domain or a cloud-storage host');
    assert.equal(await feeds.urlHit('https://listed-site.example/login'), 'OpenPhish community feed');
    assert.equal(await feeds.urlHit('https://www.phish-domain.example/any/page'), 'Phishing Army (extended)');
    assert.equal(await feeds.domainHit('mail.phish-domain.example'), 'Phishing Army (extended)');
    assert.equal(await feeds.addressHit('scammer@freemail.example'), 'Sefinek scam-sender list');
    assert.equal(await feeds.addressHit('service@paypal.com'), null, 'a brand\'s own address is never on the list');
    assert.equal(await feeds.urlHit('https://fine.example/'), null);
    // 0.5.21: HaGeZi ("*.domain": the domain and every name under it) and TweetFeed (its JSON's domains, a
    // community report: confidence 'report'); neither keeps a protected brand's domain.
    assert.equal(await feeds.domainHit('login.tif-listed.example'), 'HaGeZi Threat Intelligence Feeds');
    assert.equal(await feeds.urlHit('https://reported-site.example/a'), 'TweetFeed (researchers\' reports)');
    assert.equal(await feeds.domainHit('paypal.com'), null);
    assert.equal(await feeds.domainHit('google.com'), null);
    assert.equal(await feeds.urlHit('https://not-a-domain-entry.example/x'), null, 'TweetFeed\'s URL entries aren\'t its domain list');
    assert.equal(feeds.confidenceOf('TweetFeed (researchers\' reports)'), 'report');
    assert.equal(feeds.confidenceOf('HaGeZi Threat Intelligence Feeds'), 'list');
    const n = net.calls.length;
    await feeds.sync();
    assert.equal(net.calls.length, n, 'not again within a day');
    now += 21 * 60 * 60 * 1000;
    await feeds.sync();
    assert.equal(net.calls.length, n + 5, 'the next day');
    // A broken download keeps the previous copy.
    const store2 = new MemoryStore();
    const tiny = createFeeds({ http: createHttp({ fetch: async () => text('one.example\ntwo.example') }), store: store2, engine: E, log: { error() {} } });
    assert.ok((await tiny.sync()).feeds.every(f => /keep|kept/.test(f.error || '')));
    assert.ok((await store2.listEvents()).some(e => /previous copy is kept/.test(e.text)));
});

test('site age: registry date through IANA\'s list, shared and remembered; a slow registry is "unknown"', async () => {
    const net = fakeNet();
    const store = new MemoryStore();
    const rdap = createRdap({ http: createHttp({ fetch: net.fetch }), store, engine: E });
    assert.equal(await rdap.ageDays('login.brand-new.example'), 3);
    assert.equal(await rdap.ageDays('old-site.example'), 4000);
    const n = net.calls.length;
    assert.equal(await createRdap({ http: createHttp({ fetch: net.fetch }), store, engine: E }).ageDays('brand-new.example'), 3, 'another instance uses the shared answer');
    assert.equal(net.calls.length, n);
    const t0 = Date.now();
    assert.equal(await rdap.ageDays('slow-registry.example'), null);
    assert.ok(Date.now() - t0 < 5500);
    assert.equal(await rdap.ageDays('not a domain'), null);
});

test('an email with checks: blocked and listed links are dangerous, the sender\'s list and domain findings and site ages count; failures never make it safer', async () => {
    const raw = (from, html, dmarc = 'none') => Buffer.from([`From: "Billing" <${from}>`, 'To: reader@maple-schools.example', 'Subject: Verify your account',
        `Authentication-Results: mx.google.com; dmarc=${dmarc} header.from=${from.split('@')[1]}`, 'Content-Type: text/html', '', html].join('\r\n'));
    const ctx = (intel) => ({ mailbox: 'reader@maple-schools.example', orgDomains: ['maple-schools.example'], intel });
    const store = new MemoryStore();
    const net = fakeNet();
    const intel = createIntel({ cfg: loadConfig({ SAFE_BROWSING: 'true', SAFE_BROWSING_KEY: 'k', STORE: 'memory' }), store, engine: E, fetch: net.fetch, log: { error() {} } });
    await intel.feeds.sync();
    // A link Cloudflare blocks, on a 5-day-old site: dangerous link (5) and a young site about signing in (3).
    let r = await analyze(await readMessage(raw('billing@fine.example', '<p>Please verify your account.</p><a href="https://evil-login.example/verify">Verify now</a>')), ctx(intel));
    assert.equal(r.links[0].severity, 'danger'); assert.match(r.links[0].reason, /Cloudflare Security/);
    assert.ok(r.signals.some(s => s.kind === 'dangerous-links' && s.weight === 5));
    assert.ok(r.signals.some(s => s.kind === 'young-link-domain' && s.weight === 3), JSON.stringify(r.signals));
    assert.equal(r.status, 'flagged');
    assert.ok(r.checks.cloudflare >= 1 && r.checks.safeBrowsing >= 1 && r.checks.lists && r.checks.ages >= 1, JSON.stringify(r.checks));
    // Safe Browsing and the lists.
    r = await analyze(await readMessage(raw('billing@fine.example', '<a href="https://phish-page.example/x">Open</a> <a href="https://listed-site.example/login">Sign in</a>', 'pass')), ctx(intel));
    assert.deepEqual(r.links.map(l => l.severity), ['danger', 'danger']);
    // The sender: on the scam-sender list; a domain that doesn't exist; a young look-alike.
    r = await analyze(await readMessage(raw('scammer@freemail.example', '<p>Hello.</p>', 'pass')), ctx(intel));
    assert.ok(r.signals.some(s => s.kind === 'scam-sender-list' && s.weight === 5));
    r = await analyze(await readMessage(raw('a@no-such-site.example', '<p>Hello.</p>')), ctx(intel));
    assert.ok(r.signals.some(s => s.kind === 'sender-domain-missing'));
    r = await analyze(await readMessage(raw('a@young-sender.example', '<p>Hello.</p>')), ctx(intel));
    assert.ok(r.signals.some(s => s.kind === 'young-sender-domain' && s.weight === 2));
    // Own organization's links and trusted senders cost no lookups.
    const before = net.calls.length;
    const own = await analyze(await readMessage(raw('it@maple-schools.example', '<a href="https://portal.maple-schools.example/x">Portal</a>', 'pass')), ctx(intel));
    assert.ok(!net.calls.slice(before).some(c => /maple-schools/.test(c.url)), 'our own sites are not looked up');
    // A list that has the organization's whole domain (a hacked school site) flags neither its mail nor
    // links to its sites; an exact address listed on one of its sites still counts.
    assert.ok(!own.signals.some(s => s.kind === 'sender-domain-listed' || s.kind === 'dangerous-links'), JSON.stringify(own.signals));
    assert.equal(own.status, 'clean');
    const hacked = await analyze(await readMessage(raw('it@maple-schools.example', '<a href="https://www.maple-schools.example/hacked/login.php">Sign in</a>', 'pass')), ctx(intel));
    assert.equal(hacked.links[0].severity, 'danger'); assert.match(hacked.links[0].reason, /OpenPhish/);
    assert.equal(await intel.feeds.urlHit('https://portal.maple-schools.example/x'), 'Phishing Army (extended)', 'the list does have the domain');
    const b2 = net.calls.length;
    await analyze(await readMessage(raw('billing@fine.example', '<a href="https://evil-login.example/v">x</a>')), Object.assign(ctx(intel), { trusted: true }));
    assert.equal(net.calls.length, b2, 'trusted senders: no lookups');
    // Everything down: same as offline, never safer.
    const dead = createIntel({ cfg: loadConfig({ SAFE_BROWSING: 'true', SAFE_BROWSING_KEY: 'k', STORE: 'memory' }), store: new MemoryStore(), engine: E, fetch: async () => { throw new Error('down'); }, log: { error() {} } });
    const off = await analyze(await readMessage(raw('billing@fine.example', '<a href="https://evil-login.example/verify">Verify now</a>')), ctx(null));
    const failed = await analyze(await readMessage(raw('billing@fine.example', '<a href="https://evil-login.example/verify">Verify now</a>')), ctx(dead));
    assert.equal(failed.score, off.score);
    assert.ok(failed.checks.notChecked >= 1);
});

test('settings: Cloudflare only by default; Safe Browsing only when turned on, and then with its key', async () => {
    const base = { ROLE: 'worker', STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', DELEGATED_SA: 'd@p.iam.gserviceaccount.com', PILOT_USERS: 'a@maple-schools.example', PUBSUB_TOPIC: 'projects/p/topics/t', PUSH_AUDIENCE: 'https://w', PUSH_SERVICE_ACCOUNT: 'push@p.iam.gserviceaccount.com' };
    assert.deepEqual(configProblems(loadConfig(base)), [], 'no key needed by default');
    assert.match(configProblems(loadConfig(Object.assign({ SAFE_BROWSING: 'true' }, base))).join(' '), /SAFE_BROWSING_KEY/);
    assert.deepEqual(configProblems(loadConfig(Object.assign({ SAFE_BROWSING: 'true', SAFE_BROWSING_KEY: 'k' }, base))), []);
    const c = loadConfig({});
    assert.deepEqual([c.cloudflareThreats, c.safeBrowsing, c.phishingLists, c.siteAge], [true, false, true, true]);
    // By default nothing goes to Safe Browsing, even with a key set, and links aren't counted "not checked".
    const net = fakeNet();
    const intel = createIntel({ cfg: loadConfig({ SAFE_BROWSING_KEY: 'k', STORE: 'memory' }), store: new MemoryStore(), engine: E, fetch: net.fetch, log: { error() {} } });
    const r = await analyze(await readMessage(Buffer.from(['From: "Billing" <billing@fine.example>', 'To: reader@maple-schools.example', 'Subject: Hi',
        'Content-Type: text/html', '', '<a href="https://phish-page.example/x">Open</a> <a href="https://evil-login.example/v">Verify</a>'].join('\r\n'))),
        { mailbox: 'reader@maple-schools.example', orgDomains: ['maple-schools.example'], intel });
    assert.ok(!net.calls.some(c => /safebrowsing/.test(c.url)), 'no Safe Browsing request');
    assert.ok(net.calls.some(c => /security\.cloudflare-dns\.com/.test(c.url)), 'Cloudflare is asked');
    assert.equal(r.checks.safeBrowsing, 0);
    assert.equal(r.checks.notChecked, 0);
    assert.equal(r.links.find(l => /evil-login/.test(l.url)).severity, 'danger', 'Cloudflare still flags');
});

test('0.5.21: a list match is dangerous; a community report (TweetFeed) is a sign of 2, never "dangerous" on its own', async () => {
    const raw = (from, html, dmarc = 'pass') => Buffer.from([`From: "Billing" <${from}>`, 'To: reader@maple-schools.example', 'Subject: Your invoice',
        `Authentication-Results: mx.google.com; dmarc=${dmarc} header.from=${from.split('@')[1]}`, 'Content-Type: text/html', '', html].join('\r\n'));
    const ctx = (intel) => ({ mailbox: 'reader@maple-schools.example', orgDomains: ['maple-schools.example'], intel });
    const net = fakeNet();
    const intel = createIntel({ cfg: loadConfig({ STORE: 'memory' }), store: new MemoryStore(), engine: E, fetch: net.fetch, log: { error() {} } });
    await intel.feeds.sync();
    // HaGeZi's list: dangerous, as the other lists.
    let r = await analyze(await readMessage(raw('billing@fine.example', '<p>Your invoice is ready.</p><a href="https://pay.tif-listed.example/invoice">View invoice</a>')), ctx(intel));
    assert.equal(r.links[0].severity, 'danger');
    assert.match(r.links[0].reason, /listed as phishing by HaGeZi Threat Intelligence Feeds/);
    // TweetFeed: the link is marked for caution, and a sign of 2; the email isn't flagged for it alone.
    r = await analyze(await readMessage(raw('billing@fine.example', '<p>Your invoice is ready.</p><a href="https://reported-site.example/invoice">View invoice</a>')), ctx(intel));
    assert.equal(r.links[0].severity, 'caution');
    assert.match(r.links[0].reason, /^reported as phishing or malware by TweetFeed \(researchers' reports\)/);
    const sign = r.signals.find(s => s.kind === 'reported-link');
    assert.equal(sign && sign.weight, 2, JSON.stringify(r.signals));
    assert.ok(!r.signals.some(s => s.kind === 'dangerous-links'));
    assert.notEqual(r.status, 'flagged');
    // A sender domain reported there: 2, not the 5 of a listed one.
    r = await analyze(await readMessage(raw('billing@rep3.example', '<p>Your invoice is ready.</p>')), ctx(intel));
    assert.equal((r.signals.find(s => s.kind === 'sender-domain-reported') || {}).weight, 2, JSON.stringify(r.signals));
    r = await analyze(await readMessage(raw('billing@tif4.example', '<p>Your invoice is ready.</p>')), ctx(intel));
    assert.equal((r.signals.find(s => s.kind === 'sender-domain-listed') || {}).weight, 5);
});
