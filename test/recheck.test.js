'use strict';
// 0.5.35: delivered mail is checked again. Each email left in the Inbox keeps short hashes of its link sites
// and sender with its "checked" marker; when a phishing list's daily download adds one, the emails that have
// it are checked again in full and moved (enforce mode) or recorded (monitor mode), with who got them,
// whether they were opened and (Settings → Link clicks) what Gmail's logs say. Every address, site and email
// here is made up.
const test = require('node:test');
const assert = require('node:assert');
const spruce = require('../src/engine/spruce');
const R = require('../src/recheck');
const { createHttp } = require('../src/intel/http');
const { createFeeds } = require('../src/intel/feeds');
const { MemoryStore } = require('../src/store/memory');
const { Service } = require('../src/pipeline');
const { loadConfig } = require('../src/config');

const E = spruce.load();
const ORG = 'maple-schools.example';
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const silent = { error() {}, warn() {} };
const text = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body), headers: { get: () => null } });
const filler = (f) => Array.from({ length: 30 }, (_, i) => f(i));

test('the hashes: link sites and the domains above them, a shared-hosting page by its exact address, the sender; never the organization\'s or a protected brand\'s sites', () => {
    const ix = R.indexOf(E, { urls: ['https://login.fresh-phish.example/verify?u=1', 'https://www.maple-schools.example/calendar', 'https://accounts.google.com/x', 'https://pub-123.r2.dev/page.html'],
        sender: 'Billing <billing@vendor-mail.example>'.replace(/.*</, '').replace('>', ''), orgDomains: [ORG] });
    const has = (k, v) => ix.includes(`${k}${R.hashOf(v)}`);
    assert.ok(has('d', 'login.fresh-phish.example') && has('d', 'fresh-phish.example'));
    assert.ok(!has('d', 'example'), 'never a bare ending');
    assert.ok(!has('d', 'www.maple-schools.example') && !has('d', 'maple-schools.example'), 'not our own sites');
    assert.ok(!has('d', 'accounts.google.com') && !has('d', 'google.com'), 'not a protected brand\'s');
    assert.ok(!has('d', 'pub-123.r2.dev') && !has('d', 'r2.dev'), 'shared hosting: not the whole site');
    assert.ok(has('u', E.normalizeFeedUrl('https://pub-123.r2.dev/page.html')), 'the exact page');
    assert.ok(has('s', 'billing@vendor-mail.example'));
    assert.ok(ix.every(x => /^[dus][0-9a-f]{16}$/.test(x)), 'only hashes');
    // A list's entries are looked for by the same hashes.
    assert.deepEqual(R.entryHashes(E, 'domain', 'fresh-phish.example'), [`d${R.hashOf('fresh-phish.example')}`]);
    assert.deepEqual(R.entryHashes(E, 'url', 'https://login.fresh-phish.example/a/b'), [`d${R.hashOf('login.fresh-phish.example')}`]);
    assert.deepEqual(R.entryHashes(E, 'url', 'https://pub-123.r2.dev/page.html'), [`u${R.hashOf(E.normalizeFeedUrl('https://pub-123.r2.dev/page.html'))}`]);
    const many = R.indexOf(E, { urls: filler(i => `https://a${i}.site${i}.example/`), sender: 'x@y.example' });
    assert.equal(many.length, R.INDEX_MAX);
});

test('Gmail\'s log events: found by the email\'s Message-ID wherever it sits; the event type read', () => {
    const ev = { id: { time: '2026-11-12T15:04:00.000Z' }, events: [{ name: 'delivery', parameters: [
        { name: 'event_info', messageValue: { parameter: [{ name: 'mail_event_type', intValue: '15' }] } },
        { name: 'message', messageValue: { parameter: [{ name: 'rfc2822_message_id', value: '<q1@vendor-mail.example>' }, { name: 'subject', value: 'Invoice' }] } }] }] };
    assert.equal(R.eventNames(ev, 'q1@vendor-mail.example'), true);
    assert.equal(R.eventNames(ev, '<q1@vendor-mail.example>'), true);
    assert.equal(R.eventNames(ev, 'q2@vendor-mail.example'), false);
    assert.equal(R.eventType(ev.events[0]), 15);
    assert.equal(R.eventHasMessageId(ev), true);
    assert.equal(R.eventHasMessageId({ events: [{ parameters: [{ name: 'event_info', messageValue: { parameter: [{ name: 'mail_event_type', intValue: '7' }] } }] }] }), false);
});

