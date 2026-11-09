'use strict';
// The pipeline with a fake Gmail and the in-memory store: notifications, decisions, moves, release,
// the brake, watches, retention. Every address is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadConfig, configProblems } = require('../src/config');
const { decide } = require('../src/policy');
const { Service, campaignOf } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { GoogleApiError } = require('../src/gmail/client');

const USER = 'reader@maple-schools.example';
const PHISH = fs.readFileSync(path.join(__dirname, 'fixtures', 'phish-storage.eml'));
const GENUINE = fs.readFileSync(path.join(__dirname, 'fixtures', 'genuine-newsletter.eml'));
const DAY = 24 * 60 * 60 * 1000;

function fakeGmail(messages) {
    const g = { modified: [], watched: [], stopped: [], history: { ids: [], historyId: '200' }, ouUsers: [], groups: {} };
    Object.assign(g, {
        addedSince: async () => g.history,
        profile: async () => ({ historyId: '999' }),
        raw: async (user, id) => { const m = messages[id]; if (!m) throw new GoogleApiError(404, 'gone', 'get'); return { id, threadId: `t${id}`, labelIds: m.labels || ['INBOX', 'UNREAD'], historyId: m.historyId || null, internalDate: 1, raw: m.raw }; },
        labelId: async (u, name) => `L_${name}`,
        modify: async (user, id, add, remove) => { g.modified.push({ user, id, add, remove }); return {}; },
        watch: async (user) => { g.watched.push(user); return { historyId: '100', expiration: String(Date.now() + 7 * DAY) }; },
        stop: async (user) => { g.stopped.push(user); },
        usersInOu: async () => g.ouUsers,
        groupMembers: async (admin, group) => { if (!g.groups[group]) throw new GoogleApiError(404, 'no such group', 'members'); return g.groups[group]; }
    });
    return g;
}
const cfgOf = (env = {}) => loadConfig(Object.assign({ STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', PILOT_USERS: USER, FIRST_SEEN_LEARNING_DAYS: '0' }, env));
async function setup(env, messages = { m1: { raw: PHISH }, m2: { raw: GENUINE } }) {
    const store = new MemoryStore();
    const gmail = fakeGmail(messages);
    const svc = new Service({ cfg: cfgOf(env), store, gmail, log: { error() {} } });
    await store.setState('installedAt', Date.now() - 30 * DAY);
    return { store, gmail, svc };
}

test('policy: rules or the AI move in enforce mode; monitor records; the AI alone never moves inside mail; allowlisted never', () => {
    const enforce = cfgOf({ MODE: 'enforce' }), monitor = cfgOf({});
    const r = (status, p, inside = false, score = 6) => ({ status, score, inside, ai: { probability: p } });
    assert.deepEqual([decide(r('flagged', 0.1), enforce).action, decide(r('flagged', 0.1), enforce).trigger], ['move', 'rules']);
    assert.deepEqual([decide(r('clean', 0.9), enforce).action, decide(r('clean', 0.9), enforce).trigger], ['move', 'ai']);
    assert.equal(decide(r('flagged', 0.99), enforce).trigger, 'rules+ai');
    assert.equal(decide(r('clean', 0.84), enforce).action, 'flag', 'below 85%: recorded as suspicious only');
    assert.equal(decide(r('clean', 0.2), enforce).action, 'none');
    assert.equal(decide(r('caution', 0.2, false, 3), enforce).action, 'flag');
    assert.equal(decide(r('clean', 0.99), monitor).action, 'would-move');
    assert.equal(decide(r('clean', 0.99, true), enforce).action, 'flag', 'the AI alone does not move inside mail');
    assert.equal(decide(r('flagged', 0.99, true), enforce).action, 'move', 'the rules still move it (a compromised staff account)');
    assert.equal(decide(r('clean', 0.99, true), cfgOf({ MODE: 'enforce', AI_MOVES_INSIDE: '1' })).action, 'move');
    assert.equal(decide(r('trusted', 0.99), enforce).action, 'none');
    assert.equal(decide(r('flagged', 0.99), enforce, { brake: true }).action, 'would-move', 'brake on');
    assert.equal(decide(r('clean', 0.9), cfgOf({ MODE: 'enforce', AI_MOVE_THRESHOLD: '0.95' })).action, 'flag', 'the threshold is a setting');
});

test('DMARC must pass: a forged allowlisted or staff address is judged like mail from outside', async () => {
    const { senderVerified } = require('../src/engine/analyze');
    const mail = (from, auth) => Buffer.from([`From: "Sender" <${from}>`, `To: ${USER}`, 'Subject: Staff meeting moved', 'Message-ID: <m@x.example>',
        ...(auth ? [`Authentication-Results: mx.google.com; ${auth}`] : []), 'Content-Type: text/plain', '', 'The staff meeting is moved to 3 pm in the library.'].join('\r\n'));
    const msgs = {
        allowOk: { raw: mail('billing@vendor.example', 'spf=pass; dmarc=pass (p=REJECT) header.from=vendor.example') },
        allowForged: { raw: mail('billing@vendor.example', 'spf=fail; dmarc=fail (p=NONE) header.from=vendor.example') },
        insideOk: { raw: mail('helpdesk@maple-schools.example', 'dkim=pass; dmarc=pass (p=REJECT) header.from=maple-schools.example') },
        insideForged: { raw: mail('helpdesk@maple-schools.example', 'dmarc=fail (p=NONE) header.from=maple-schools.example') },
        insideNoResult: { raw: mail('helpdesk@maple-schools.example', null) }
    };
    // Any AI score counts as high here, so only the exemptions decide.
    const { store, gmail, svc } = await setup({ MODE: 'enforce', ALLOW_DOMAINS: 'vendor.example', AI_MOVE_THRESHOLD: '0.0001' }, msgs);
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: Object.keys(msgs), historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    const rec = (id) => store.getRecord(`${USER}|${id}`);
    assert.equal(await rec('allowOk'), null, 'allowlisted with DMARC passing: nothing');
    const forged = await rec('allowForged');
    assert.equal(forged.action, 'move'); assert.match(forged.why, /allowlisted sender, but DMARC didn't pass/);
    assert.equal((await rec('insideOk')).action, 'flag', 'staff mail with DMARC passing: the AI alone never moves it');
    for (const id of ['insideForged', 'insideNoResult']) {
        const r = await rec(id);
        assert.equal(r.action, 'move', id); assert.match(r.trigger, /ai/); assert.match(r.why, /isn't treated as inside/);
    }
    assert.deepEqual(gmail.modified.map(m => m.id).sort(), ['allowForged', 'insideForged', 'insideNoResult']);
    // DMARC for another domain than the one in From doesn't count.
    assert.equal(senderVerified({ senderAddress: 'a@vendor.example', auth: { dmarc: 'pass', headerFrom: 'other.example' } }), false);
    assert.equal(senderVerified({ senderAddress: 'a@vendor.example', auth: { dmarc: 'pass', headerFrom: 'vendor.example' } }), true);
    assert.equal(senderVerified({ senderAddress: 'a@vendor.example', auth: null }), false);
});

test('a notification: first one only starts the history; then new Inbox messages are judged once, phishing moved, genuine left', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    assert.deepEqual(await svc.handleNotification({ emailAddress: USER, historyId: '100' }), { started: true });
    gmail.history = { ids: ['m1', 'm2'], historyId: '150' };
    const out = await svc.handleNotification({ emailAddress: USER, historyId: '150' });
    assert.equal(out.processed, 2);
    assert.deepEqual(gmail.modified, [{ user: USER, id: 'm1', add: ['SPAM', 'L_SPRUCE/Moved'], remove: ['INBOX'] }]);
    const rec = await store.getRecord(`${USER}|m1`);
    assert.equal(rec.action, 'move'); assert.equal(rec.state, 'moved'); assert.equal(rec.trigger, 'rules+ai');
    assert.equal(await store.getRecord(`${USER}|m2`), null, 'clean mail is counted, not recorded');
    assert.equal((await store.getUser(USER)).historyId, '150');
    // The same notification again does nothing twice.
    await svc.handleNotification({ emailAddress: USER, historyId: '150' });
    assert.equal(gmail.modified.length, 1);
    const stats = await store.getStats('2000-01-01', '2999-01-01');
    assert.equal(stats.reduce((a, s) => a + (s.scanned || 0), 0), 2);
});

test('monitor mode (the default) moves nothing and records what it would move', async () => {
    const { store, gmail, svc } = await setup({});
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: ['m1'], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal(gmail.modified.length, 0);
    const rec = await store.getRecord(`${USER}|m1`);
    assert.equal(rec.action, 'would-move'); assert.equal(rec.state, 'inbox'); assert.match(rec.why, /monitor mode/);
});

test('sent mail, drafts, mail already in Spam and mailboxes outside the pilot are left alone', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' }, { s: { raw: PHISH, labels: ['SENT'] }, d: { raw: PHISH, labels: ['DRAFT'] }, sp: { raw: PHISH, labels: ['SPAM'] } });
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: ['s', 'd', 'sp'], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal(gmail.modified.length, 0);
    assert.deepEqual(await svc.handleNotification({ emailAddress: 'someone.else@maple-schools.example', historyId: '5' }), { ignored: 'not watched' });
    assert.deepEqual(await svc.handleNotification({}), { ignored: 'malformed' });
});

test('a history id too old to use: start again from now, and say so', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    await store.putUser(USER, { historyId: '1' });
    gmail.addedSince = async () => { throw new GoogleApiError(404, 'too old', 'history'); };
    assert.deepEqual(await svc.handleNotification({ emailAddress: USER, historyId: '3' }), { resynced: true });
    assert.equal((await store.getUser(USER)).historyId, '999');
    assert.ok((await store.listEvents()).some(e => e.kind === 'gap'));
});

test('release puts a moved email back in the Inbox, records who did it and counts it as a false alarm', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: ['m1'], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    const out = await svc.release(`${USER}|m1`, 'it.admin@maple-schools.example');
    assert.equal(out.record.state, 'released'); assert.equal(out.record.releasedBy, 'it.admin@maple-schools.example'); assert.equal(out.record.falseAlarm, true);
    assert.deepEqual(gmail.modified[1], { user: USER, id: 'm1', add: ['INBOX', 'L_SPRUCE/Released'], remove: ['SPAM', 'L_SPRUCE/Moved'] });
    assert.match((await svc.release(`${USER}|m1`, 'x')).error, /already released/);
    assert.equal((await svc.release('nope', 'x')).error, 'not found');
    assert.equal((await svc.mark(`${USER}|m1`, false, 'it.admin@maple-schools.example')).record.falseAlarm, false);
});

test('a user who moves a moved email back to the Inbox: recorded as released by the user, once, with an alert', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: ['m1'], inboxed: [], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal((await store.getRecord(`${USER}|m1`)).state, 'moved');
    // The user drags it out of Spam; an unknown message and one the service never recorded are ignored.
    gmail.history = { ids: [], inboxed: ['m1', 'other', 'm2'], historyId: '3' };
    await svc.handleNotification({ emailAddress: USER, historyId: '3' });
    const rec = await store.getRecord(`${USER}|m1`);
    assert.equal(rec.state, 'released'); assert.equal(rec.releasedByUser, true); assert.equal(rec.releasedBy, USER); assert.equal(rec.falseAlarm, true);
    assert.equal(gmail.modified.length, 1, 'never moved again');
    const ev = (await store.listEvents()).find(e => e.kind === 'user-release');
    assert.match(ev.text, /back to the Inbox, though the checks flagged it/);
    // The same change seen again counts once; an admin can still mark it phishing.
    await svc.handleNotification({ emailAddress: USER, historyId: '3' });
    const stats = await store.getStats('2000-01-01', '2999-01-01');
    assert.equal(stats.reduce((a, s) => a + (s.userReleased || 0), 0), 1);
    assert.equal(stats.reduce((a, s) => a + (s.released || 0), 0), 1);
    assert.equal((await svc.release(`${USER}|m1`, 'it.admin@maple-schools.example')).error, 'it is already released');
    assert.equal((await svc.mark(`${USER}|m1`, false, 'it.admin@maple-schools.example')).record.falseAlarm, false);
});

