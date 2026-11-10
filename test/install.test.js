'use strict';
// The deploy scripts (deploy/*.sh) against stand-ins for gcloud and docker: what they run, in what
// order, and when they stop. Nothing reaches Google. Every name is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;

// The stand-ins for gcloud and docker: test/fixtures/fakebin.
const FAKEBIN = path.join(__dirname, 'fixtures', 'fakebin');
const SETTINGS = ['PROJECT=test-proj', 'REGION=us-east1', 'ORG_DOMAINS=district-test.example', 'PILOT_GROUP=pilot@district-test.example',
    'DIRECTORY_ADMIN=dir@district-test.example', 'ADMIN_GROUP=admins@district-test.example', 'MODE=monitor', ''].join('\n');

// A copy of the scripts in a temporary folder (as unzipped from a release), with the stand-ins.
function workspace(name = 'spruce-mail-protection-0.3.0', settings = SETTINGS) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-install-'));
    const dir = path.join(home, name), bin = path.join(home, 'bin'), fake = path.join(home, 'fake');
    for (const d of [path.join(dir, 'deploy'), bin, fake]) fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'deploy'))) fs.copyFileSync(path.join(ROOT, 'deploy', f), path.join(dir, 'deploy', f));
    for (const f of ['package.json', 'CHANGELOG.md']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    if (settings !== null) fs.writeFileSync(path.join(dir, 'deploy', 'settings.env'), settings);
    for (const f of ['gcloud', 'docker']) { fs.copyFileSync(path.join(FAKEBIN, f), path.join(bin, f)); fs.chmodSync(path.join(bin, f), 0o755); }
    const run = (script, env = {}, args = []) => {
        const log = path.join(fake, 'calls.log');
        fs.writeFileSync(log, '');
        const r = spawnSync('bash', [path.join('deploy', script), ...args], { cwd: dir, encoding: 'utf8', input: '',
            env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: log, FAKE_DIR: fake, SPRUCE_WAIT_STEP: '0', SPRUCE_STOP_WAIT: '0' }, env) });
        return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
    };
    return { home, dir, fake, run, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const has = (calls, re) => calls.some(c => re.test(c));

test('install.sh: the whole install in order, and what each step sets up', { skip: !hasBash }, () => {
    const w = workspace();
    try {
        const r = w.run('install.sh');
        assert.equal(r.code, 0, r.out);
        const order = ['services enable', 'firestore databases', 'iam service-accounts', 'pubsub topics', 'artifacts repositories', 'docker build', 'run deploy spruce-worker', 'run deploy spruce-admin', 'scheduler jobs'];
        const at = order.map(k => r.calls.findIndex(c => c.includes(k)));
        assert.ok(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])), `order: ${JSON.stringify(at)}`);
        assert.ok(has(r.calls, /services enable .*monitoring\.googleapis\.com/));
        assert.ok(has(r.calls, /add-iam-policy-binding test-proj --member=serviceAccount:spruce-run@test-proj\.iam\.gserviceaccount\.com --role=roles\/cloudscheduler\.jobRunner/));
        assert.ok(has(r.calls, /--role=roles\/cloudbuild\.builds\.builder/), 'spruce-build gets its role');
        assert.ok(has(r.calls, /jobs create http spruce-sync-feeds .*--schedule=23 \* \* \* \*/), 'the health check runs hourly');
        assert.ok(has(r.calls, /pubsub subscriptions create gmail-spruce-push .*--min-retry-delay=30s --max-retry-delay=600s/));
        assert.ok(!has(r.calls, /--no-iap/), 'IAP was off on the worker: nothing to turn off');
        assert.match(r.out, /spruce-renew-watches reached the service/);
        // Alerts: an email channel and two log-based policies, as valid JSON.
        assert.ok(has(r.calls, /beta monitoring channels create .*--channel-labels=email_address=admins@district-test\.example/));
        const policies = fs.readdirSync(w.fake).filter(f => f.startsWith('policy-')).map(f => JSON.parse(fs.readFileSync(path.join(w.fake, f), 'utf8')));
        assert.deepEqual(policies.map(p => p.conditions[0].conditionMatchedLog.filter),
            ['resource.type="cloud_run_revision" AND jsonPayload.spruceAlert:*', 'resource.type="cloud_scheduler_job" AND severity>=ERROR AND resource.labels.job_id:"spruce-"']);
        assert.ok(policies.every(p => p.notificationChannels[0] === 'projects/test-proj/notificationChannels/42' && p.alertStrategy.notificationRateLimit.period === '300s'));
        assert.match(r.out, /Alerts: emailed to admins@district-test\.example/);
    } finally { w.cleanup(); }
});