// A district with one list (Phishing Army) that adds fresh-phish.example on its second download.
function setup({ mode = 'enforce', recheck = true } = {}) {
    let now = Date.UTC(2026, 10, 10, 9);
    const listed = new Set(filler(i => `bad${i}.example`));
    const fetch = async (url) => {
        const u = new URL(url);
        if (u.host === 'phishing.army') return text([...listed].join('\n'));
        if (u.pathname.startsWith('/openphish/')) return text(filler(i => `https://p${i}.example/x`).join('\n'));
        if (u.pathname.startsWith('/0xDanielLopez/')) return text(filler(i => `2026-11-01 00:00:00,r,domain,rep${i}.example,#phishing,https://x.com/r/${i}`).join('\n'));
        if (u.pathname.startsWith('/hagezi/')) return text(filler(i => `hz${i}.example`).join('\n'));
        return text(filler(i => `s${i}@scam.example`).join('\n'));
    };
    const store = new MemoryStore();
    const feeds = createFeeds({ http: createHttp({ fetch }), store, engine: E, now: () => now, log: silent });
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `a@${ORG}`, FIRST_SEEN_LEARNING_DAYS: '0', MODE: mode, RECHECK: recheck ? 'true' : 'false', ALERT_EMAIL: `it@${ORG}` });
    const boxes = new Map();   // `${user}|${id}` → { raw, labels }
    const gmail = {
        modified: [], events: [],
        raw: async (user, id) => { const m = boxes.get(`${user}|${id}`); if (!m) throw Object.assign(new (require('../src/gmail/client').GoogleApiError)(404, 'gone', 'GET'), {}); return { id, threadId: `t-${id}`, labelIds: [...m.labels], historyId: '100', internalDate: m.at, raw: m.raw }; },
        labels: async (user, id) => [...boxes.get(`${user}|${id}`).labels],
        threadSize: async () => 1,
        labelId: async (u, name) => `L_${name}`,
        modify: async (user, id, add, remove) => { gmail.modified.push({ user, id, add, remove }); const m = boxes.get(`${user}|${id}`); for (const l of add) m.labels.add(l); for (const l of remove) m.labels.delete(l); return {}; },
        gmailEvents: async (admin, mailbox, q) => { gmail.events.push({ admin, mailbox, filters: q.filters }); return (gmail.logs[mailbox] || []).filter(e => !q.filters || q.filters === `event_info.mail_event_type==${e.type}`).map(e => e.ev); },
        logs: {}
    };
    const svc = new Service({ cfg, store, gmail, intel: { feeds }, now: () => now, log: silent });
    const deliver = async (user, id, raw, { opened = false } = {}) => {
        boxes.set(`${user}|${id}`, { raw, labels: new Set(['INBOX', ...(opened ? [] : ['UNREAD'])]), at: now });
        return svc.processMessage(user, id);
    };
    return { svc, store, feeds, gmail, boxes, listed, deliver, cfg, clock: { get: () => now, add: (ms) => { now += ms; } } };
}
const lure = (to, n = 1) => Buffer.from([`From: Payroll Center <notices@payroll-center.example>`, `To: ${to}`, 'Subject: Your November statement', `Message-ID: <st${n}@payroll-center.example>`,
    'Authentication-Results: mx.google.com; dkim=pass header.i=@payroll-center.example; spf=pass; dmarc=pass header.from=payroll-center.example',
    'Content-Type: text/html; charset=utf-8', '', '<p>Hello, your November statement is ready.</p><p><a href="https://login.fresh-phish.example/statement">View statement</a></p><p>Payroll Center</p>'].join('\r\n'));