test('the Inbox label from an admin\'s release, or on a message judged in the same batch, is not a user rescue', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    await store.putUser(USER, { historyId: '1' });
    // m1 arrives and is moved in the same batch that shows its first Inbox label.
    gmail.history = { ids: ['m1'], inboxed: ['m1'], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal((await store.getRecord(`${USER}|m1`)).state, 'moved');
    // An admin releases it; its notification comes in while the release is still being written.
    const modify = gmail.modify;
    gmail.modify = async (...a) => { await modify(...a); gmail.history = { ids: [], inboxed: ['m1'], historyId: '3' }; await svc.handleNotification({ emailAddress: USER, historyId: '3' }); return {}; };
    const out = await svc.release(`${USER}|m1`, 'it.admin@maple-schools.example');
    assert.equal(out.record.releasedByUser, false); assert.equal(out.record.releasedBy, 'it.admin@maple-schools.example');
    const stats = await store.getStats('2000-01-01', '2999-01-01');
    assert.equal(stats.reduce((a, s) => a + (s.userReleased || 0), 0), 0);
    assert.equal(stats.reduce((a, s) => a + (s.released || 0), 0), 1);
});

test('Gmail history: new Inbox messages and Inbox labels added back, asked for as repeated parameters', async () => {
    const { GmailClient } = require('../src/gmail/client');
    const urls = [];
    const fetch = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ historyId: '9', history: [
        { id: '6', messagesAdded: [{ message: { id: 'a' } }] },
        { id: '7', labelsAdded: [{ message: { id: 'b' }, labelIds: ['INBOX'] }, { message: { id: 'c' }, labelIds: ['STARRED'] }] }] }) }; };
    const c = new GmailClient({ tokenFor: async () => 'tok' }, { fetch });
    assert.deepEqual(await c.addedSince(USER, '5'), { ids: ['a'], inboxed: ['b'], inboxedAt: { b: '7' }, historyId: '9' });
    const q = new URL(urls[0]).searchParams;
    assert.deepEqual(q.getAll('historyTypes'), ['messageAdded', 'labelAdded']);
    assert.equal(q.get('labelId'), 'INBOX'); assert.equal(q.get('startHistoryId'), '5');
});

