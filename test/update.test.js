'use strict';
// 0.3.9: Settings → Update. The approved versions read from GitHub (src/releases.js), the button's checks
// and request (src/update.js), the job install.sh makes, and the Cloud Build steps (deploy/cloud-update.sh)
// against stand-ins for gcloud, curl and docker, with a real git repository. Every address is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { createApp, expectedProject } = require('../src/server');
const { createReleases, parseChangelog, compareVersions, modelSourceOf } = require('../src/releases');
const { updateInfo, startUpdate } = require('../src/update');

const ROOT = path.join(__dirname, '..');
const FAKEBIN = path.join(__dirname, 'fixtures', 'fakebin');
const PKG = require('../package.json');
const ORG = 'maple-schools.example';
const SHA = 'a'.repeat(40);
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const CHANGELOG = `# Changelog\n\n## 9.9.9: Newer\n\n- **Bold** and \`code\`.\n\n## ${PKG.version}: This one\n\n- Things.\n\n## 0.1.0: Old\n\n- Old things.\n`;

function fakeGitHub({ version = '9.9.9', installLevel = PKG.installLevel, fail = false } = {}) {
    const calls = [];
    const f = async (url) => {
        calls.push(url);
        if (fail) return { ok: false, status: 503 };
        const body = url.endsWith('/commits/main') ? { sha: SHA, commit: { committer: { date: '2026-11-10T12:00:00Z' } } }
            : url.endsWith('/package.json') ? JSON.stringify({ version, installLevel })
            : url.endsWith('/CHANGELOG.md') ? CHANGELOG
            : url.endsWith('/VENDOR.json') ? JSON.stringify({ model: '0.12.0', modelSource: { repository: 'https://github.com/thecodewarrior2/TinyPhishLLM', commit: 'c'.repeat(40), files: {} } }) : null;
        if (body === null) return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => body, text: async () => body };
    };
    return { f, calls };
}

test('the approved versions: read from google_service_main\'s newest commit, kept 10 minutes; versions compared by number; the changelog in sections', async () => {
    assert.equal(compareVersions('0.3.10', '0.3.9'), 1); assert.equal(compareVersions('0.3.9', '0.3.9'), 0); assert.equal(compareVersions('0.2.14', '0.3.0'), -1);
    assert.deepEqual(parseChangelog(CHANGELOG).map(c => [c.version, c.title]), [['9.9.9', 'Newer'], [PKG.version, 'This one'], ['0.1.0', 'Old']]);
    let t = 0;
    const gh = fakeGitHub();
    const r = createReleases({ repo: 'district/releases', fetch: gh.f, now: () => t });
    const n = await r.newest();
    assert.deepEqual([n.version, n.commit, n.installLevel, n.model, n.changelog.length], ['9.9.9', SHA, PKG.installLevel, '0.12.0', 3]);
    assert.deepEqual(n.modelSource, { repository: 'https://github.com/thecodewarrior2/TinyPhishLLM', commit: 'c'.repeat(40) }, 'where its image build downloads the model');
    assert.equal(modelSourceOf({ model: '0.11.0' }), null, 'a version from before 0.5.8 had its model inside');
    assert.equal(modelSourceOf({ modelSource: { repository: 'https://example.com/x/y', commit: 'c'.repeat(40) } }), null);
    assert.equal(gh.calls[0], 'https://api.github.com/repos/district/releases/commits/main');
    assert.ok(gh.calls.slice(1).every(u => u.startsWith(`https://raw.githubusercontent.com/district/releases/${SHA}/`)), 'the files of that exact commit');
    await r.newest(); assert.equal(gh.calls.length, 4, 'kept');
    t += 11 * 60 * 1000; await r.newest(); assert.equal(gh.calls.length, 8, 'read again after 10 minutes');
    await assert.rejects(createReleases({ fetch: fakeGitHub({ fail: true }).f }).newest(), /HTTP 503/);
});