test('a list adds a site after the email was delivered: every copy still in an Inbox is found, checked again and moved; the admins are alerted; opened is said', async () => {
    const t = setup();
    await t.feeds.sync();                                     // the lists' first download (nothing is "new")
    await t.store.setState('feedsAttemptedAt', t.clock.get());
    await t.store.setState('installedAt', t.clock.get() - 30 * DAY);
    const users = [`ana@${ORG}`, `ben@${ORG}`, `cy@${ORG}`];
    for (const [i, u] of users.entries()) await t.deliver(u, `m${i}`, lure(u, i), { opened: i === 0 });
    assert.equal(t.gmail.modified.length, 0, 'not known on arrival: left in the Inbox');
    assert.ok(users.every(u => (t.store.seenIds.get(`${u}|m${users.indexOf(u)}`).ix || []).includes(`d${R.hashOf('fresh-phish.example')}`)), 'the hashes kept with the checked marker');
    // A day later the list has the site; the hourly job downloads it, finds the copies and checks them.
    t.clock.add(21 * HOUR); t.listed.add('fresh-phish.example');
    const out = await t.svc.syncFeeds();
    assert.equal(out.feeds.find(f => f.id === 'phishingarmy').added, 1, 'the count only, not the entries');
    assert.deepEqual([out.recheck.found, out.rechecked.moved], [3, 3]);
    for (const [i, u] of users.entries()) {
        const r = await t.store.getRecord(`${u}|m${i}`);
        assert.equal(r.state, 'moved');
        assert.equal(r.recheck.outcome, 'moved');
        assert.equal(r.recheck.before, 'none');
        assert.equal(r.recheck.list, E.PHISH_FEEDS.find(f => f.id === 'phishingarmy').name);
        assert.equal(r.recheck.site, 'fresh-phish.example');
        assert.equal(r.recheck.opened, i === 0);
        assert.equal(r.arrival.action, 'none');
        assert.ok(r.receivedAt < r.recheck.at);
        assert.match(r.why, /^found on a re-check \(Phishing Army.* listed fresh-phish\.example after it was delivered\)/);
        assert.ok(t.boxes.get(`${u}|m${i}`).labels.has('SPAM') && !t.boxes.get(`${u}|m${i}`).labels.has('INBOX'));
    }
    const alert = (await t.store.listEvents(0)).find(e => e.kind === 'recheck' && e.alert);
    assert.ok(alert, 'an alert, emailed');
    assert.match(alert.text, /3 emails delivered earlier are now found to be phishing \(Phishing Army.* listed fresh-phish\.example\).*3 moved to Spam.*1 had been opened.*Email → Re-checked/);
    assert.deepEqual(await t.store.getState('recheckQueue'), []);
    // Done once: the next run finds nothing more to do.
    t.clock.add(HOUR);
    const again = await t.svc.syncFeeds();
    assert.ok(!again.rechecked);
});

test('monitor mode: recorded as "would move", left in the Inbox; an email no longer in the Inbox isn\'t moved; mail older than RECHECK_DAYS isn\'t looked for', async () => {
    const t = setup({ mode: 'monitor' });
    await t.feeds.sync();
    await t.store.setState('feedsAttemptedAt', t.clock.get());
    await t.store.setState('installedAt', t.clock.get() - 30 * DAY);
    await t.deliver(`old@${ORG}`, 'o1', lure(`old@${ORG}`, 9));
    t.clock.add(8 * DAY);
    await t.store.setState('feedsAttemptedAt', t.clock.get());
    await t.deliver(`ana@${ORG}`, 'm1', lure(`ana@${ORG}`, 1));
    await t.deliver(`ben@${ORG}`, 'm2', lure(`ben@${ORG}`, 2));
    t.boxes.get(`ben@${ORG}|m2`).labels.delete('INBOX');          // ben archived it
    t.clock.add(21 * HOUR); t.listed.add('fresh-phish.example');
    const out = await t.svc.syncFeeds();
    assert.equal(out.recheck.found, 2, 'the 9-day-old email isn\'t looked for');
    const a = await t.store.getRecord(`ana@${ORG}|m1`), b = await t.store.getRecord(`ben@${ORG}|m2`);
    assert.deepEqual([a.action, a.state, a.recheck.outcome], ['would-move', 'inbox', 'would-move']);
    assert.deepEqual([b.action, b.state, b.recheck.outcome, b.recheck.where], ['flag', 'inbox', 'not-in-inbox', 'archived']);
    assert.match(b.why, /already left the Inbox \(archived by its reader\)/);
    assert.equal(t.gmail.modified.filter(m => m.add.includes('SPAM')).length, 0);
    assert.equal(await t.store.getRecord(`old@${ORG}|o1`), null);
});

test('off (RECHECK=false): no hashes kept, nothing re-checked', async () => {
    const t = setup({ recheck: false });
    await t.feeds.sync();
    await t.store.setState('feedsAttemptedAt', t.clock.get());
    await t.deliver(`ana@${ORG}`, 'm1', lure(`ana@${ORG}`, 1));
    assert.equal(t.store.seenIds.get(`ana@${ORG}|m1`).ix, undefined);
    t.clock.add(21 * HOUR); t.listed.add('fresh-phish.example');
    const out = await t.svc.syncFeeds();
    assert.ok(!out.recheck && !out.rechecked);
});

