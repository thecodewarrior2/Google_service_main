'use strict';
// The AI model comes from TinyPhishLLM, its own public repository: VENDOR.json pins the commit and each
// file's SHA-256 (tools/sync-model.js), tools/fetch-model.js downloads the files when the image is built or
// the tests run (npm test does it first), and the service must build the model's input exactly as the
// model was trained.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { serviceModelInputText, FILES } = require('../tools/sync-model');
const { fetchModel, plan } = require('../tools/fetch-model');

const ROOT = path.resolve(__dirname, '..');
const vendor = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'spruce', 'VENDOR.json'), 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('VENDOR.json pins the model to one commit of TinyPhishLLM, with every file\'s SHA-256', () => {
    const src = vendor.modelSource;
    assert.ok(src, 'VENDOR.json has no modelSource: run node tools/sync-model.js <TinyPhishLLM folder>');
    assert.match(src.repository, /^https:\/\/github\.com\/thecodewarrior2\/TinyPhishLLM$/i);
    assert.match(src.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(src.files).sort(), FILES.map(([, to]) => to).sort());
    for (const [from, to] of FILES) { assert.equal(src.files[to].from, from, to); assert.match(src.files[to].sha256, /^[0-9a-f]{64}$/, to); }
    const p = plan();
    assert.deepEqual(p.files.map(f => f.to).sort(), FILES.map(([, to]) => to).filter(t => t.startsWith('vendor/')).sort(), 'the model\'s files are downloaded');
});

