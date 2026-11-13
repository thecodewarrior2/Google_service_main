'use strict';
// The brakes for a whole district (0.3.0): strong evidence is never held, weak evidence is held per
// campaign, the domain-wide brake is a last resort with an exact count, and held mail can be moved
// later. Also: an admin's campaign decisions, mail the user moved into the Inbox, catching up after a
// gap, and the health check. Every address is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { Service, campaignOf } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { GoogleApiError } = require('../src/gmail/client');

const ORG = 'maple-schools.example';
const PHISH = fs.readFileSync(path.join(__dirname, 'fixtures', 'phish-storage.eml'));   // rules + DMARC fail: strong
const DAY = 24 * 60 * 60 * 1000;
// A plain email the AI scores a little: with a tiny threshold, an AI-only (weak) move.
const plain = (from, subject) => Buffer.from([`From: "Sender" <${from}>`, `To: someone@${ORG}`, `Subject: ${subject}`, 'Message-ID: <p@x.example>',
    'Authentication-Results: mx.google.com; dmarc=pass (p=NONE) header.from=' + from.split('@')[1], 'Content-Type: text/plain', '', 'The weekly bulletin is attached for your review.'].join('\r\n'));

// A fake Gmail with mailboxes of messages: { user: { id: { raw, labels } } }.
function fakeGmail(boxes) {
    const g = { modified: [], searches: [] };
    const box = (u) => boxes[u] || (boxes[u] = {});
    Object.assign(g, {
        addedSince: async () => ({ ids: [], historyId: '1' }),
        profile: async () => ({ historyId: '999' }),
        raw: async (user, id) => { const m = box(user)[id]; if (!m) throw new GoogleApiError(404, 'gone', 'get'); return { id, threadId: `t${id}`, labelIds: m.labels || ['INBOX'], historyId: null, internalDate: m.at || Date.now(), raw: m.raw }; },
        labels: async (user, id) => { const m = box(user)[id]; if (!m) throw new GoogleApiError(404, 'gone', 'get'); return m.labels || ['INBOX']; },
        labelId: async (u, name) => `L_${name}`,
        modify: async (user, id, add, remove) => { g.modified.push({ user, id, add, remove }); const m = box(user)[id]; if (m) m.labels = (m.labels || ['INBOX']).filter(l => !remove.includes(l)).concat(add); return {}; },
        search: async (user, q) => { g.searches.push({ user, q }); return { ids: Object.keys(box(user)).filter(id => (box(user)[id].labels || ['INBOX']).includes('INBOX')), next: null }; },
        headers: async (user, id) => { const m = box(user)[id]; return { id, threadId: `t${id}`, labelIds: m.labels || ['INBOX'], internalDate: Date.now(), from: m.from, subject: m.subject }; }
    });
    return g;
}
const users = (n) => Array.from({ length: n }, (_, i) => `staff${i}@${ORG}`);
async function setup(env, boxes = {}, watched = []) {
    const store = new MemoryStore();
    const gmail = fakeGmail(boxes);
    const alerts = [];
    const cfg = loadConfig(Object.assign({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: watched.join(';'), FIRST_SEEN_LEARNING_DAYS: '0', MODE: 'enforce' }, env));
    const svc = new Service({ cfg, store, gmail, log: { error() {}, warn: (line) => alerts.push(JSON.parse(line)) }, waitForOthersMs: 50 });
    await store.setState('installedAt', Date.now() - 30 * DAY);
    for (const u of watched) await store.putUser(u, { watched: true, historyId: '1' });
    return { store, gmail, svc, alerts, cfg };
}
// Each mailbox gets one copy of the same email, and is notified.
async function deliver(svc, gmail, list, raw, id = 'm1') {
    for (const u of list) {
        gmail.addedSince = async () => ({ ids: [id], historyId: '2' });
        await svc.handleNotification({ emailAddress: u, historyId: '2' });
    }
}
const boxesWith = (list, raw, id = 'm1') => Object.fromEntries(list.map(u => [u, { [id]: { raw } }]));

test('a clear phishing campaign (strong evidence) is moved for every mailbox: the campaign hold never applies', async () => {
    const list = users(40);
    const { store, gmail, svc } = await setup({ CAMPAIGN_HOLD_AFTER: '5', BRAKE_PER_HOUR: '1000' }, boxesWith(list, PHISH), list);
    await deliver(svc, gmail, list, PHISH);
    assert.equal(gmail.modified.length, 40, 'all 40 moved');
    const recs = await store.listRecords({});
    assert.ok(recs.every(r => r.evidence === 'strong' && r.held === null && r.action === 'move'));
    assert.ok(recs[0].confirmedBy.includes("Gmail's DMARC check failed"));
});