test('Gmail history past 4,000 messages: the rest is read next time, never skipped', async () => {
    const { GmailClient } = require('../src/gmail/client');
    // 10 pages of 500 new messages; the mailbox's newest history id is 99999.
    const fetch = async (url) => {
        const page = Number(new URL(url).searchParams.get('pageToken') || 0);
        const history = Array.from({ length: 500 }, (_, i) => ({ id: String(1000 + page * 500 + i), messagesAdded: [{ message: { id: `p${page}m${i}` } }] }));
        return { ok: true, status: 200, json: async () => Object.assign({ historyId: '99999', history }, page < 9 ? { nextPageToken: String(page + 1) } : {}) };
    };
    const c = new GmailClient({ tokenFor: async () => 'tok' }, { fetch });
    const out = await c.addedSince(USER, '999');
    assert.equal(out.ids.length, 4000);
    assert.equal(out.more, true);
    assert.equal(out.historyId, '4999', 'the last change read, not the newest: the next 1,000 are read next time');
});

test('Gmail asking to slow down (403 rate limit) is tried again; another 403 is not', async () => {
    const { GmailClient } = require('../src/gmail/client');
    let n = 0;
    const answers = [{ status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }, { status: 200, body: { id: 'm1' } }];
    const fetch = async () => { const a = answers[Math.min(n++, answers.length - 1)]; return { ok: a.status < 400, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) }; };
    const c = new GmailClient({ tokenFor: async () => 'tok' }, { fetch });
    assert.deepEqual(await c.modify(USER, 'm1', ['SPAM'], ['INBOX']), { id: 'm1' });
    assert.equal(n, 2);
    n = 0;
    const denied = new GmailClient({ tokenFor: async () => 'tok' }, { fetch: async () => { n++; return { ok: false, status: 403, json: async () => ({}), text: async () => '{"error":{"errors":[{"reason":"forbidden"}]}}' }; } });
    await assert.rejects(denied.modify(USER, 'm1', [], []), (e) => e.status === 403);
    assert.equal(n, 1);
});

