'use strict';
// The Firestore store against Google's Firestore emulator: the transactions the service counts on, with
// calls running at the same time. Runs when FIRESTORE_EMULATOR_HOST is set (the CI job starts one:
// .github/workflows/test.yml), skipped otherwise:
//     gcloud emulators firestore start --host-port=127.0.0.1:8786
//     FIRESTORE_EMULATOR_HOST=127.0.0.1:8786 npm test
const test = require('node:test');
const assert = require('node:assert');

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const skip = HOST ? false : 'FIRESTORE_EMULATOR_HOST is not set (no Firestore emulator)';
// A project of its own for each run: nothing shared with another run or a real project.
const PROJECT = `demo-spruce-${process.pid}-${Date.now()}`;
if (HOST) process.env.GCLOUD_PROJECT = PROJECT;

let store;
function getStore() {
    if (!store) { const { FirestoreStore } = require('../src/store/firestore'); store = new FirestoreStore({ firestoreDatabase: '(default)' }); }
    return store;
}
const U = 'reader@maple-schools.example';

test('claims: one instance at a time judges a message; done is done; a stale claim is taken over; tries are counted', { skip }, async () => {
    const s = getStore();
    const now = Date.now(), lease = 5 * 60 * 1000;
    // Ten instances claim the same message at the same moment: one gets it.
    const claims = await Promise.all(Array.from({ length: 10 }, () => s.claim(U, 'm1', now, lease)));
    assert.equal(claims.filter(c => c.tries).length, 1, JSON.stringify(claims));
    assert.equal(claims.filter(c => c.busy).length, 9);
    assert.equal(await s.seen(U, 'm1'), false);
    // A failed try lets it go: the next claim is try 2.
    await s.unclaim(U, 'm1');
    assert.deepEqual(await s.claim(U, 'm1', now + 1000, lease), { tries: 2 });
    // Still working, then the instance stops: after the lease, it's taken over (try 3).
    assert.deepEqual(await s.claim(U, 'm1', now + 2000, lease), { busy: true });
    assert.deepEqual(await s.claim(U, 'm1', now + 2000 + lease, lease), { tries: 3 });
    await s.markSeen(U, 'm1');
    assert.equal(await s.seen(U, 'm1'), true);
    assert.deepEqual(await s.claim(U, 'm1', now + 3 * lease, lease), { done: true });
    // A "seen" document from before 0.2.8 (no state) counts as done.
    await s.db.collection('seen').doc(`${U}|old`).set({ at: now });
    assert.deepEqual(await s.claim(U, 'old', now, lease), { done: true });
});

test('the mailbox\'s position only moves forward, whichever of many writers finishes last', { skip }, async () => {
    const s = getStore();
    await s.putUser(U, { watched: true });
    const ids = Array.from({ length: 20 }, (_, i) => String(1000 + i * 7)).sort(() => Math.random() - 0.5);
    await Promise.all(ids.map(id => s.raiseHistoryId(U, id)));
    assert.equal((await s.getUser(U)).historyId, String(1000 + 19 * 7));
    assert.equal(await s.raiseHistoryId(U, '1001'), String(1000 + 19 * 7), 'an older one is refused');
    assert.equal((await s.getUser(U)).watched, true, 'the rest of the mailbox\'s document is kept');
    // Gmail's history ids are 64-bit: compared as numbers, not text.
    await s.putUser('big@maple-schools.example', { historyId: '9007199254740993' });
    await s.raiseHistoryId('big@maple-schools.example', '18446744073709551615');
    assert.equal((await s.getUser('big@maple-schools.example')).historyId, '18446744073709551615');
});

test('the brake\'s counter is exact with moves at the same moment, and tripping it happens once', { skip }, async () => {
    const s = getStore();
    const slots = await Promise.all(Array.from({ length: 30 }, () => s.reserveMove('2026-11-10T09|0', 12)));
    assert.equal(slots.filter(x => x.ok).length, 12, 'exactly the limit');
    // A district-sized limit, with 80 moves at once (10 instances, 8 each): none waits long or fails.
    const many = await Promise.all(Array.from({ length: 80 }, () => s.reserveMove('2026-11-10T10|0', 3500)));
    assert.equal(many.filter(x => x.ok).length, 80);
    // Stats in shards, summed when read; a day's document from before 0.3.0 counts too.
    await s.db.collection('stats').doc('2026-11-09').set({ day: '2026-11-09', scanned: 5 });
    await Promise.all(Array.from({ length: 40 }, () => s.incStat('2026-11-09', 'scanned')));
    assert.deepEqual((await s.getStats('2026-11-09', '2026-11-09')).map(x => x.scanned), [45]);
    const trips = await Promise.all(Array.from({ length: 5 }, () => s.setStateIfUnset('brake', { at: 1, moves: 12, limit: 12 })));
    assert.equal(trips.filter(Boolean).length, 1, 'one alert');
    assert.deepEqual(await s.getState('brake'), { at: 1, moves: 12, limit: 12 });
    await s.setState('brake', null);
    assert.equal(await s.setStateIfUnset('brake', { at: 2 }), true, 'after a resume it can trip again');
});

