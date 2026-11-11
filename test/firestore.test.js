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
    // 0.4.0: what expires carries expireAt (a Timestamp, RETENTION_DAYS on: 35 days by default since
    // 0.5.0), for Firestore's TTL policies; reads leave it out.
    const raw = (await s.db.collection('records').doc(`${U}|r1`).get()).data();
    assert.ok(raw.expireAt && typeof raw.expireAt.toMillis === 'function');
    assert.ok(Math.abs(raw.expireAt.toMillis() - (raw.processedAt + 35 * 24 * 3600 * 1000)) < 1000, 'processedAt + 35 days');
    assert.equal('expireAt' in (await s.getRecord(`${U}|r1`)), false);
    assert.equal((await s.listRecords({ sinceMs: Date.now() - 3600 * 1000 })).some(r => 'expireAt' in r), false);
    assert.equal((await s.listEvents(old - 1)).some(e => 'expireAt' in e), false);
    const ev = (await s.db.collection('events').where('text', '==', 'new').get()).docs[0].data();
    assert.ok(ev.expireAt.toMillis() > Date.now() + 34 * 24 * 3600 * 1000 && ev.expireAt.toMillis() < Date.now() + 36 * 24 * 3600 * 1000);
    // Several counters in one write.
    await s.incStats('2026-11-11', { scanned: 40, moved: 2 });
    const st = (await s.getStats('2026-11-11', '2026-11-11'))[0];
    assert.deepEqual([st.scanned, st.moved], [40, 2]);
    // The cleanup stops at its time limit (the rest at the next run).
    for (let i = 0; i < 5; i++) await s.db.collection('events').add({ at: old, kind: 'error', text: 'old' });
    assert.equal(await s.purge(Date.now() - 365 * 24 * 3600 * 1000, { budgetMs: -1 }), 0);
    assert.equal(await s.purge(Date.now() - 365 * 24 * 3600 * 1000), 5);
});

test('0.4.1: the mailboxes in numbers come from counts and one read, not every mailbox', { skip }, async () => {
    const s = getStore();
    const now = Date.now();
    for (let i = 0; i < 5; i++) await s.putUser(`m${i}@maple-schools.example`, { watched: i < 4, watchExpiration: i < 4 ? now + (i + 1) * 864e5 : null, lastNotification: now - i * 1000 });
    const sum = await s.mailboxSummary(now + 2.5 * 864e5);
    assert.ok(sum.watched >= 4);
    assert.ok(sum.lastNotification >= now);
    assert.ok(sum.ending >= 2, JSON.stringify(sum));
    const listed = await s.listWatched(500);
    assert.ok(listed.some(u => u.email === 'm0@maple-schools.example') && !listed.some(u => u.email === 'm4@maple-schools.example'));
});