test('a message whose check fails is tried again, and the mailbox\'s place is kept until then', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    await store.putUser(USER, { historyId: '1' });
    const modify = gmail.modify;
    let failures = 1;
    gmail.modify = async (...a) => { if (failures-- > 0) throw new GoogleApiError(403, 'forbidden', 'modify'); return modify(...a); };
    gmail.history = { ids: ['m1', 'm2'], historyId: '2' };
    const first = await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal(first.held, true);
    assert.equal(gmail.modified.length, 0);
    assert.equal((await store.getUser(USER)).historyId, '1', 'the place is kept, so m1 is listed again');
    assert.match((await store.listEvents()).find(e => e.kind === 'error').text, /try 1 of 3; it is tried again in a minute/);
    // The next change: m1 is moved and recorded; m2 (done the first time) isn't judged again.
    gmail.history = { ids: ['m1', 'm2'], historyId: '3' };
    const second = await svc.handleNotification({ emailAddress: USER, historyId: '3' });
    assert.equal(second.held, undefined);
    assert.equal(gmail.modified.length, 1);
    assert.equal((await store.getRecord(`${USER}|m1`)).state, 'moved');
    assert.equal((await store.getUser(USER)).historyId, '3');
    const stats = await store.getStats('2000-01-01', '2999-01-01');
    assert.equal(stats.reduce((a, s) => a + (s.scanned || 0), 0), 3, 'm1 twice (each try), m2 once');
    assert.equal(stats.reduce((a, s) => a + (s.moved || 0), 0), 1);
});