test('weak evidence: the copies of one campaign beyond CAMPAIGN_HOLD_AFTER are held, with one alert; confirming moves them and later copies', async () => {
    const list = users(12);
    const raw = plain('news@bulletins.example', 'Weekly bulletin');
    const boxes = boxesWith(list.slice(0, 10), raw);
    const { store, gmail, svc, alerts } = await setup({ CAMPAIGN_HOLD_AFTER: '5', AI_MOVE_THRESHOLD: '0.0001', BRAKE_PER_HOUR: '1000' }, boxes, list);
    await deliver(svc, gmail, list.slice(0, 10), raw);
    assert.equal(gmail.modified.length, 5, 'five moved, then held');
    const recs = await store.listRecords({});
    const held = recs.filter(r => r.held === 'campaign');
    assert.equal(held.length, 5); assert.ok(held.every(r => r.action === 'would-move' && r.state === 'inbox' && r.evidence === 'weak'));
    assert.match(held[0].why, /moving this campaign is paused after 5 copies/);
    assert.equal(alerts.filter(a => a.spruceAlert === 'campaign-held').length, 1, 'one alert, not one per copy');
    const key = recs[0].campaign;
    assert.equal((await store.getCampaign(key)).weakMoves, 5);
    // The admin confirms: the held copies still in the Inbox are moved, every copy is marked phishing.
    const labels = gmail.labels;
    gmail.labels = async (u, id) => (u === held[0].user ? [] : labels(u, id));   // one was deleted or moved by its user meanwhile
    const out = await svc.confirmCampaign(key, 'it.admin@' + ORG);
    assert.deepEqual([out.moved.moved, out.moved.gone], [4, 1]);
    assert.equal(gmail.modified.length, 9);
    const after = await store.listRecords({});
    assert.ok(after.every(r => r.falseAlarm === false && r.markedBy === 'it.admin@' + ORG));
    assert.match(after.find(r => r.held === null && r.heldMovedBy).why, /moved when it\.admin@maple-schools\.example confirmed the campaign as phishing/);
    // Later copies are moved without being held.
    gmail.labels = labels;
    for (const u of list.slice(10)) boxes[u] = { m1: { raw } };
    await deliver(svc, gmail, list.slice(10), raw);
    assert.equal(gmail.modified.length, 11);
});