test('an admin\'s decision stands: a released email or one marked a false alarm isn\'t moved by a re-check', async () => {
    const t = setup();
    await t.feeds.sync();
    await t.store.setState('feedsAttemptedAt', t.clock.get());
    await t.deliver(`ana@${ORG}`, 'm1', lure(`ana@${ORG}`, 1));
    // (made so: a record of the email, marked a false alarm by an admin)
    const rec = { key: `ana@${ORG}|m1`, user: `ana@${ORG}`, messageId: 'm1', processedAt: t.clock.get(), receivedAt: t.clock.get(), action: 'flag', state: 'inbox', falseAlarm: true, sender: { address: 'notices@payroll-center.example', domain: 'payroll-center.example' }, signals: [] };
    await t.store.saveRecord(rec);
    t.clock.add(21 * HOUR); t.listed.add('fresh-phish.example');
    await t.svc.syncFeeds();
    assert.equal((await t.store.getRecord(rec.key)).state, 'inbox');
    assert.equal(t.gmail.modified.length, 0);
});

test('Link clicks (off by default): Gmail\'s logs say who opened it and who clicked a link; a click is an alert', async () => {
    const t = setup();
    await t.feeds.sync();
    await t.store.setState('feedsAttemptedAt', t.clock.get());
    await t.store.setState('installedAt', t.clock.get() - 30 * DAY);
    await t.deliver(`ana@${ORG}`, 'm1', lure(`ana@${ORG}`, 1), { opened: true });
    await t.deliver(`ben@${ORG}`, 'm2', lure(`ben@${ORG}`, 2));
    const at = new Date(t.clock.get() + 20 * 60 * 1000).toISOString();
    const ev = (type, id) => ({ type, ev: { id: { time: at }, events: [{ name: 'delivery', parameters: [{ name: 'event_info', messageValue: { parameter: [{ name: 'mail_event_type', intValue: String(type) }] } }, { name: 'message', messageValue: { parameter: [{ name: 'rfc2822_message_id', value: id }] } }] }] } });
    t.gmail.logs[`ana@${ORG}`] = [ev(7, '<st1@payroll-center.example>'), ev(15, '<st1@payroll-center.example>'), ev(15, '<other@elsewhere.example>')];
    t.gmail.logs[`ben@${ORG}`] = [ev(15, '<other@elsewhere.example>')];
    assert.deepEqual(await t.svc.clickLogs(), { on: false, admin: '' });
    t.clock.add(21 * HOUR); t.listed.add('fresh-phish.example');
    let out = await t.svc.syncFeeds();
    assert.ok(!out.clicks, 'off: Gmail\'s logs not read');
    assert.equal(t.gmail.events.length, 0);
    assert.equal((await t.svc.setClickLogs(true, 'someone@elsewhere.example', `it@${ORG}`)).status, 400);
    await t.svc.setClickLogs(true, `it@${ORG}`, `it@${ORG}`);
    assert.ok((await t.store.listEvents(0)).some(e => e.admin && /turned on Link clicks \(Gmail's logs read as it@maple-schools\.example\)/.test(e.text)));
    t.clock.add(HOUR);
    out = await t.svc.syncFeeds();
    assert.deepEqual([out.clicks.checked, out.clicks.clicked], [2, 1]);
    assert.ok(t.gmail.events.every(e => e.admin === `it@${ORG}` && /^event_info\.mail_event_type==(15|16|7)$/.test(e.filters)));
    const a = (await t.store.getRecord(`ana@${ORG}|m1`)).recheck.clicks, b = (await t.store.getRecord(`ben@${ORG}|m2`)).recheck.clicks;
    assert.deepEqual([a.clicked, a.opened, a.clickedAt, a.named], [true, true, Date.parse(at), true]);
    assert.deepEqual([b.clicked, b.opened, b.named], [false, false, false], 'another email\'s click isn\'t this one\'s');
    const alert = (await t.store.listEvents(0)).find(e => e.kind === 'recheck-click');
    assert.ok(alert && alert.alert);
    assert.match(alert.text, /ana@maple-schools\.example \(an email from notices@payroll-center\.example, at .* UTC\).*resetting it/);
    // Looked at again later (Google's logs can be late), not every hour; never again once a click is found.
    const n = t.gmail.events.length;
    t.clock.add(HOUR); await t.svc.syncFeeds();
    assert.equal(t.gmail.events.length, n, 'within 3 hours: not again');
    t.clock.add(3 * HOUR); await t.svc.syncFeeds();
    assert.deepEqual(t.gmail.events.slice(n).map(e => e.mailbox), [`ben@${ORG}`, `ben@${ORG}`, `ben@${ORG}`]);
    // The test: the admin's own log for the last day.
    t.gmail.logs[`it@${ORG}`] = [ev(7, '<x1@elsewhere.example>')];
    const tested = await t.svc.testClickLogs('', `it@${ORG}`);
    assert.deepEqual([tested.ok, tested.events, tested.named], [true, 1, 1]);
});

test('suspicious mail is checked again an hour and a day after it arrived', async () => {
    const t = setup();
    await t.feeds.sync();
    await t.store.setState('feedsAttemptedAt', t.clock.get());
    const rec = { key: `ana@${ORG}|m1`, user: `ana@${ORG}`, messageId: 'm1', processedAt: t.clock.get(), receivedAt: t.clock.get(), action: 'flag', state: 'inbox', falseAlarm: null, sender: { address: 'notices@payroll-center.example', domain: 'payroll-center.example' }, signals: [], score: 3 };
    t.boxes.set(rec.key, { raw: lure(rec.user, 1), labels: new Set(['INBOX']), at: t.clock.get() });
    await t.store.saveRecord(rec);
    t.clock.add(30 * 60 * 1000); await t.svc.syncFeeds();
    assert.equal((await t.store.getRecord(rec.key)).laterChecks, undefined, 'not yet an hour old');
    t.clock.add(HOUR); await t.svc.syncFeeds();
    assert.equal((await t.store.getRecord(rec.key)).laterChecks, 1, 'checked again: nothing new');
    t.clock.add(HOUR); await t.svc.syncFeeds();
    assert.equal((await t.store.getRecord(rec.key)).laterChecks, 1, 'not every hour');
    // By the next day the site is on a list (in this instance's copy): the second look moves it.
    t.listed.add('fresh-phish.example');
    await t.feeds.sync({ force: true });
    await t.store.setState('recheckQueue', []);
    t.clock.add(22 * HOUR); await t.svc.syncFeeds();
    const r = await t.store.getRecord(rec.key);
    assert.deepEqual([r.state, r.recheck.outcome, r.recheck.source, r.recheck.round, r.laterChecks], ['moved', 'moved', 'later', 2, 2]);
    assert.match(r.why, /checked again a day after it arrived/);
});

test('0.5.39: Link clicks\' Test explains Google\'s refusal: the Reports privilege missing, or the scope', async () => {
    const t = setup();
    const { GoogleApiError } = require('../src/gmail/client');
    t.gmail.gmailEvents = async () => { throw new GoogleApiError(401, '{ "error": { "code": 401, "message": "Access denied. You are not authorized to read activity records." } }', `GET /spruce-directory%40${ORG}/applications/gmail`); };
    let r = await t.svc.testClickLogs(`spruce-directory@${ORG}`, `it@${ORG}`);
    assert.equal(r.ok, false);
    assert.match(r.why, /spruce-directory@maple-schools\.example isn't allowed to read Google's activity reports: its admin role doesn't have the Reports privilege/);
    assert.match(r.fix, /Admin roles → the role .* \(the directory admin's is "SPRUCE group reader"\) → Privileges → Admin console privileges → tick Reports/);
    assert.equal((await t.store.getState('clickLogsTest')).why, r.why);
    t.gmail.gmailEvents = async () => { throw new Error(`token for spruce-directory@${ORG}: HTTP 401 {"error":"unauthorized_client"} (is domain-wide delegation set up for https://www.googleapis.com/auth/admin.reports.audit.readonly?)`); };
    r = await t.svc.testClickLogs(`spruce-directory@${ORG}`, `it@${ORG}`);
    assert.match(r.why, /scope admin\.reports\.audit\.readonly isn't on its domain-wide delegation entry/);
    assert.match(r.fix, /Manage Domain Wide Delegation .* add https:\/\/www\.googleapis\.com\/auth\/admin\.reports\.audit\.readonly/);
    // The hourly look says the same in its alert.
    await t.svc.setClickLogs(true, `spruce-directory@${ORG}`, `it@${ORG}`);
    await t.store.saveRecord({ key: `ana@${ORG}|m1`, user: `ana@${ORG}`, messageId: 'm1', rfc822MessageId: 'x@y.example', processedAt: t.clock.get(), receivedAt: t.clock.get(), action: 'move', state: 'moved', sender: { address: 'a@b.example' }, recheck: { at: t.clock.get(), outcome: 'moved' } });
    t.gmail.gmailEvents = async () => { throw new GoogleApiError(401, 'Access denied. You are not authorized to read activity records.', 'GET /x'); };
    await t.svc.followClicks();
    const alert = (await t.store.listEvents(0)).find(e => e.kind === 'click-logs');
    assert.match(alert.text, /isn't allowed to read Google's activity reports.*tick Reports/);
});