test('the model\'s files are TinyPhishLLM\'s at the pinned commit (downloaded by npm test) and the references match', () => {
    for (const [to, f] of Object.entries(vendor.modelSource.files)) {
        const file = path.join(ROOT, to);
        assert.ok(fs.existsSync(file), `${to} is missing: node tools/fetch-model.js`);
        assert.equal(sha256(fs.readFileSync(file)), f.sha256, `${to} differs from TinyPhishLLM's: change the model there and run tools/sync-model.js`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/spruce/models/phish-tiny/model.json'), 'utf8'));
    assert.equal(vendor.model, manifest.version, 'VENDOR.json "model" is the pinned model\'s version (install and update show it)');
});

test('the model\'s files are not in this repository: git ignores them, the image downloads them', () => {
    const tracked = execFileSync('git', ['ls-files', 'vendor/spruce/models'], { cwd: ROOT }).toString().trim();
    assert.equal(tracked, '', 'no model file is committed');
    assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^vendor\/spruce\/models\/$/m);
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const fetchAt = docker.indexOf('RUN node tools/fetch-model.js');
    assert.ok(fetchAt > docker.indexOf('COPY vendor ./vendor') && fetchAt < docker.indexOf('USER node'), 'the build downloads the model after copying vendor/');
    assert.match(fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8'), /^!tools\/fetch-model\.js$/m, 'the download tool is in the build context');
    const pkg = require('../package.json');
    assert.match(pkg.scripts.pretest, /tools\/fetch-model\.js/);
});

test('tools/fetch-model.js downloads the pinned files, checks each SHA-256, and never keeps a different file', async () => {
    const commit = 'a'.repeat(40);
    const good = { 'model/phish-tiny/model.json': Buffer.from('{"version":"9.9.9"}'), 'model/phish-tiny/vocab.txt': Buffer.from('[PAD]\n[UNK]\n') };
    const served = { ...good };
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests++;
        const key = req.url.replace(`/${commit}/`, '');
        if (!req.url.startsWith(`/${commit}/`) || !served[key]) { res.writeHead(404); return res.end(); }
        res.writeHead(200); res.end(served[key]);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-fetch-'));
    const v = { modelSource: { repository: 'https://github.com/thecodewarrior2/TinyPhishLLM', commit, files: {
        'vendor/spruce/models/phish-tiny/model.json': { from: 'model/phish-tiny/model.json', sha256: sha256(good['model/phish-tiny/model.json']) },
        'vendor/spruce/models/phish-tiny/vocab.txt': { from: 'model/phish-tiny/vocab.txt', sha256: sha256(good['model/phish-tiny/vocab.txt']) },
        'test/fixtures/model-reference.json': { from: 'model/reference/model-reference.json', sha256: 'b'.repeat(64) } } } };
    try {
        const r = await fetchModel({ base, vendor: v, root: dir, quiet: true });
        assert.deepEqual([r.fetched, r.files], [2, 2], 'only the files under vendor/ are downloaded');
        assert.equal(fs.readFileSync(path.join(dir, 'vendor/spruce/models/phish-tiny/vocab.txt'), 'utf8'), '[PAD]\n[UNK]\n');
        requests = 0;
        assert.equal((await fetchModel({ base, vendor: v, root: dir, quiet: true })).fetched, 0);
        assert.equal(requests, 0, 'files already right are not downloaded again');
        // A file that differs (changed on the server, or by hand here) is never used.
        fs.writeFileSync(path.join(dir, 'vendor/spruce/models/phish-tiny/model.json'), 'edited');
        await assert.rejects(fetchModel({ vendor: v, root: dir, check: true, quiet: true }), /isn't TinyPhishLLM's/);
        served['model/phish-tiny/model.json'] = Buffer.from('{"version":"6.6.6"}');
        await assert.rejects(fetchModel({ base, vendor: v, root: dir, quiet: true }), /has SHA-256 [0-9a-f]{64}, not [0-9a-f]{64}: not used/);
        assert.equal(fs.readFileSync(path.join(dir, 'vendor/spruce/models/phish-tiny/model.json'), 'utf8'), 'edited', 'the wrong download wasn\'t written');
        assert.ok(!fs.existsSync(path.join(dir, 'vendor/spruce/models/phish-tiny/model.json.part')));
        served['model/phish-tiny/model.json'] = good['model/phish-tiny/model.json'];
        assert.equal((await fetchModel({ base, vendor: v, root: dir, quiet: true })).fetched, 1);
        // A commit that isn't pinned exactly, or a repository that isn't on GitHub, is refused.
        assert.throws(() => plan({ modelSource: { ...v.modelSource, commit: 'main' } }), /no modelSource/);
        assert.throws(() => plan({ modelSource: { ...v.modelSource, repository: 'https://example.com/x/y' } }), /isn't a GitHub repository/);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the model\'s input is built exactly as the model was trained (TinyPhishLLM\'s input-format reference)', () => {
    const modelInputText = serviceModelInputText();
    const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'model-input-format.jsonl'), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    assert.ok(rows.length > 50);
    for (const r of rows) assert.equal(modelInputText(r.facts), r.text, r.name);
});


test('0.5.26: Cloud Build gets every file the Dockerfile copies (.gcloudignore), as Docker does (.dockerignore)', () => {
    // install.sh builds with Docker, or with Cloud Build when Docker can't upload from Cloud Shell
    // (gcloud builds submit uploads what .gcloudignore lets through). Checked with git's matching, the same
    // syntax gcloud uses (a file inside an ignored folder can't be let back in).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spruce-gcloudignore-'));
    try {
        const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
        const sources = [...docker.matchAll(/^COPY\s+(.+)\s+\S+$/gm)].flatMap(m => m[1].split(/\s+/));
        assert.ok(sources.includes('tools/fetch-model.js') && sources.includes('src'), sources.join(' '));
        const files = [...sources.map(s => (/\.[a-z]+$|^\.npmrc$|^Dockerfile$/.test(s) ? s : `${s}/x.js`)), 'Dockerfile', 'tools/release.js', 'test/a.test.js', 'docs/a.md', 'deploy/install.sh', 'CHANGELOG.md', 'CLAUDE.md'];
        for (const f of files) { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'x'); }
        execFileSync('git', ['init', '-q'], { cwd: dir });
        const uploaded = execFileSync('git', ['ls-files', '-o', `--exclude-from=${path.join(ROOT, '.gcloudignore')}`], { cwd: dir }).toString().split('\n').filter(Boolean);
        for (const s of sources) assert.ok(uploaded.some(u => u === s || u.startsWith(`${s}/`)), `${s} is uploaded to Cloud Build`);
        for (const left of ['tools/release.js', 'test/a.test.js', 'deploy/install.sh', 'CHANGELOG.md', 'CLAUDE.md']) assert.ok(!uploaded.includes(left), `${left} is left out`);
        // (0.5.46) the docs and the README go up: the Help tab shows them
        for (const kept of ['docs/a.md', 'README.md']) assert.ok(uploaded.includes(kept), `${kept} is uploaded`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