test('a message that keeps failing is left after 3 tries, so the mailbox moves on', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    await store.putUser(USER, { historyId: '1' });
    gmail.modify = async () => { throw new GoogleApiError(400, 'bad request', 'modify'); };
    for (const h of ['2', '3', '4']) { gmail.history = { ids: ['m1'], historyId: h }; await svc.handleNotification({ emailAddress: USER, historyId: h }); }
    assert.equal((await store.getUser(USER)).historyId, '4', 'given up on the third try: the place moves on');
    assert.ok((await store.listEvents()).some(e => /after 3 tries and was left where it is/.test(e.text)));
    gmail.history = { ids: ['m1'], historyId: '5' };
    await svc.handleNotification({ emailAddress: USER, historyId: '5' });
    assert.equal((await store.listEvents()).filter(e => e.kind === 'error').length, 3, 'not tried a fourth time');
});

test('moved, then the record failed: the next try writes the record without moving it again', async () => {
    const msgs = { m1: { raw: PHISH } };
    const { store, gmail, svc } = await setup({ MODE: 'enforce' }, msgs);
    await store.putUser(USER, { historyId: '1' });
    // Gmail's copy follows the move (the service's own label, out of the Inbox).
    const modify = gmail.modify;
    gmail.modify = async (u, id, add, remove) => { msgs[id].labels = add.concat(['UNREAD']); return modify(u, id, add, remove); };
    const save = store.saveRecord.bind(store);
    let failures = 1;
    store.saveRecord = async (rec) => { if (failures-- > 0) throw new Error('Firestore unavailable'); return save(rec); };
    gmail.history = { ids: ['m1'], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal(await store.getRecord(`${USER}|m1`), null);
    gmail.history = { ids: ['m1'], historyId: '3' };
    await svc.handleNotification({ emailAddress: USER, historyId: '3' });
    const rec = await store.getRecord(`${USER}|m1`);
    assert.equal(rec.state, 'moved'); assert.equal(rec.action, 'move'); assert.match(rec.why, /moved by an earlier try/);
    assert.equal(gmail.modified.length, 1, 'moved once');
    assert.equal((await svc.release(`${USER}|m1`, 'it.admin@maple-schools.example')).record.state, 'released', 'and it can be released');
});

test('two notifications at once: each message is judged once, and the mailbox\'s place never goes back', async () => {
    const msgs = { m1: { raw: PHISH }, m2: { raw: GENUINE } };
    const { store, gmail, svc } = await setup({ MODE: 'enforce' }, msgs);
    await store.putUser(USER, { historyId: '100' });
    const raw = gmail.raw;
    gmail.raw = async (...a) => { await new Promise(r => setTimeout(r, 20)); return raw(...a); };
    gmail.addedSince = async (u, from) => ({ ids: ['m1', 'm2'], historyId: from === '100' ? '210' : '205' });
    const [a, b] = await Promise.all([svc.handleNotification({ emailAddress: USER, historyId: '210' }), svc.handleNotification({ emailAddress: USER, historyId: '205' })]);
    assert.equal(gmail.modified.length, 1, 'moved once');
    const stats = await store.getStats('2000-01-01', '2999-01-01');
    assert.equal(stats.reduce((x, s) => x + (s.scanned || 0), 0), 2, 'each counted once');
    assert.ok(!a.held && !b.held, 'each waited for the message the other had');
    assert.equal((await store.getUser(USER)).historyId, '210', 'the newer place, whichever finished last');
    assert.equal(await store.raiseHistoryId(USER, '205'), '210', 'an older position never replaces a newer one');
    assert.equal((await store.getUser(USER)).historyId, '210');
});

test('a message claimed by an instance that stopped: the place is kept, and it is taken over once the claim runs out', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' });
    svc.waitForOthersMs = 300;
    await store.putUser(USER, { historyId: '1' });
    const t0 = Date.now();
    assert.equal((await store.claim(USER, 'm1', t0, 5 * 60 * 1000)).tries, 1, 'another instance took it, then stopped');
    gmail.history = { ids: ['m1'], historyId: '2' };
    assert.equal((await svc.handleNotification({ emailAddress: USER, historyId: '2' })).held, true);
    assert.equal(gmail.modified.length, 0);
    assert.equal((await store.getUser(USER)).historyId, '1');
    svc.now = () => t0 + 6 * 60 * 1000;
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal(gmail.modified.length, 1, 'taken over after 5 minutes');
    assert.equal((await store.getUser(USER)).historyId, '2');
});