test('0.4.0: a claim and a new sender are created without a transaction; races still have one winner', { skip }, async () => {
    const s = getStore();
    const now = Date.now(), lease = 300000;
    const claims = await Promise.all(Array.from({ length: 12 }, () => s.claim(U, 'race1', now, lease)));
    assert.equal(claims.filter(c => c.tries === 1).length, 1, 'one instance has it');
    assert.equal(claims.filter(c => c.busy).length, 11, 'the others see it busy');
    const seen = (await s.db.collection('seen').doc(`${U}|race1`).get()).data();
    assert.equal(seen.state, 'working'); assert.ok(seen.expireAt);
    await s.markSeen(U, 'race1');
    assert.deepEqual(await s.claim(U, 'race1', now, lease), { done: true });
    const firsts = await Promise.all(Array.from({ length: 12 }, (_, i) => s.senderFirstSeen('race-sender', now + i)));
    assert.equal(new Set(firsts).size, 1, 'every caller gets the same first-seen time');
    assert.equal(await s.senderFirstSeen('race-sender', now + 999), firsts[0]);
    // The campaign counter tells its caller once the alert is sent.
    let told = 0;
    for (let i = 0; i < 3; i++) await s.campaignMoved('c-told', 2, Date.now(), () => told++);
    assert.ok(told >= 1);
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

test('deploy/clear-data.sh against Firestore: sees the brake and held campaigns, writes its Activity entry, restarts the clock', { skip: skip || (require('child_process').spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash') }, async () => {
    const os = require('os'), path = require('path'), fs = require('fs'), { spawnSync } = require('child_process');
    const s = getStore();
    // A folder as unzipped, with the stand-in gcloud (nothing reaches Google); curl is the real one.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-clear-'));
    const dir = path.join(home, 'spruce'), bin = path.join(home, 'bin'), log = path.join(home, 'calls.log');
    fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true }); fs.mkdirSync(bin);
    fs.copyFileSync(path.join(__dirname, '..', 'deploy', 'clear-data.sh'), path.join(dir, 'deploy', 'clear-data.sh'));
    fs.writeFileSync(path.join(dir, 'deploy', 'settings.env'), `PROJECT=${PROJECT}\nREGION=us-east1\n`);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'fakebin', 'gcloud'), path.join(bin, 'gcloud')); fs.chmodSync(path.join(bin, 'gcloud'), 0o755);
    const run = (...args) => {
        fs.writeFileSync(log, '');
        const r = spawnSync('bash', ['deploy/clear-data.sh', ...args], { cwd: dir, encoding: 'utf8', input: '',
            env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: log, FAKE_DIR: home, SPRUCE_FIRESTORE_URL: `http://${HOST}/v1`, FAKE_TOKEN: 'owner' }) });
        return { code: r.status, out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
    };
    try {
        // A token Firestore refuses: "couldn't check" stops it, never reads as "nothing held".
        fs.writeFileSync(log, '');
        const bad = spawnSync('bash', ['deploy/clear-data.sh', '--yes'], { cwd: dir, encoding: 'utf8', input: '',
            env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: log, FAKE_DIR: home, SPRUCE_FIRESTORE_URL: `http://${HOST}/v1`, FAKE_TOKEN: 'not-a-jwt' }) });
        assert.equal(bad.status, 1, bad.stdout); assert.match(bad.stdout + bad.stderr, /Couldn't check whether the brake or a campaign pause is on/);
        assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /bulk-delete/);
        await s.setState('brake', { at: 1, moves: 5, limit: 5 });
        let r = run('--yes');
        assert.equal(r.code, 1, r.out); assert.match(r.out, /The brake is on/);
        await s.setState('brake', null);
        await s.campaignHold('clear-h', 0, Date.now(), 'held.example: x');     // held, no decision yet
        r = run('--yes');
        assert.equal(r.code, 1, r.out); assert.match(r.out, /Moving is paused for [1-9]\d* campaign\(s\), waiting for a decision/); assert.doesNotMatch(r.out, /The brake is on/);
        await s.setState('installedAt', 12345);
        r = run('--yes', '--even-if-held', '--reset-clock');
        assert.equal(r.code, 0, r.out);
        assert.equal(await s.getState('installedAt'), null, 'the clock restarts');
        const e = (await s.listEvents(Date.now() - 60000)).find(x => x.kind === 'clear');
        assert.ok(e, 'the Activity entry, as the dashboard reads it');
        assert.equal(typeof e.at, 'number');
        assert.match(e.text, /^it\.admin@district-test\.example cleared the dashboard's data/);
        assert.match(fs.readFileSync(log, 'utf8'), /firestore bulk-delete --database=\(default\) --collection-ids=records,stats,campaigns,moveCounts,events --quiet/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('deploy/dashboard-policy.sh against Firestore: reads the changes as the service stores them, then removes them and notes it', { skip: skip || (require('child_process').spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash') }, async () => {
    const os = require('os'), path = require('path'), fs = require('fs'), { spawnSync } = require('child_process');
    const { Service } = require('../src/pipeline');
    const { loadConfig } = require('../src/config');
    const s = getStore();
    // Changes made on the dashboard, by the service itself.
    const svc = new Service({ cfg: loadConfig({ STORE: 'memory', ORG_DOMAINS: 'maple-schools.example', PILOT_USERS: U, MODE: 'monitor' }), store: s, gmail: {}, log: { error() {}, warn() {} } });
    await svc.setPolicy('mode', 'enforce', 'it.head@maple-schools.example');
    await svc.setPolicy('aiThreshold', 0.95, 'it.head@maple-schools.example');
    await svc.setPolicy('brakePerHour', 250, 'it.head@maple-schools.example');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-policy-'));
    const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'fakebin', 'gcloud'), path.join(bin, 'gcloud')); fs.chmodSync(path.join(bin, 'gcloud'), 0o755);
    const file = path.join(home, 'settings.env');
    fs.writeFileSync(file, 'MODE=monitor\nBRAKE_PER_HOUR=250\n');
    const run = (script) => spawnSync('bash', ['-c', `set -euo pipefail; . deploy/dashboard-policy.sh; ${script}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8', input: '',
        env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: path.join(home, 'log'), FAKE_DIR: home, FAKE_TOKEN: 'owner', SPRUCE_FIRESTORE_URL: `http://${HOST}/v1` }) });
    try {
        let r = run(`dashboard_policy_read ${PROJECT} monitor '' 250 ''; printf '%s' "$DASHBOARD_POLICY"`);
        assert.equal(r.status, 0, r.stderr);
        const rows = r.stdout.trim().split('\n').map(l => l.split('\t'));
        assert.deepEqual(rows.map(x => [x[0], x[1], x[2], x[3], x[5], x[6]]), [
            ['mode', 'enforce', 'enforce', 'it.head@maple-schools.example', 'differs', 'monitor'],
            ['aiThreshold', '0.95', '95%', 'it.head@maple-schools.example', 'unset', 'not set'],
            ['brakePerHour', '250', '250 moves an hour', 'it.head@maple-schools.example', 'same', '250 moves an hour']]);
        assert.match(rows[0][4], /^\d{4}-\d\d-\d\d$/);
        // Reconciled (no terminal: the dashboard's kept), written into the file, then removed and noted.
        r = run(`dashboard_policy_read ${PROJECT} monitor '' 250 ''; dashboard_policy_reconcile ${file}; echo "MODE=$MODE AI=$AI_MOVE_THRESHOLD"; dashboard_policy_finish ${PROJECT} 9.9.9`);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /MODE=enforce AI=0\.95/);
        assert.match(fs.readFileSync(file, 'utf8'), /^MODE=enforce\nBRAKE_PER_HOUR=250\nAI_MOVE_THRESHOLD=0\.95\n$/);
        for (const k of ['mode', 'aiThreshold', 'brakePerHour']) assert.equal(await s.getState(`policy-${k}`), null, `policy-${k} removed`);
        const e = (await s.listEvents(Date.now() - 60000)).find(x => /installed 9\.9\.9 with deploy\/install\.sh/.test(x.text || ''));
        assert.ok(e, 'noted in Activity'); assert.equal(e.kind, 'settings');
        assert.match(e.text, /kept the dashboard's mode \(enforce\) over settings\.env's \(monitor\); took the dashboard's AI move threshold \(95%\)/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('deploy/cloud-update.sh against Firestore: reads the dashboard\'s request, and its "building", "done" and Activity line read back as the dashboard reads them', { skip: skip || (require('child_process').spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash') }, async () => {
    const os = require('os'), path = require('path'), fs = require('fs'), { spawnSync } = require('child_process');
    const s = getStore();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-cu-'));
    const bin = path.join(home, 'bin'), ws = path.join(home, 'ws');
    fs.mkdirSync(bin); fs.mkdirSync(path.join(ws, 'release', 'deploy'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'deploy', 'cloud-update.sh'), path.join(ws, 'release', 'deploy', 'cloud-update.sh'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'fakebin', 'gcloud'), path.join(bin, 'gcloud')); fs.chmodSync(path.join(bin, 'gcloud'), 0o755);
    const run = (p) => spawnSync('bash', [path.join(ws, 'release', 'deploy', 'cloud-update.sh'), p], { encoding: 'utf8',
        env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: path.join(home, 'log'), FAKE_DIR: home, FAKE_TOKEN: 'owner', FAKE_RUNNING: '0-3-8',
            SPRUCE_WORKSPACE: ws, SPRUCE_FIRESTORE_URL: `http://${HOST}/v1`, PROJECT, REGION: 'us-east1', BUILD: 'b-42' }) });
    try {
        await s.setState('updateRequest', { version: '9.9.9', commit: 'b'.repeat(40), by: 'it.head@maple-schools.example', at: Date.now() });
        let r = run('check');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const st = await s.getState('update');
        assert.deepEqual([st.phase, st.version, st.from, st.by, st.build, typeof st.at], ['building', '9.9.9', '0.3.8', 'it.head@maple-schools.example', 'b-42', 'number']);
        fs.writeFileSync(path.join(ws, 'deployed'), '');   // (as if pick, image and deploy had worked)
        r = run('finish');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal((await s.getState('update')).phase, 'done');
        assert.equal(await s.getState('updateRequest'), null, 'the request is removed');
        const e = (await s.listEvents(Date.now() - 60000)).find(x => x.kind === 'update');
        assert.ok(e && e.alert === false && /^The update from 0\.3\.8 to 9\.9\.9 finished/.test(e.text), JSON.stringify(e));
        // No request now (Firestore's own "not found"): the next run does nothing, and doesn't fail.
        r = run('check');
        assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /No update was asked for: nothing to do/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