test('install.sh: Docker can\'t upload, so Cloud Build builds as spruce-build; a failed Docker build stops before deploying', { skip: !hasBash }, () => {
    const w = workspace();
    try {
        let r = w.run('install.sh', { FAKE_PUSH: 'refused' });
        assert.equal(r.code, 0, r.out);
        assert.ok(has(r.calls, /builds submit --tag .* --region=us-east1 --service-account=projects\/test-proj\/serviceAccounts\/spruce-build@test-proj\.iam\.gserviceaccount\.com --default-buckets-behavior=regional-user-owned-bucket/));
        assert.match(r.out, /Building it with Cloud Build instead/);
        r = w.run('install.sh', { FAKE_DOCKER: 'down' });
        assert.ok(has(r.calls, /builds submit/) && !has(r.calls, /docker build/));
        r = w.run('install.sh', { FAKE_DBUILD: 'fail' });
        assert.equal(r.code, 1);
        assert.match(r.out, /the image didn't build/);
        assert.ok(!has(r.calls, /run deploy/), 'nothing deployed');
    } finally { w.cleanup(); }
});

test('install.sh: IAP on the worker is turned off; a refused job stops the install with the reason', { skip: !hasBash }, () => {
    const w = workspace();
    try {
        let r = w.run('install.sh', { FAKE_IAP: 'on' });
        assert.equal(r.code, 0, r.out);
        assert.ok(has(r.calls, /beta run services update spruce-worker --region=us-east1 --no-iap/));
        assert.match(r.out, /Identity-Aware Proxy was on for spruce-worker/);
        r = w.run('install.sh', { FAKE_JOB: 'refused' });
        assert.equal(r.code, 1);
        assert.match(r.out, /spruce-renew-watches couldn't reach the worker \(UNAUTHENTICATED: .*401\)/);
    } finally { w.cleanup(); }
});

test('install.sh: refuses missing billing, the example values and bad settings; ALERT_EMAIL=off sets up no alerts', { skip: !hasBash }, () => {
    let w = workspace();
    try {
        let r = w.run('install.sh', { FAKE_BILLING: 'False' });
        assert.equal(r.code, 1); assert.match(r.out, /no billing account is linked/);
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), SETTINGS + 'ALERT_EMAIL=off\n');
        r = w.run('install.sh');
        assert.equal(r.code, 0, r.out);
        assert.ok(!has(r.calls, /monitoring channels/)); assert.match(r.out, /Alerts: not emailed \(ALERT_EMAIL=off\)/);
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), SETTINGS + 'ALERT_EMAIL=not-an-address\n');
        r = w.run('install.sh');
        assert.equal(r.code, 1); assert.match(r.out, /ALERT_EMAIL must be an email address/);
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), SETTINGS + 'SURPRISE=1\n');
        assert.match(w.run('install.sh').out, /unknown setting 'SURPRISE'/);
    } finally { w.cleanup(); }
    w = workspace(undefined, fs.readFileSync(path.join(ROOT, 'deploy', 'settings.example.env'), 'utf8'));
    try { const r = w.run('install.sh'); assert.equal(r.code, 1); assert.match(r.out, /still has the example values/); } finally { w.cleanup(); }
});

test('upgrade.sh: finds the old settings, adds new ones empty, says what\'s new, installs without stopping; stop.sh reads settings with spaces', { skip: !hasBash }, () => {
    const w = workspace('spruce-mail-protection-0.3.0', null);
    try {
        const old = path.join(w.home, 'spruce-mail-protection-0.2.14', 'deploy');
        fs.mkdirSync(old, { recursive: true });
        fs.writeFileSync(path.join(old, 'settings.env'), SETTINGS);
        const r = w.run('upgrade.sh', { FAKE_INSTALLED: '0.2.14' });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /Settings copied from .*spruce-mail-protection-0\.2\.14\/deploy\/settings\.env/);
        assert.match(r.out, /New settings in \d+\.\d+\.\d+, added empty \(defaults\): .*ALERT_EMAIL/);
        assert.match(r.out, /0\.2\.14 -> \d+\.\d+\.\d+/);
        const settings = fs.readFileSync(path.join(w.dir, 'deploy', 'settings.env'), 'utf8');
        assert.match(settings, /^CAMPAIGN_HOLD_AFTER=$/m); assert.match(settings, /^ALERT_EMAIL=$/m);
        assert.ok(has(r.calls, /run deploy spruce-worker/), 'installed');
        assert.match(r.out, /upgrade: not waiting/);
        // stop.sh with "KEY = value " settings.
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), 'PROJECT = test-proj \nREGION=us-east1  \n');
        const s = w.run('stop.sh');
        assert.equal(s.code, 0, s.out);
        assert.ok(has(s.calls, /^gcloud config set project test-proj --quiet$/));
        assert.ok(has(s.calls, /scheduler jobs pause spruce-renew-watches --location=us-east1 /));
    } finally { w.cleanup(); }
});