test('a user\'s rescue is told from the label an email arrived with by their order, even when history is read again', async () => {
    const msgs = { m1: { raw: PHISH, historyId: '50' } };
    const { store, gmail, svc } = await setup({ MODE: 'enforce' }, msgs);
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: ['m1'], inboxed: ['m1'], inboxedAt: { m1: '45' }, historyId: '55' };
    await svc.handleNotification({ emailAddress: USER, historyId: '55' });
    assert.equal((await store.getRecord(`${USER}|m1`)).state, 'moved');
    // The same part of history read again (the arrival's label, before the service read it): not a rescue.
    await store.putUser(USER, { historyId: '1' });
    await svc.handleNotification({ emailAddress: USER, historyId: '55' });
    assert.equal((await store.getRecord(`${USER}|m1`)).state, 'moved');
    // The user takes it back; the history read again from before its arrival lists it as new too.
    gmail.history = { ids: ['m1'], inboxed: ['m1'], inboxedAt: { m1: '60' }, historyId: '61' };
    await svc.handleNotification({ emailAddress: USER, historyId: '61' });
    const rec = await store.getRecord(`${USER}|m1`);
    assert.equal(rec.state, 'released'); assert.equal(rec.releasedByUser, true);
    assert.equal(gmail.modified.length, 1, 'never moved again');
});

test('a message deleted before it was read is skipped without an error', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce' }, {});
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: ['gone'], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal((await store.listEvents()).filter(e => e.kind === 'error').length, 0);
    assert.equal((await store.getUser(USER)).historyId, '2');
});

test('the brake: too many moves in an hour stops moving until an admin resumes', async () => {
    const msgs = {}; for (let i = 0; i < 5; i++) msgs[`p${i}`] = { raw: PHISH };
    const { store, gmail, svc } = await setup({ MODE: 'enforce', BRAKE_PER_HOUR: '3' }, msgs);
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: Object.keys(msgs), historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal(gmail.modified.length, 3, 'three moved, then the brake');
    const recs = await store.listRecords({});
    assert.equal(recs.filter(r => r.action === 'would-move' && r.braked).length, 2);
    assert.ok(await store.getState('brake'));
    assert.ok((await store.listEvents()).some(e => e.kind === 'brake'));
    await svc.resume('it.admin@maple-schools.example');
    assert.equal(await store.getState('brake'), null);
    // After the resume the count starts again: the next moves go through.
    const more = {}; for (let i = 0; i < 2; i++) { more[`q${i}`] = { raw: PHISH }; }
    Object.assign(svc.gmail, { raw: async (user, id) => ({ id, threadId: `t${id}`, labelIds: ['INBOX'], internalDate: 1, raw: PHISH }) });
    gmail.history = { ids: Object.keys(more), historyId: '3' };
    await svc.handleNotification({ emailAddress: USER, historyId: '3' });
    assert.equal(gmail.modified.length, 5, 'both moved after the resume');
    assert.equal(await store.getState('brake'), null);
});

