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
    fs.mkdirSync(path.join(dir, 'vendor', 'spruce'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'vendor', 'spruce', 'VENDOR.json'), path.join(dir, 'vendor', 'spruce', 'VENDOR.json'));
    if (settings !== null) fs.writeFileSync(path.join(dir, 'deploy', 'settings.env'), settings);
    // (curl too: the scripts read Firestore's REST API, which the stand-in answers; nothing reaches Google)
    for (const f of ['gcloud', 'docker', 'curl']) { fs.copyFileSync(path.join(FAKEBIN, f), path.join(bin, f)); fs.chmodSync(path.join(bin, f), 0o755); }
    const run = (script, env = {}, args = []) => {
        const log = path.join(fake, 'calls.log');
        fs.writeFileSync(log, '');
        const r = spawnSync('bash', [path.join('deploy', script), ...args], { cwd: dir, encoding: 'utf8', input: '',
            env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_LOG: log, FAKE_DIR: fake, SPRUCE_WAIT_STEP: '0', SPRUCE_STOP_WAIT: '0' }, env) });
        return { code: r.status, out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''), calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
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

test('install.sh: the same files again reuse the image (a settings change only redeploys); jobs run in TIME_ZONE; services are labelled', { skip: !hasBash }, () => {
    const w = workspace();
    try {
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), SETTINGS + 'TIME_ZONE=America/New_York\n');
        let r = w.run('install.sh', { FAKE_IMAGE: 'exists' });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /These files were built before: using that image/);
        assert.ok(!has(r.calls, /docker build|builds submit/), 'nothing built');
        assert.ok(has(r.calls, /run deploy spruce-worker --image=us-east1-docker\.pkg\.dev\/test-proj\/spruce\/mail-protection:\d+\.\d+\.\d+-src[0-9a-f]{12} /));
        assert.ok(has(r.calls, /run deploy spruce-worker .*--update-labels=spruce-version=\d+-\d+-\d+,spruce-model=\d+-\d+-\d+/));
        assert.ok(has(r.calls, /jobs create http spruce-renew-watches .*--time-zone=America\/New_York/));
        assert.match(r.out, /spruce-renew-watches \(17 3 \* \* \*, America\/New_York\)/);
        r = w.run('install.sh', { FAKE_IMAGE: 'exists', FORCE_BUILD: '1' });
        assert.ok(has(r.calls, /docker build/), 'FORCE_BUILD builds anyway');
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), SETTINGS + 'TIME_ZONE=Eastern\n');
        r = w.run('install.sh');
        assert.equal(r.code, 1); assert.match(r.out, /TIME_ZONE must be a time zone name/);
    } finally { w.cleanup(); }
});