function setup({ version = '9.9.9', installLevel = PKG.installLevel, updateJob = 'projects/p/locations/r/jobs/spruce-update', runFails = false } = {}) {
    const store = new MemoryStore();
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `reader@${ORG}`, GOOGLE_CLOUD_PROJECT: 'maple-mail-protection', UPDATE_JOB: updateJob });
    const warned = [];
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn: (x) => warned.push(JSON.parse(x)) } });
    const ran = [];
    const scheduler = { run: async (job) => { if (runFails) throw new Error('Cloud Scheduler answered HTTP 403: denied'); ran.push(job); return {}; } };
    const releases = createReleases({ fetch: fakeGitHub({ version, installLevel }).f });
    const tries = new Map();
    const wrong = { locked: (w) => (tries.get(w) || 0) >= 5, add: (w) => tries.set(w, (tries.get(w) || 0) + 1), clear: (w) => tries.delete(w) };
    const admin = { email: `it.head@${ORG}` };
    const press = (body) => startUpdate({ cfg, store, releases, scheduler, service, admin, body, expectedProject, wrong });
    return { store, cfg, releases, press, ran, warned };
}
const OK = { agree: true, projectId: 'maple-mail-protection', email: `IT.Head@${ORG}`, version: '9.9.9' };

test('the button: the agreement, the project ID and the admin\'s own address; then the request (with the exact commit) and the job, alerted', async () => {
    const s = setup();
    const info = await updateInfo({ cfg: s.cfg, store: s.store, releases: s.releases });
    // Both versions' AI models, and where each comes from (TinyPhishLLM, at the commit the version pins).
    const vendor = require('../vendor/spruce/VENDOR.json');
    assert.deepEqual([info.installed.model, info.installed.modelSource], [vendor.model, { repository: vendor.modelSource.repository, commit: vendor.modelSource.commit }]);
    assert.equal(info.newest.modelSource.commit, 'c'.repeat(40));
    assert.equal(info.canUpdate, true, info.why);
    assert.deepEqual(info.newer.map(c => c.version), ['9.9.9'], 'only what is newer than the version installed');
    assert.equal((await s.press(Object.assign({}, OK, { agree: false }))).status, 400);
    let r = await s.press(Object.assign({}, OK, { projectId: 'other-project' }));
    assert.equal(r.status, 403); assert.match(r.error, /project ID/);
    r = await s.press(Object.assign({}, OK, { email: `someone.else@${ORG}` }));
    assert.equal(r.status, 403); assert.match(r.error, /isn't the email address you are signed in with/);
    r = await s.press(Object.assign({}, OK, { version: '9.9.8' }));
    assert.equal(r.status, 409); assert.match(r.error, /newest approved version is now 9\.9\.9/);
    assert.equal(s.ran.length, 0, 'nothing started yet');
    r = await s.press(OK);
    assert.deepEqual(r, { started: { from: PKG.version, to: '9.9.9' } });
    assert.deepEqual(s.ran, ['projects/p/locations/r/jobs/spruce-update']);
    const req = await s.store.getState('updateRequest');
    assert.deepEqual([req.version, req.commit, req.by], ['9.9.9', SHA, `it.head@${ORG}`]);
    assert.equal((await s.store.getState('update')).phase, 'requested');
    assert.match(s.warned[0].message, /^it\.head@maple-schools\.example started an update from .* to 9\.9\.9 on the dashboard \(confirmed with the project ID and their own email address, and agreed\)/);
    // While it runs: not again.
    r = await s.press(OK);
    assert.equal(r.status, 409); assert.match(r.error, /under way/);
    // Five wrong answers lock it.
    const t = setup();
    for (let i = 0; i < 5; i++) await t.press(Object.assign({}, OK, { email: `guess${i}@${ORG}` }));
    assert.equal((await t.press(OK)).status, 429);
});

test('no button when: already the newest, the version changes the installation itself, updating isn\'t set up, or the job can\'t start', async () => {
    let s = setup({ version: PKG.version });
    let info = await updateInfo({ cfg: s.cfg, store: s.store, releases: s.releases });
    assert.equal(info.canUpdate, false); assert.match(info.why, /is the newest approved version/);
    s = setup({ version: '0.0.1' });   // (a version not yet approved, installed from a zip)
    info = await updateInfo({ cfg: s.cfg, store: s.store, releases: s.releases });
    assert.equal(info.canUpdate, false); assert.match(info.why, new RegExp(`installed, ${PKG.version.replace(/[.]/g, '\\.')}, is newer than the newest approved one \\(0\\.0\\.1\\): there is nothing to update to`));
    s = setup({ installLevel: (PKG.installLevel || 0) + 1 });
    info = await updateInfo({ cfg: s.cfg, store: s.store, releases: s.releases });
    assert.equal(info.canUpdate, false); assert.match(info.why, /changes the installation itself .*bash deploy\/update\.sh/);
    assert.equal((await s.press(OK)).status, 409);
    s = setup({ updateJob: '' });
    info = await updateInfo({ cfg: s.cfg, store: s.store, releases: s.releases });
    assert.match(info.why, /isn't set up yet: run bash deploy\/update\.sh in Cloud Shell once/);
    s = setup({ runFails: true });
    const r = await s.press(OK);
    assert.equal(r.status, 502);
    assert.equal(await s.store.getState('updateRequest'), null, 'the request is taken back');
    assert.equal((await s.store.getState('update')).phase, 'failed');
});

test('the dashboard\'s routes (demo mode: GitHub isn\'t read; a made-up newer version to try the page with)', async () => {
    const cfg = loadConfig({ DEMO: '1', ORG_DOMAINS: ORG });
    const store = new MemoryStore();
    const service = new Service({ cfg, store, gmail: {}, log: { error() {}, warn() {} } });
    const srv = http.createServer(createApp({ cfg, store, service }));
    await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const H = { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' };
    try {
        const d = await (await fetch(`${base}/api/update`)).json();
        assert.equal(d.newest.version, '9.9.9'); assert.equal(d.canUpdate, true);
        assert.ok(d.changelog.some(c => c.version === PKG.version), 'this version\'s own changelog');
        let res = await fetch(`${base}/api/update`, { method: 'POST', headers: H, body: JSON.stringify(Object.assign({}, OK, { projectId: 'demo-project', email: 'demo-admin@example.org' })) });
        assert.equal(res.status, 200); assert.equal((await res.json()).started.demo, true);
        assert.equal(await store.getState('updateRequest'), null, 'demo mode: nothing requested');
        res = await fetch(`${base}/api/update`, { method: 'POST', headers: H, body: JSON.stringify(Object.assign({}, OK, { projectId: 'demo-project', email: 'x@example.org' })) });
        assert.equal(res.status, 403);
        // An update under way (or done, or failed): the page still loads, with its progress. (In 0.3.9 to
        // 0.3.11 its "status" was taken as the HTTP status code, and the page failed with "internal error".)
        for (const phase of ['requested', 'building', 'done', 'failed']) {
            await store.setState('update', { phase, version: '9.9.9', from: PKG.version, by: 'demo-admin@example.org', at: Date.now(), message: 'it stopped' });
            res = await fetch(`${base}/api/update`);
            assert.equal(res.status, 200, phase);
            const p = (await res.json()).progress;
            assert.equal(p.phase, phase); assert.equal(p.version, '9.9.9');
        }
        // About a version already installed or passed (installed from Cloud Shell since): history, so not
        // shown, and it doesn't hold the button back. The one installed, done: shown.
        await store.setState('update', { phase: 'requested', version: '0.0.1', from: '0.0.0', by: 'demo-admin@example.org', at: Date.now() });
        let d2 = await (await fetch(`${base}/api/update`)).json();
        assert.equal(d2.progress, null); assert.equal(d2.running, false); assert.equal(d2.canUpdate, true);
        await store.setState('update', { phase: 'done', version: PKG.version, from: '0.0.1', by: 'demo-admin@example.org', at: Date.now() });
        d2 = await (await fetch(`${base}/api/update`)).json();
        assert.equal(d2.progress.phase, 'done');
    } finally { await new Promise(r => srv.close(r)); }
});

// --- deploy/install.sh's job, and deploy/cloud-update.sh's steps ---------------------------------------
function sandbox() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-update-'));
    const bin = path.join(home, 'bin'), fake = path.join(home, 'fake'), ws = path.join(home, 'workspace');
    for (const d of [bin, fake, ws]) fs.mkdirSync(d);
    for (const f of ['gcloud', 'docker', 'curl']) { fs.copyFileSync(path.join(FAKEBIN, f), path.join(bin, f)); fs.chmodSync(path.join(bin, f), 0o755); }
    const log = path.join(fake, 'calls.log');
    const env = (extra = {}) => Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: log, FAKE_DIR: fake, SPRUCE_WORKSPACE: ws, PROJECT: 'test-proj', REGION: 'us-east1', BUILD: 'b-1',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.example' }, extra);
    return { home, bin, fake, ws, log, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('install.sh makes the spruce-update job: a Cloud Build as spruce-updater with fixed steps, and the roles it needs, no more', { skip: !hasBash }, () => {
    const sb = sandbox();
    try {
        const dir = path.join(sb.home, 'spruce-mail-protection');
        fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true }); fs.mkdirSync(path.join(dir, 'vendor', 'spruce'), { recursive: true });
        for (const f of fs.readdirSync(path.join(ROOT, 'deploy'))) if (f !== 'settings.env') fs.copyFileSync(path.join(ROOT, 'deploy', f), path.join(dir, 'deploy', f));
        for (const f of ['package.json', 'CHANGELOG.md']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
        fs.copyFileSync(path.join(ROOT, 'vendor', 'spruce', 'VENDOR.json'), path.join(dir, 'vendor', 'spruce', 'VENDOR.json'));
        fs.writeFileSync(path.join(dir, 'deploy', 'settings.env'), ['PROJECT=test-proj', 'REGION=us-east1', 'ORG_DOMAINS=district-test.example', 'PILOT_GROUP=pilot@district-test.example',
            'DIRECTORY_ADMIN=dir@district-test.example', 'ADMIN_GROUP=admins@district-test.example', 'MODE=monitor', ''].join('\n'));
        fs.writeFileSync(sb.log, '');
        const r = spawnSync('bash', ['deploy/install.sh'], { cwd: dir, encoding: 'utf8', input: '', env: sb.env({ SPRUCE_WAIT_STEP: '0' }) });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const calls = fs.readFileSync(sb.log, 'utf8');
        assert.match(calls, /iam service-accounts describe spruce-updater@test-proj\.iam\.gserviceaccount\.com/, 'made if missing (the stand-in has every account)');
        for (const role of ['cloudbuild.builds.editor', 'logging.logWriter', 'datastore.user']) assert.match(calls, new RegExp(`projects add-iam-policy-binding test-proj --member=serviceAccount:spruce-updater@test-proj\\.iam\\.gserviceaccount\\.com --role=roles/${role.replace('.', '\\.')}`));
        assert.match(calls, /artifacts repositories add-iam-policy-binding spruce .*spruce-updater@.* --role=roles\/artifactregistry\.writer/);
        assert.match(calls, /run services add-iam-policy-binding spruce-worker .*spruce-updater@.* --role=roles\/run\.developer/);
        assert.match(calls, /run services add-iam-policy-binding spruce-admin .*spruce-updater@.* --role=roles\/run\.developer/);
        assert.doesNotMatch(calls, /spruce-updater@[^ ]* --role=roles\/(owner|editor|resourcemanager|iam\.securityAdmin|run\.admin)/, 'nothing broader');
        assert.doesNotMatch(calls, /--member=serviceAccount:spruce-run@[^ ]* --role=roles\/(cloudbuild|run\.developer|run\.admin)/, 'the dashboard can\'t build or deploy');
        assert.match(calls, /scheduler jobs create http spruce-update .*--uri=https:\/\/cloudbuild\.googleapis\.com\/v1\/projects\/test-proj\/locations\/us-east1\/builds --http-method=POST .*--oauth-service-account-email=spruce-updater@test-proj\.iam\.gserviceaccount\.com/);
        const build = JSON.parse(fs.readFileSync(path.join(sb.fake, 'update-build.json'), 'utf8'));
        assert.equal(build.serviceAccount, 'projects/test-proj/serviceAccounts/spruce-updater@test-proj.iam.gserviceaccount.com');
        assert.deepEqual(build.steps.map(s => s.id), ['download', 'check', 'pick', 'image', 'deploy', 'finish']);
        assert.deepEqual(build.steps[0].args, ['clone', '-q', 'https://github.com/thecodewarrior2/Google_service_main.git', '/workspace/release']);
        assert.ok(build.steps[1].env.includes('BUILD=$BUILD_ID'), 'Cloud Build fills in its own id');
        assert.match(fs.readFileSync(path.join(sb.fake, 'env-spruce-admin.yaml'), 'utf8'), /^UPDATE_JOB: "projects\/test-proj\/locations\/us-east1\/jobs\/spruce-update"$/m);
        assert.match(fs.readFileSync(path.join(sb.fake, 'env-spruce-admin.yaml'), 'utf8'), /^RELEASES_REPO: "thecodewarrior2\/Google_service_main"$/m);
        assert.match(calls, new RegExp(`run deploy spruce-worker .*--update-labels=spruce-version=[\\d-]+,spruce-model=[\\d-]+,spruce-install-level=${PKG.installLevel}`));
    } finally { sb.cleanup(); }
});

test('cloud-update.sh: nothing asked, nothing done; asked, the exact approved commit built and deployed; not on main, too old or a new installation: refused and reported', { skip: !hasBash }, () => {
    const sb = sandbox();
    const git = (cwd, ...a) => { const x = spawnSync('git', a, { cwd, encoding: 'utf8', env: sb.env() }); assert.equal(x.status, 0, x.stderr); return x.stdout.trim(); };
    // A stand-in for google_service_main: an approved 9.9.9 on main, and a commit that isn't on it.
    const origin = path.join(sb.home, 'origin');
    fs.mkdirSync(path.join(origin, 'deploy'), { recursive: true }); fs.mkdirSync(path.join(origin, 'vendor', 'spruce'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'deploy', 'cloud-update.sh'), path.join(origin, 'deploy', 'cloud-update.sh'));
    fs.writeFileSync(path.join(origin, 'vendor', 'spruce', 'VENDOR.json'), JSON.stringify({ model: '0.12.0', modelSource: { repository: 'https://github.com/thecodewarrior2/TinyPhishLLM', commit: 'd'.repeat(40), files: {} } }, null, 2));
    const write = (v, level) => fs.writeFileSync(path.join(origin, 'package.json'), `{\n  "version": "${v}",\n  "installLevel": ${level}\n}\n`);
    git(sb.home, 'init', '-q', '-b', 'main', origin);
    write('9.9.9', 1); git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', '9.9.9');
    const approved = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', '-b', 'not-approved'); write('9.9.10', 1); git(origin, 'commit', '-qam', 'x');
    const stranger = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', '-b', 'later-level', approved); write('9.9.11', 2); git(origin, 'commit', '-qam', 'y');
    const newLevel = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');
    git(sb.home, 'clone', '-q', origin, path.join(sb.ws, 'release'));
    const reqDoc = (version, commit, ageMs = 60000) => JSON.stringify({ fields: { value: { mapValue: { fields: { version: { stringValue: version }, commit: { stringValue: commit },
        by: { stringValue: `it.head@${ORG}` }, at: { integerValue: String(Date.now() - ageMs) } } } } } });
    const run = (extra) => {
        fs.writeFileSync(sb.log, '');
        for (const f of fs.readdirSync(sb.fake)) if (/^update-state-|^event\.json$/.test(f)) fs.rmSync(path.join(sb.fake, f));
        const codes = {};
        for (const p of ['check', 'pick', 'image', 'deploy', 'finish']) {
            const x = spawnSync('bash', [path.join(sb.ws, 'release', 'deploy', 'cloud-update.sh'), p], { cwd: sb.ws, encoding: 'utf8', env: sb.env(extra) });
            codes[p] = x.status; codes[`${p}.out`] = x.stdout + x.stderr;
        }
        const states = fs.readdirSync(sb.fake).filter(f => /^update-state-/.test(f)).sort().map(f => {
            const v = JSON.parse(fs.readFileSync(path.join(sb.fake, f), 'utf8')).fields.value.mapValue.fields;
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.stringValue || x.integerValue]));
        });
        const event = fs.existsSync(path.join(sb.fake, 'event.json')) ? JSON.parse(fs.readFileSync(path.join(sb.fake, 'event.json'), 'utf8')).fields : null;
        return { codes, states, event, calls: fs.readFileSync(sb.log, 'utf8') };
    };
    try {
        // Nothing asked for (the yearly run): nothing at all.
        let r = run({});
        assert.ok(Object.entries(r.codes).filter(([k]) => !k.includes('.')).every(([, c]) => c === 0), JSON.stringify(r.codes));
        assert.doesNotMatch(r.calls, /run deploy|docker build|-X (PATCH|POST|DELETE)/);
        // Firestore refusing (not a missing request): the build fails at check, so its history shows why.
        r = run({ FAKE_REQUEST: 'denied' });
        assert.equal(r.codes.check, 1); assert.match(r.codes['check.out'], /Couldn't read the update request from Firestore.*PERMISSION_DENIED/);
        assert.doesNotMatch(r.calls, /run deploy|docker build/);
        // Asked for 9.9.9 (approved), running 0.3.8: built from that commit and deployed, both services.
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1' });
        assert.equal(r.codes.finish, 0, r.codes['finish.out']);
        assert.equal(JSON.parse(fs.readFileSync(path.join(sb.ws, 'build', 'package.json'), 'utf8')).version, '9.9.9', 'the approved commit\'s files are built');
        assert.ok(!fs.existsSync(path.join(sb.ws, 'build', '.git')));
        const image = `us-east1-docker.pkg.dev/test-proj/spruce/mail-protection:9.9.9-c${approved.slice(0, 12)}`;
        assert.match(r.calls, new RegExp(`docker build -t ${image.replace(/[.]/g, '\\.')} ${path.join(sb.ws, 'build').replace(/[.]/g, '\\.')}\\n`));
        for (const s of ['spruce-worker', 'spruce-admin']) assert.match(r.calls, new RegExp(`run deploy ${s} --image=${image.replace(/[.]/g, '\\.')} --region=us-east1 --update-labels=spruce-version=9-9-9,spruce-model=0-12-0,spruce-install-level=1`));
        assert.deepEqual(r.states.map(s => s.phase), ['building', 'done']);
        assert.equal(r.event.kind.stringValue, 'update');
        assert.equal(r.event.text.stringValue, `The update from 0.3.8 to 9.9.9 finished: both services run 9.9.9, with the AI model phish-tiny 0.12.0 from TinyPhishLLM (ddddddd) (started by it.head@${ORG} on the dashboard).`);
        assert.match(r.calls, /curl .*-X DELETE .*\/state\/updateRequest/);
        assert.doesNotMatch(r.calls, /--min-instances/, 'how many mailboxes are watched unknown: the dashboard left as it is');
        // 0.5.0: the dashboard always on from 10,000 watched mailboxes (state/watchedCount), else not; the
        // worker as it is.
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1', FAKE_WATCHED: '12000' });
        assert.match(r.calls, /run deploy spruce-admin .*--min-instances=1 --quiet/);
        assert.doesNotMatch(r.calls, /run deploy spruce-worker .*--min-instances/);
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1', FAKE_WATCHED: '9999' });
        assert.match(r.calls, /run deploy spruce-admin .*--min-instances=0 --quiet/);
        assert.deepEqual(r.states.map(s => s.phase), ['building', 'done']);
        // The job run twice (the button, and by hand): a build that finds another one building leaves it
        // alone, and changes nothing. One building for longer than the build's timeout has stopped.
        const progressDoc = (phase, ageMs, build) => JSON.stringify({ fields: { value: { mapValue: { fields: { phase: { stringValue: phase }, at: { integerValue: String(Date.now() - ageMs) }, build: { stringValue: build } } } } } });
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1', FAKE_UPDATE: progressDoc('building', 60000, 'b-first'), BUILD: 'b-second' });
        assert.match(r.codes['check.out'], /An update is already under way \(build b-first\): this build leaves it to that one\./);
        assert.ok(Object.entries(r.codes).filter(([k]) => !k.includes('.')).every(([, c]) => c === 0), JSON.stringify(r.codes));
        assert.doesNotMatch(r.calls, /run deploy|docker build|-X (PATCH|POST|DELETE)/);
        assert.deepEqual(r.states, []); assert.equal(r.event, null);
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1', FAKE_UPDATE: progressDoc('building', 46 * 60000, 'b-first'), BUILD: 'b-second' });
        assert.deepEqual(r.states.map(s => s.phase), ['building', 'done'], 'a build stopped long ago doesn\'t block the next');
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1', FAKE_UPDATE: progressDoc('requested', 1000, '') });
        assert.deepEqual(r.states.map(s => s.phase), ['building', 'done'], 'the dashboard\'s "requested" is the usual start');
        // A commit that isn't on main (a fork's, say): refused, nothing built.
        git(path.join(sb.ws, 'release'), 'checkout', '-q', 'main');
        git(path.join(sb.ws, 'release'), 'fetch', '-q', 'origin', 'not-approved');
        r = run({ FAKE_REQUEST: reqDoc('9.9.10', stranger), FAKE_RUNNING: '0-3-8' });
        assert.doesNotMatch(r.calls, /docker build|run deploy/);
        assert.notEqual(r.codes.finish, 0, 'the build shows as failed');
        assert.equal(r.states.at(-1).phase, 'failed'); assert.match(r.states.at(-1).message, /isn't on google_service_main's main branch/);
        assert.equal(r.event.alert.booleanValue, true);
        // Too old a request, or not newer than what runs: refused at check.
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved, 31 * 60 * 1000) });
        assert.deepEqual(r.states.map(s => [s.phase, s.message]), [['failed', 'it was asked for more than 30 minutes ago']]);
        assert.doesNotMatch(r.calls, /docker build|run deploy/);
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '9-9-9' });
        assert.match(r.states[0].message, /isn't newer than the version running \(9\.9\.9\)/);
        // A version that changes the installation itself (a higher installLevel): refused at pick.
        git(path.join(sb.ws, 'release'), 'fetch', '-q', 'origin', 'later-level');
        git(origin, 'update-ref', 'refs/heads/main', newLevel);   // (approved, but a new installation)
        git(path.join(sb.ws, 'release'), 'checkout', '-q', 'main');
        r = run({ FAKE_REQUEST: reqDoc('9.9.11', newLevel), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1' });
        assert.match(r.states.at(-1).message, /changes the installation itself \(installLevel 2\): install it from Cloud Shell/);
        assert.doesNotMatch(r.calls, /docker build|run deploy/);
        // A deploy that fails: reported, with rollback.sh.
        git(origin, 'update-ref', 'refs/heads/main', approved);
        git(path.join(sb.ws, 'release'), 'fetch', '-q', '--force', 'origin', 'main:refs/remotes/origin/main');
        r = run({ FAKE_REQUEST: reqDoc('9.9.9', approved), FAKE_RUNNING: '0-3-8', FAKE_LEVEL: '1', FAKE_DEPLOY: 'fail' });
        assert.equal(r.states.at(-1).phase, 'failed'); assert.match(r.states.at(-1).message, /spruce-worker couldn't be deployed/);
        assert.match(r.event.text.stringValue, /bash deploy\/rollback\.sh goes back/);
    } finally { sb.cleanup(); }
});