test('releasing a campaign as a false alarm: every moved copy back in the Inbox, later copies not moved', async () => {
    const list = users(4);
    const raw = plain('news@bulletins.example', 'Weekly bulletin');
    const { store, gmail, svc } = await setup({ AI_MOVE_THRESHOLD: '0.0001' }, boxesWith(list, raw), list);
    await deliver(svc, gmail, list.slice(0, 3), raw);
    assert.equal(gmail.modified.length, 3);
    const key = (await store.listRecords({}))[0].campaign;
    const out = await svc.releaseCampaign(key, 'it.admin@' + ORG);
    assert.equal(out.released, 3);
    assert.ok((await store.listRecords({})).every(r => r.state === 'released' && r.falseAlarm === true));
    await deliver(svc, gmail, list.slice(3), raw);
    const last = await store.getRecord(`${list[3]}|m1`);
    assert.equal(last.action, 'flag'); assert.match(last.why, /an admin dismissed this campaign as a false alarm/);
    assert.equal(gmail.modified.filter(m => m.add.includes('SPAM')).length, 3, 'never moved again');
    assert.ok((await store.listEvents()).some(e => e.kind === 'campaign' && /dismissed "/.test(e.text)));
});

test('the domain-wide brake: half the watched mailboxes (at least 100) by default, exact even when moves run at once; resuming can move the held mail', async () => {
    const svcOnly = await setup({});
    await svcOnly.store.setState('watchedCount', 7000);
    assert.equal(await svcOnly.svc.brakeLimit(), 3500, '7,000 mailboxes: 3,500 an hour');
    await svcOnly.store.setState('watchedCount', 40);
    assert.equal(await svcOnly.svc.brakeLimit(), 100, 'never under 100');
    // Strong copies to 12 mailboxes with a limit of 8, judged all at once: exactly 8 moved.
    const list = users(12);
    const { store, gmail, svc, alerts } = await setup({ BRAKE_PER_HOUR: '8' }, boxesWith(list, PHISH), list);
    gmail.addedSince = async () => ({ ids: ['m1'], historyId: '3' });
    await Promise.all(list.map(u => svc.handleNotification({ emailAddress: u, historyId: '3' })));
    assert.equal(gmail.modified.length, 8, 'exactly the limit, though they ran at the same time');
    const b = await store.getState('brake');
    assert.ok(b && b.limit === 8);
    assert.equal(alerts.filter(a => a.spruceAlert === 'brake').length, 1);
    const held = (await store.listRecords({})).filter(r => r.held === 'brake');
    assert.equal(held.length, 4);
    const out = await svc.resume('it.admin@' + ORG, { moveHeld: true });
    assert.equal(out.held.moved, 4);
    assert.equal(gmail.modified.length, 12);
    assert.equal(await store.getState('brake'), null);
    assert.match((await store.listEvents()).find(e => e.kind === 'resume').text, /4 emails left in the Inbox while the brake was on were moved to Spam/);
});

test('resuming without moving leaves the held mail in the Inbox; monitor mode never moves held or confirmed mail', async () => {
    const list = users(3);
    const { store, gmail, svc } = await setup({ BRAKE_PER_HOUR: '1' }, boxesWith(list, PHISH), list);
    gmail.addedSince = async () => ({ ids: ['m1'], historyId: '2' });
    for (const u of list) await svc.handleNotification({ emailAddress: u, historyId: '2' });
    assert.equal(gmail.modified.length, 1);
    await svc.resume('it.admin@' + ORG, { moveHeld: false });
    assert.equal(gmail.modified.length, 1);
    assert.equal((await store.listRecords({})).filter(r => r.held === 'brake' && r.state === 'inbox').length, 2);
    // Monitor mode: confirming a campaign marks it, moves nothing.
    const mon = await setup({ MODE: 'monitor' }, boxesWith(list, PHISH), list);
    mon.gmail.addedSince = async () => ({ ids: ['m1'], historyId: '2' });
    for (const u of list) await mon.svc.handleNotification({ emailAddress: u, historyId: '2' });
    const key = (await mon.store.listRecords({}))[0].campaign;
    const out = await mon.svc.confirmCampaign(key, 'it.admin@' + ORG);
    assert.equal(out.moved.monitor, true);
    assert.equal(mon.gmail.modified.length, 0);
});

test('finding copies the service didn\'t record: same sender domain and subject, moved once the campaign is confirmed', async () => {
    const list = users(3);
    const raw = plain('billing@invoices.example', 'Invoice 4471 overdue');
    const boxes = { [list[0]]: { m1: { raw } } };
    const { store, gmail, svc } = await setup({ AI_MOVE_THRESHOLD: '0.0001' }, boxes, list);
    gmail.addedSince = async () => ({ ids: ['m1'], historyId: '2' });
    await svc.handleNotification({ emailAddress: list[0], historyId: '2' });
    const key = (await store.listRecords({}))[0].campaign;
    // Copies that came before the pilot, or were judged clean: one matching, one other email from the sender.
    boxes[list[1]] = { c1: { from: 'Billing <billing@invoices.example>', subject: 'Invoice 9920 overdue' }, c2: { from: 'billing@invoices.example', subject: 'Your receipt' } };
    boxes[list[2]] = { c3: { from: 'billing@invoices.example', subject: 'Invoice 1234 overdue', labels: ['SPAM'] } };
    assert.equal(campaignOf('invoices.example', 'Invoice 9920 overdue', list[1]).key, key);
    const out = await svc.confirmCampaign(key, 'it.admin@' + ORG, { search: true });
    assert.equal(out.found.searched, 3); assert.equal(out.found.found, 1); assert.equal(out.found.moved, 1);
    assert.match(gmail.searches[0].q, /^in:inbox newer_than:7d from:\(billing@invoices\.example\)$/);
    const copy = await store.getRecord(`${list[1]}|c1`);
    assert.equal(copy.trigger, 'admin'); assert.equal(copy.state, 'moved'); assert.equal(copy.evidence, 'admin');
    assert.ok(gmail.modified.some(m => m.id === 'c1') && !gmail.modified.some(m => m.id === 'c2' || m.id === 'c3'));
});

test('an email the user moved into the Inbox that the service never checked: checked, never moved, an alert when flagged', async () => {
    const u = `reader@${ORG}`;
    const boxes = { [u]: { s1: { raw: PHISH, at: Date.now() - DAY }, old: { raw: PHISH, at: Date.now() - 30 * DAY } } };
    const { store, gmail, svc, alerts } = await setup({}, boxes, [u]);
    gmail.addedSince = async () => ({ ids: [], inboxed: ['s1', 'old'], inboxedAt: { s1: '5', old: '6' }, historyId: '2' });
    await svc.handleNotification({ emailAddress: u, historyId: '2' });
    const rec = await store.getRecord(`${u}|s1`);
    assert.equal(rec.action, 'flag'); assert.equal(rec.userPlaced, true); assert.match(rec.why, /the user moved it into the Inbox themselves/);
    assert.equal(gmail.modified.length, 0, 'never moved');
    assert.equal(await store.getRecord(`${u}|old`), null, 'older than 7 days: left alone');
    assert.equal(alerts.filter(a => a.spruceAlert === 'user-inbox').length, 1);
    // Seen again: nothing twice.
    await svc.handleNotification({ emailAddress: u, historyId: '2' });
    assert.equal(alerts.filter(a => a.spruceAlert === 'user-inbox').length, 1);
});

test('after a gap in the history, the Inbox mail since the last notification is checked, a batch with each later notification', async () => {
    const u = `reader@${ORG}`;
    const boxes = { [u]: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`g${i}`, { raw: PHISH }])) };
    const { store, gmail, svc } = await setup({}, boxes, [u]);
    const last = Date.now() - 3 * DAY;
    await store.putUser(u, { lastNotification: last });
    gmail.addedSince = async () => { throw new GoogleApiError(404, 'too old', 'history'); };
    assert.deepEqual(await svc.handleNotification({ emailAddress: u, historyId: '5' }), { resynced: true });
    const b = (await store.getUser(u)).backfill;
    assert.equal(b.after, last);
    assert.match((await store.listEvents()).find(e => e.kind === 'gap').text, /^The service fell behind on .*: Gmail no longer had the list of what changed there .* the mail still in the Inbox since .* is being checked too/);
    assert.equal((await store.listEvents()).find(e => e.kind === 'gap').missed, true, '0.5.31: counted toward the gap alerts');
    // Pages of 25 from the search, then done.
    const ids = Object.keys(boxes[u]);
    let call = 0;
    gmail.search = async (user, q, opts) => { assert.equal(q, `in:inbox after:${Math.floor(last / 1000)}`); call++; return opts.pageToken ? { ids: ids.slice(25), next: null } : { ids: ids.slice(0, 25), next: 'p2' }; };
    gmail.addedSince = async () => ({ ids: [], historyId: '1000' });
    await svc.handleNotification({ emailAddress: u, historyId: '1000' });
    assert.equal((await store.getUser(u)).backfill.checked, 25);
    await svc.handleNotification({ emailAddress: u, historyId: '1000' });
    assert.equal((await store.getUser(u)).backfill, null);
    assert.equal(call, 2);
    assert.equal(gmail.modified.length, 30, 'every email in the gap was checked (and moved: they are phishing)');
    assert.match((await store.listEvents()).find(e => /Caught up/.test(e.text)).text, /30 emails checked/);
});