test('doctor.sh: everything working, then each problem with what to do; read-only', { skip: !hasBash }, () => {
    const w = workspace();
    try {
        let r = w.run('doctor.sh');
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /Everything checked works/);
        assert.equal((r.out.match(/ OK /g) || []).length, 11, r.out);
        assert.ok(!r.calls.some(c => /\b(create|update|delete|add-iam-policy-binding|remove-iam-policy-binding|deploy|enable|run spruce|pause|resume)\b/.test(c.replace(/^gcloud config set .*/, ''))), 'it changes nothing');
        r = w.run('doctor.sh', { FAKE_IAP: 'on', FAKE_INVOKER: 'missing', FAKE_SUB: 'wrong', FAKE_ALERTS: 'no', FAKE_ERRORS: '3', FAKE_JOB: 'refused', FAKE_ADMIN_VERSION: '0.1.0' });
        assert.equal(r.code, 1);
        for (const re of [/Identity-Aware Proxy is ON for spruce-worker.*\n.*--no-iap/, /spruce-invoker may not call the worker/, /The Pub\/Sub subscription doesn't match the worker/,
            /The job spruce-renew-watches's last run didn't reach the worker \(status 2\)/, /The alert policies are missing \(0 of 2\)/, /3 errors in the worker's log/, /The worker runs 0\.2\.14 and the dashboard 0\.1\.0/]) assert.match(r.out, re);
        assert.match(r.out, /7 to fix/);
    } finally { w.cleanup(); }
});

test('update.sh: fetches the newest approved version, unpacks it next to this folder, and upgrades from it; nothing when already newest', { skip: !hasBash }, () => {
    const w = workspace('spruce-mail-protection-0.2.14');
    try {
        // A stand-in for the approved releases' repository, at a newer version.
        const rel = path.join(w.home, 'releases-src'), bare = path.join(w.home, 'releases.git');
        fs.mkdirSync(path.join(rel, 'deploy'), { recursive: true }); fs.mkdirSync(path.join(rel, 'vendor', 'spruce'), { recursive: true });
        for (const f of fs.readdirSync(path.join(ROOT, 'deploy'))) if (f !== 'settings.env') fs.copyFileSync(path.join(ROOT, 'deploy', f), path.join(rel, 'deploy', f));
        fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(rel, 'CHANGELOG.md'));
        fs.copyFileSync(path.join(ROOT, 'vendor', 'spruce', 'VENDOR.json'), path.join(rel, 'vendor', 'spruce', 'VENDOR.json'));
        fs.writeFileSync(path.join(rel, 'package.json'), JSON.stringify({ name: 'spruce-gmail-service', version: '9.9.0' }, null, 2));
        fs.writeFileSync(path.join(w.dir, 'package.json'), JSON.stringify({ name: 'spruce-gmail-service', version: '0.2.14' }, null, 2));
        const git = (...a) => { const x = spawnSync('git', a, { cwd: rel, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.example' }) }); assert.equal(x.status, 0, x.stderr); return x; };
        git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'release 9.9.0');
        assert.equal(spawnSync('git', ['clone', '-q', '--bare', rel, bare]).status, 0);
        // (the installed services carry the vendored model's label: the same model)
        const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'spruce', 'VENDOR.json'), 'utf8')).model;
        const r = w.run('update.sh', { SPRUCE_RELEASES: `file://${bare}`, FAKE_MODEL: model.replace(/\./g, '-') });
        assert.equal(r.code, 0, r.out);
        const dest = path.join(w.home, 'spruce-mail-protection-9.9.0');
        assert.match(r.out, /Unpacked 9\.9\.0 in .*spruce-mail-protection-9\.9\.0/);
        assert.ok(fs.existsSync(path.join(dest, 'deploy', 'settings.env')), 'the settings were copied over');
        assert.match(r.out, /Upgrade S\.P\.R\.U\.C\.E\+ Mail Protection in test-proj \(us-east1\): 0\.2\.14 -> 9\.9\.0/);
        assert.match(r.out, new RegExp(`AI model \\(phish-tiny\\): ${model.replace(/\./g, '\\.')} -> ${model.replace(/\./g, '\\.')} \\(the same\\)`));
        assert.ok(has(r.calls, /run deploy spruce-worker/));
        // From the new folder: already the newest.
        const again = spawnSync('bash', [path.join(dest, 'deploy', 'update.sh')], { cwd: dest, encoding: 'utf8', env: Object.assign({}, process.env, { SPRUCE_RELEASES: `file://${bare}` }) });
        assert.equal(again.status, 0); assert.match(again.stdout, /already 9\.9\.0, the newest approved version/);
    } finally { w.cleanup(); }
});