test('first email from an address counts only after the learning period, across the whole organization', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce', FIRST_SEEN_LEARNING_DAYS: '14' });
    await store.setState('installedAt', Date.now());                     // just installed: learning
    await store.putUser(USER, { historyId: '1' });
    gmail.history = { ids: ['m2'], historyId: '2' };
    await svc.handleNotification({ emailAddress: USER, historyId: '2' });
    assert.equal(await store.getRecord(`${USER}|m2`), null);
    const facts = await require('../src/engine/mime').readMessage(GENUINE);
    await store.setState('installedAt', Date.now() - 30 * DAY);
    const rec = await svc.judge(USER, { id: 'x1' }, Object.assign({}, facts, { senderAddress: 'brand.new@first-time.example' }));
    assert.equal(rec.action, 'none', 'a genuine email from a new sender is still clean (1 + 1.5 < 3)');
});

test('watches: pilot unit users are watched, those who leave are stopped; old records are deleted', async () => {
    const { store, gmail, svc } = await setup({ MODE: 'enforce', PILOT_USERS: '', PILOT_OU: '/Staff/Pilot', DIRECTORY_ADMIN: 'admin@maple-schools.example' });
    gmail.ouUsers = ['a@maple-schools.example', 'b@maple-schools.example'];
    assert.deepEqual(await svc.renewWatches(), { watched: 2, failed: 0 });
    assert.equal((await store.getUser('a@maple-schools.example')).watched, true);
    gmail.ouUsers = ['a@maple-schools.example'];
    await svc.renewWatches();
    assert.deepEqual(gmail.stopped, ['b@maple-schools.example']);
    assert.equal((await store.getUser('b@maple-schools.example')).watched, false);
    await store.saveRecord({ key: 'old', processedAt: Date.now() - 90 * DAY, action: 'move' });
    await store.saveRecord({ key: 'new', processedAt: Date.now(), action: 'move' });
    assert.equal(await svc.purge(), 1);
    assert.deepEqual((await store.listRecords({})).map(r => r.key), ['new']);
});