test('the hourly health check: alerts once a day when Gmail has gone quiet, or watches are about to end', async () => {
    const list = users(3);
    const { store, svc, alerts, cfg } = await setup({ QUIET_HOURS: '12' }, {}, list);
    let now = Date.now();
    svc.now = () => now;
    for (const u of list) await store.putUser(u, { lastNotification: now - 2 * 3600 * 1000, watchExpiration: now + 5 * DAY });
    assert.equal((await svc.health()).quiet, undefined);
    now += 13 * 3600 * 1000;
    const h = await svc.health();
    assert.equal(h.quiet, true);
    await svc.health();
    assert.equal(alerts.filter(a => a.spruceAlert === 'quiet').length, 1, 'once a day');
    assert.match(alerts.find(a => a.spruceAlert === 'quiet').message, /No notification from Gmail for 15 hours, for any of the 3 watched mailboxes/);
    now += 5 * DAY;
    await svc.health();
    assert.equal(alerts.filter(a => a.spruceAlert === 'watch-expiring').length, 1);
    assert.equal(cfg.quietHours, 12);
    // The phishing lists: tried at most once a day (the hourly job runs the health check each time).
    svc.intel = { feeds: { sync: async () => ({ feeds: ['downloaded'] }), status: async () => [] } };
    assert.deepEqual((await svc.syncFeeds()).feeds, ['downloaded']);
    assert.equal((await svc.syncFeeds()).skipped, 'checked within the day');
});