test('clear-data.sh: deletes only what the dashboard shows, says who did it in Activity, restarts the dashboard; refuses when something is held', { skip: !hasBash }, () => {
    const w = workspace('spruce-mail-protection-0.3.4');
    fs.copyFileSync(path.join(FAKEBIN, 'curl'), path.join(w.home, 'bin', 'curl')); fs.chmodSync(path.join(w.home, 'bin', 'curl'), 0o755);
    const event = () => JSON.parse(fs.readFileSync(path.join(w.fake, 'event.json'), 'utf8')).fields;
    const deletes = (r) => r.calls.filter(c => /firestore bulk-delete/.test(c));
    try {
        // Without a terminal and without --yes: nothing happens.
        let r = w.run('clear-data.sh');
        assert.equal(r.code, 1); assert.match(r.out, /add --yes/); assert.equal(deletes(r).length, 0);
        assert.match(r.out, /Deleted: every recorded email/); assert.match(r.out, /Kept: {4}the watched mailboxes/);
        // The usual run.
        r = w.run('clear-data.sh', {}, ['--yes']);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(deletes(r), ["gcloud firestore bulk-delete --database=(default) --collection-ids=records,stats,campaigns,moveCounts,events --quiet"]);
        assert.ok(!has(r.calls, /DELETE .*installedAt/), 'the clock stays');
        const e = event();
        assert.equal(e.kind.stringValue, 'clear');
        assert.ok(Math.abs(Number(e.at.integerValue) - Date.now()) < 60000, 'at: now, in milliseconds');
        assert.match(e.text.stringValue, /^it\.admin@district-test\.example cleared the dashboard's data \(deploy\/clear-data\.sh\): the recorded emails, daily counts and campaign decisions, and Activity before this\. Watched mailboxes and settings were kept\.$/);
        assert.ok(has(r.calls, /run services update spruce-admin --region=us-east1 --update-env-vars=SPRUCE_RESTARTED=\d+ --quiet/), 'the dashboard restarts');
        // The Activity entry comes after the deletion (or it would be deleted too).
        const at = (re) => r.calls.findIndex(c => re.test(c));
        assert.ok(at(/bulk-delete/) < at(/curl .*-X POST .*\/documents\/events/));
        // --keep-activity, --reset-clock; no account known.
        r = w.run('clear-data.sh', { FAKE_ACCOUNT: '' }, ['--yes', '--keep-activity', '--reset-clock']);
        assert.equal(r.code, 0, r.out);
        assert.match(deletes(r)[0], /--collection-ids=records,stats,campaigns,moveCounts --quiet$/);
        assert.ok(has(r.calls, /curl .*-X DELETE .*\/documents\/state\/installedAt$/));
        assert.match(event().text.stringValue, /^Someone in Cloud Shell cleared .*campaign decisions; the monitor-mode clock restarts\./);
        // Paused: the brake, or campaigns waiting for a decision. Refused unless --even-if-paused (or its old name).
        r = w.run('clear-data.sh', { FAKE_BRAKE: 'on' }, ['--yes']);
        assert.equal(r.code, 1); assert.match(r.out, /The brake is on/); assert.match(r.out, /add --even-if-paused/); assert.equal(deletes(r).length, 0);
        r = w.run('clear-data.sh', { FAKE_BRAKE: 'resumed' }, ['--yes']);
        assert.equal(r.code, 0, `a resumed brake isn't held: ${r.out}`);
        r = w.run('clear-data.sh', { FAKE_BRAKE: 'error' }, ['--yes']);
        assert.equal(r.code, 1); assert.match(r.out, /Couldn't check whether the brake/); assert.equal(deletes(r).length, 0);
        r = w.run('clear-data.sh', { FAKE_HELD: '2' }, ['--yes']);
        assert.equal(r.code, 1); assert.match(r.out, /Moving is paused for 2 campaign\(s\), waiting for a decision/); assert.equal(deletes(r).length, 0);
        r = w.run('clear-data.sh', { FAKE_HELD: '2' }, ['--yes', '--even-if-held']);
        assert.equal(r.code, 0, r.out); assert.equal(deletes(r).length, 1);
        assert.equal(w.run('clear-data.sh', {}, ['--everything']).code, 1, 'an unknown option stops it');
        // Every bulk-delete the deploy scripts make names its collections (without them it deletes all).
        for (const f of fs.readdirSync(path.join(ROOT, 'deploy')).filter(x => x.endsWith('.sh'))) {
            for (const line of fs.readFileSync(path.join(ROOT, 'deploy', f), 'utf8').split('\n').filter(l => /^\s*gcloud firestore bulk-delete/.test(l))) assert.match(line, /--collection-ids=/, `${f}: ${line}`);
        }
    } finally { w.cleanup(); }
});

test('the dashboard\'s policy changes when installing: taken where settings.env is silent, asked about where they differ, written into settings.env, then removed', { skip: !hasBash }, () => {
    const w = workspace('spruce-mail-protection-0.3.6');
    const settings = () => fs.readFileSync(path.join(w.dir, 'deploy', 'settings.env'), 'utf8');
    const envOf = (svc) => fs.readFileSync(path.join(w.fake, `env-${svc}.yaml`), 'utf8');
    const event = () => JSON.parse(fs.readFileSync(path.join(w.fake, 'event.json'), 'utf8')).fields.text.stringValue;
    // The dashboard switched to enforce (settings.env says monitor), and set a threshold and a time zone
    // settings.env doesn't set.
    const dash = { FAKE_POLICY_mode: 'enforce|monitor', FAKE_POLICY_aiThreshold: '0.9|0.85', FAKE_POLICY_aiSuspicious: '0.7|0.65', FAKE_POLICY_timeZone: 'America/Chicago|UTC' };
    try {
        // Nothing changed on the dashboard: nothing asked, removed or noted.
        let r = w.run('install.sh');
        assert.equal(r.code, 0, r.out);
        assert.doesNotMatch(r.out, /dashboard and/); assert.ok(!has(r.calls, /curl .*-X (DELETE|POST)/));
        // upgrade.sh says what the installer will take and ask; without a terminal the dashboard's are kept.
        r = w.run('upgrade.sh', dash);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /Mode now: enforce \(set on the dashboard; settings\.env says monitor\)/);
        assert.match(r.out, /The dashboard and settings\.env differ on the mode: enforce on the dashboard \(by it\.head@district-test\.example, \d{4}-\d\d-\d\d\), monitor in settings\.env\. The installer asks which to keep\./);
        assert.match(r.out, /The AI move threshold comes from the dashboard \(90%, changed by it\.head@district-test\.example, \d{4}-\d\d-\d\d\): settings\.env doesn't set it\./);
        assert.match(r.out, /The dashboard and deploy\/settings\.env say different things:\n {4}mode {15}on the dashboard: enforce \(changed by it\.head@district-test\.example, [\d-]+\); in settings\.env: monitor/);
        assert.match(r.out, /No terminal to ask in: keeping the dashboard's/);
        assert.match(r.out, /Keeping the dashboard's mode: enforce \(now in deploy\/settings\.env too\)/);
        assert.match(r.out, /The time zone comes from the dashboard: America\/Chicago/);
        assert.match(settings(), /^MODE=enforce$/m); assert.match(settings(), /^AI_MOVE_THRESHOLD=0\.9$/m); assert.match(settings(), /^TIME_ZONE=America\/Chicago$/m);
        assert.match(settings(), /^AI_SUSPICIOUS_THRESHOLD=0\.7$/m); assert.match(envOf('spruce-worker'), /^AI_SUSPICIOUS_THRESHOLD: "0\.7"$/m);
        assert.match(r.out, /The AI suspicious line comes from the dashboard: 70%/);
        for (const svc of ['spruce-worker', 'spruce-admin']) { assert.match(envOf(svc), /^MODE: "enforce"$/m); assert.match(envOf(svc), /^AI_MOVE_THRESHOLD: "0\.9"$/m); assert.match(envOf(svc), /^TIME_ZONE: "America\/Chicago"$/m); }
        assert.ok(has(r.calls, /scheduler jobs create http spruce-renew-watches .*--time-zone=America\/Chicago/), 'the jobs in the dashboard\'s time zone');
        assert.match(r.out, /Mode: {7}enforce\n/);
        // The dashboard's copies go only after both services are deployed (until then they are in force).
        const at = (re) => r.calls.findIndex(c => re.test(c));
        for (const k of ['mode', 'aiThreshold', 'timeZone']) assert.ok(at(new RegExp(`curl .*-X DELETE .*/state/policy-${k}$`)) > at(/run deploy spruce-admin/), k);
        assert.match(event(), /^it\.admin@district-test\.example installed \d+\.\d+\.\d+ with deploy\/install\.sh; settings\.env now holds the policy: kept the dashboard's mode \(enforce\) over settings\.env's \(monitor\); took the dashboard's AI move threshold \(90%\), which settings\.env didn't set; took the dashboard's AI suspicious line \(70%\), which settings\.env didn't set; took the dashboard's time zone \(America\/Chicago\), which settings\.env didn't set\.$/);

        // The same differences again, choosing settings.env's (SPRUCE_SETTINGS=file).
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), SETTINGS);
        r = w.run('install.sh', Object.assign({ SPRUCE_SETTINGS: 'file' }, dash));
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /Using settings\.env's mode: monitor \(the dashboard's enforce is removed once this version is deployed\)/);
        assert.match(settings(), /^MODE=monitor$/m); assert.match(envOf('spruce-worker'), /^MODE: "monitor"$/m);
        assert.ok(has(r.calls, /curl .*-X DELETE .*\/state\/policy-mode$/));
        assert.match(event(), /used settings\.env's mode \(monitor\) over the dashboard's \(enforce\)/);
        // When the dashboard's copy can't be removed, it says what stays in force.
        r = w.run('install.sh', Object.assign({ SPRUCE_SETTINGS: 'file', FAKE_DELETE: 'refused' }, dash));
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /Couldn't remove the dashboard's copy of: MODE AI_MOVE_THRESHOLD AI_SUSPICIOUS_THRESHOLD TIME_ZONE\. Where you chose settings\.env's, the dashboard's stays in force/);
        // The same value on both sides: nothing to ask.
        r = w.run('install.sh', { FAKE_POLICY_mode: 'monitor|enforce' });
        assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /say different things/);
        // The allowlists: compared as lists (order and case aside), taken where settings.env has none.
        fs.writeFileSync(path.join(w.dir, 'deploy', 'settings.env'), `${SETTINGS}ALLOW_DOMAINS=Vendor.example;news.example\n`);
        r = w.run('install.sh', { FAKE_POLICY_allowDomains: 'news.example,vendor.example|', FAKE_POLICY_allowAddresses: 'billing@vendor.example,a&b@bus.example|' });
        assert.equal(r.code, 0, r.out);
        assert.doesNotMatch(r.out, /say different things/, 'the same domains in another order and case');
        assert.match(r.out, /The allowlisted addresses come from the dashboard/);
        assert.match(settings(), /^ALLOW_ADDRESSES=a&b@bus\.example,billing@vendor\.example$/m, 'written as it is (& kept)');
        assert.match(envOf('spruce-worker'), /^ALLOW_ADDRESSES: "a&b@bus\.example,billing@vendor\.example"$/m);
    } finally { w.cleanup(); }
});