test('the campaign hold: weak moves counted exactly, held past the limit with one "first", an admin\'s decision wins', { skip }, async () => {
    const s = getStore();
    const out = await Promise.all(Array.from({ length: 15 }, () => s.campaignHold('c1', 10, Date.now(), 'bulletins.example: weekly')));
    assert.equal(out.filter(x => !x.held && !x.decision).length, 10);
    // (calls past the limit at the same moment: each is held; at most a few can see themselves "first")
    assert.equal(out.filter(x => x.held).length, 5);
    assert.ok(out.filter(x => x.first).length >= 1);
    const later = await s.campaignHold('c1', 10, Date.now());
    assert.deepEqual(later, { held: true, first: false });
    assert.equal((await s.getCampaign('c1')).weakMoves, 10);
    await s.setCampaign('c1', { decision: 'confirmed', decidedBy: 'it.admin@maple-schools.example' });
    assert.deepEqual(await s.campaignHold('c1', 10, Date.now()), { decision: 'confirmed', held: false });
    assert.equal((await s.listCampaignStates()).find(c => c.key === 'c1').decision, 'confirmed');
    const alerts = await Promise.all(Array.from({ length: 30 }, () => s.campaignMoved('c2', 20)));
    assert.equal(alerts.filter(Boolean).length, 1, 'the large-campaign alert once');
    assert.equal((await s.getCampaign('c2')).moves, 30);
});

test('records, events and the shared phishing lists round-trip; purge deletes what is old', { skip }, async () => {
    const s = getStore();
    const old = Date.now() - 400 * 24 * 3600 * 1000;
    await s.saveRecord({ key: `${U}|r1`, user: U, processedAt: Date.now(), action: 'move', state: 'moved', sender: { address: 'a@b.example' } });
    await s.saveRecord({ key: `${U}|r0`, user: U, processedAt: old, action: 'move', state: 'moved', sender: { address: 'a@b.example' } });
    assert.equal((await s.updateRecord(`${U}|r1`, { state: 'released' })).state, 'released');
    assert.equal(await s.updateRecord(`${U}|none`, { state: 'x' }), null);
    assert.equal((await s.listRecords({ sinceMs: Date.now() - 3600 * 1000 })).length, 1);
    await s.incStat('2026-11-10', 'scanned'); await s.incStat('2026-11-10', 'scanned', 2);
    assert.equal((await s.getStats('2026-11-10', '2026-11-10'))[0].scanned, 3);
    const big = Buffer.alloc(2 * 1024 * 1024 + 17, 7);   // over Firestore's 1 MiB document limit: chunks
    await s.putBlob('feed_test', big, { updated: 1, count: 3 });
    const back = await s.getBlob('feed_test');
    assert.equal(back.bytes.length, big.length); assert.ok(back.bytes.equals(big)); assert.equal(back.info.chunks, 3);
    await s.db.collection('events').add({ at: old, kind: 'error', text: 'old' });
    await s.addEvent({ kind: 'watch', text: 'new' });
    const deleted = await s.purge(Date.now() - 365 * 24 * 3600 * 1000);
    assert.ok(deleted >= 2, String(deleted));
    assert.equal(await s.getRecord(`${U}|r0`), null);
    assert.ok(await s.getRecord(`${U}|r1`));
    assert.deepEqual((await s.listEvents(old - 1)).map(e => e.text), ['new']);
});

test('the dashboard\'s cache reads: records carry updatedAt, changed ones are listed in order; only held campaigns are listed', { skip }, async () => {
    const s = getStore();
    const t0 = Date.now() - 1000;
    await s.saveRecord({ key: `${U}|c1`, user: U, processedAt: Date.now(), action: 'flag', sender: { address: 'a@b.example' } });
    await s.saveRecord({ key: `${U}|c2`, user: U, processedAt: Date.now(), action: 'move', sender: { address: 'a@b.example' } });
    const got = await s.listRecordsChangedSince(t0);
    assert.deepEqual(got.filter(r => /\|c[12]$/.test(r.key)).map(r => r.key), [`${U}|c1`, `${U}|c2`]);
    const mid = Math.max(...got.map(r => r.updatedAt));
    await new Promise(r => setTimeout(r, 5));
    const upd = await s.updateRecord(`${U}|c1`, { state: 'released' });
    assert.ok(upd.updatedAt > mid);
    assert.deepEqual((await s.listRecordsChangedSince(mid)).map(r => r.key), [`${U}|c1`]);
    await s.campaignHold('h1', 0, Date.now(), 'held.example: x');   // held at once (limit 0)
    await s.campaignHold('h2', 5, Date.now(), 'fine.example: y');
    const held = (await s.listHeldCampaigns()).map(c => c.key);
    assert.ok(held.includes('h1') && !held.includes('h2'));
});