test('a security group as the pilot: its members are watched, those removed are stopped; a failed read stops nothing', async () => {
    const { store, gmail, svc } = await setup({ PILOT_USERS: '', PILOT_GROUP: 'spruce-pilot@maple-schools.example', DIRECTORY_ADMIN: 'admin@maple-schools.example' });
    gmail.groups['spruce-pilot@maple-schools.example'] = ['a@maple-schools.example', 'b@maple-schools.example'];
    assert.deepEqual(await svc.renewWatches(), { watched: 2, failed: 0 });
    assert.deepEqual(gmail.watched, ['a@maple-schools.example', 'b@maple-schools.example']);
    assert.equal(store.events.filter(e => e.kind === 'watch').pop().text, 'Watching 2 mailboxes. spruce-pilot@maple-schools.example: 2 entries, 2 people to watch.');
    assert.equal((await svc.handleNotification({ emailAddress: 'outsider@maple-schools.example', historyId: '5' })).ignored, 'not watched');
    gmail.groups['spruce-pilot@maple-schools.example'] = ['a@maple-schools.example'];
    await svc.renewWatches();
    assert.deepEqual(gmail.stopped, ['b@maple-schools.example']);
    assert.match(store.events.filter(e => e.kind === 'watch').pop().text, /^Watching 1 mailbox\. .* Stopped watching 1 mailbox no longer in the pilot\.$/);
    // Why people in the group aren't watched: said in Recent activity, with the domains that don't match.
    const members = gmail.groupMembers;
    gmail.groupMembers = async (admin, group, domains, found) => { Object.assign(found, { entries: 6, inactive: 1, outside: 2, outsideDomains: ['elsewhere.example', 'students.maple-schools.example'], everyone: 1, groups: 1 }); return ['a@maple-schools.example']; };
    let fail = true;
    const watch = gmail.watch;
    gmail.watch = async (u) => { if (fail) { fail = false; throw new GoogleApiError(400, 'Mail service not enabled', 'watch'); } return watch(u); };
    assert.deepEqual(await svc.renewWatches(), { watched: 0, failed: 1 });
    assert.equal(store.events.filter(e => e.kind === 'watch').pop().text,
        'Watching 0 mailboxes. spruce-pilot@maple-schools.example: 6 entries (1 group inside it, whose members are listed too), 1 person to watch; left out: 1 not active (suspended or archived), '
        + '2 outside your domains (elsewhere.example, students.maple-schools.example; ORG_DOMAINS is maple-schools.example), 1 "all users in the organization" entry, which isn\'t expanded: add people or groups instead. '
        + '1 mailbox couldn\'t be watched (see the errors).');
    gmail.groupMembers = members;
    delete gmail.groups['spruce-pilot@maple-schools.example'];
    await assert.rejects(svc.renewWatches(), /no such group/);
    assert.equal((await store.getUser('a@maple-schools.example')).watched, true, 'still watched after a failed read');
    assert.ok((await store.listEvents()).some(e => e.kind === 'error' && /Couldn't read who is in the pilot \(spruce-pilot@maple-schools.example\)/.test(e.text)));
    assert.deepEqual(gmail.stopped, ['b@maple-schools.example']);
});

test('group members: nested groups included; only active users in the organization\'s own domains', async () => {
    const { GmailClient } = require('../src/gmail/client');
    const calls = [];
    const pages = [
        { members: [{ email: 'A@maple-schools.example', type: 'USER', status: 'ACTIVE' }, { email: 'sub@maple-schools.example', type: 'GROUP', status: 'ACTIVE' },
                    { email: 'gone@maple-schools.example', type: 'USER', status: 'SUSPENDED' }], nextPageToken: 'p2' },
        { members: [{ email: 'friend@elsewhere.example', type: 'USER', status: 'ACTIVE' }, { email: 'b@maple-schools.example', type: 'USER', status: 'ACTIVE' }, { email: 'a@maple-schools.example', type: 'USER', status: 'ACTIVE' }, { id: 'C01abc', type: 'CUSTOMER' }] }];
    const fetch = async (url, init) => { calls.push({ url, auth: init.headers.authorization }); return { ok: true, status: 200, json: async () => pages[calls.length - 1] }; };
    const scopes = [];
    const c = new GmailClient({ tokenFor: async (u, scope) => { scopes.push([u, scope]); return 'tok'; } }, { fetch });
    const found = {};
    assert.deepEqual(await c.groupMembers('admin@maple-schools.example', 'spruce-pilot@maple-schools.example', ['maple-schools.example'], found), ['a@maple-schools.example', 'b@maple-schools.example']);
    assert.deepEqual(found, { entries: 7, inactive: 1, outside: 1, outsideDomains: ['elsewhere.example'], everyone: 1, groups: 1 }, 'what was left out, and why');
    const u = new URL(calls[0].url);
    assert.equal(u.pathname, '/admin/directory/v1/groups/spruce-pilot%40maple-schools.example/members');
    assert.equal(u.searchParams.get('includeDerivedMembership'), 'true');
    assert.equal(new URL(calls[1].url).searchParams.get('pageToken'), 'p2');
    assert.deepEqual(scopes[0], ['admin@maple-schools.example', 'https://www.googleapis.com/auth/admin.directory.group.member.readonly']);
});

test('campaigns: copies of one email to different people group together', () => {
    const a = campaignOf('evil.example', 'ROWAN! Invoice 4471 overdue', 'rowan.ibarra@maple-schools.example');
    const b = campaignOf('evil.example', 'SAM! Invoice 9920 overdue', 'sam.tanaka@maple-schools.example');
    assert.equal(a.key, b.key);
    assert.doesNotMatch(a.label, /rowan/i);
    assert.notEqual(campaignOf('other.example', 'Invoice 1 overdue', 'x@y').key, a.key);
});

test('configuration: real use needs every safety setting; demo mode refuses Cloud Run', () => {
    const p = configProblems(loadConfig({}));
    for (const k of ['ORG_DOMAINS', 'PILOT_OU', 'DELEGATED_SA', 'PUBSUB_TOPIC', 'PUSH_AUDIENCE', 'IAP_AUDIENCE', 'ADMIN_EMAILS']) assert.ok(p.some(x => x.includes(k)), k);
    assert.deepEqual(configProblems(loadConfig({ DEMO: '1' })), []);
    assert.match(configProblems(loadConfig({ DEMO: '1', K_SERVICE: 'spruce' }))[0], /refuses to run on Cloud Run/);
    const c = loadConfig({});
    assert.equal(c.mode, 'monitor', 'monitor by default'); assert.equal(c.aiThreshold, 0.85); assert.equal(c.aiMovesInside, false);
    assert.match(configProblems(loadConfig({ AI_MOVE_THRESHOLD: '0.3' })).join(' '), /AI_MOVE_THRESHOLD/);
});
