#!/usr/bin/env node
'use strict';
// tools/sync-model.js — moves the service to a model of TinyPhishLLM, the AI model's own public repository,
// which the S.P.R.U.C.E+ browser extension uses too (one model, trained in one place; the training itself
// is in the private TinyPhishLLM_Private_Training).
//
//     node tools/sync-model.js <TinyPhishLLM folder>
//
// The folder must be a clean checkout (no uncommitted changes) at a commit that is on TinyPhishLLM's main
// branch on GitHub (the service downloads the model from there). This:
//   1. runs TinyPhishLLM's own check (tools/check.js);
//   2. checks that the service builds the model's input exactly as the model was trained
//      (modelInputText in vendor/spruce/ai.js against TinyPhishLLM's model/reference/input-format.jsonl);
//      if it doesn't, nothing changes: change vendor/spruce/ai.js first (TinyPhishLLM's changelog says
//      how the format changed);
//   3. pins the model in vendor/spruce/VENDOR.json: "model" (the version, which install and update show)
//      and "modelSource" (the repository, the commit, and each file's SHA-256). The model's files are not
//      committed: tools/fetch-model.js downloads them at that commit when the image is built or the tests
//      run, and stops if a file's SHA-256 differs;
//   4. copies the references the tests use (committed, the same hashes in modelSource):
//        model/reference/model-reference.json  -> test/fixtures/model-reference.json
//        model/reference/input-format.jsonl    -> test/fixtures/model-input-format.jsonl
//      and the model's files into vendor/spruce/models/phish-tiny/ (ignored by git), so the tests run.
// Then npm test, and the steps in CLAUDE.md (version, changelog, the maintainer's approval).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// [TinyPhishLLM path, this repository's path]. Under vendor/: downloaded (tools/fetch-model.js), not committed.
const FILES = [
    ['model/phish-tiny/model.onnx', 'vendor/spruce/models/phish-tiny/model.onnx'],
    ['model/phish-tiny/model.json', 'vendor/spruce/models/phish-tiny/model.json'],
    ['model/phish-tiny/vocab.txt', 'vendor/spruce/models/phish-tiny/vocab.txt'],
    ['model/phish-tiny/MODEL_CARD.md', 'vendor/spruce/models/phish-tiny/MODEL_CARD.md'],
    ['model/reference/model-reference.json', 'test/fixtures/model-reference.json'],
    ['model/reference/input-format.jsonl', 'test/fixtures/model-input-format.jsonl']
];
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (msg) => { console.error(`Not synced: ${msg}`); process.exit(1); };

// The service's own copy of the input format (vendor/spruce), loaded as src/engine/spruce.js loads it.
function serviceModelInputText() {
    const ctx = { console, URL, URLSearchParams, TextDecoder, TextEncoder, atob, btoa, setTimeout, clearTimeout, Intl, BigInt,
                  chrome: { runtime: { id: 'spruce-service', getURL: (p) => p, lastError: null } } };
    vm.createContext(ctx);
    for (const f of ['shared.js', 'ai.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'vendor', 'spruce', f), 'utf8'), ctx, { filename: `vendor/spruce/${f}` });
    return ctx.modelInputText;
}

function main() {
    const src = process.argv[2] ? path.resolve(process.argv[2]) : fail('give the TinyPhishLLM folder: node tools/sync-model.js <folder>');
    const git = (...a) => execFileSync('git', a, { cwd: src }).toString().trim();
    let commit;
    try { commit = git('rev-parse', 'HEAD'); } catch (e) { fail(`${src} is not a git checkout of TinyPhishLLM.`); }
    if (git('status', '--porcelain', '--untracked-files=no')) fail(`${src} has uncommitted changes: sync from a commit.`);
    let repository = '';
    try { repository = git('remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^https:\/\/[^@/]*@/, 'https://').replace(/^git@github\.com:/, 'https://github.com/'); } catch (e) { /* no remote */ }
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository)) fail(`${src}'s origin isn't TinyPhishLLM on GitHub (${repository || 'none'}): the service downloads the model from there.`);
    try { git('fetch', '-q', 'origin', 'main'); } catch (e) { fail(`couldn't read TinyPhishLLM's main branch from GitHub (${repository}): the service downloads the model from there.`); }
    try { git('merge-base', '--is-ancestor', commit, 'FETCH_HEAD'); } catch (e) { fail(`commit ${commit.slice(0, 7)} isn't on TinyPhishLLM's main branch on GitHub: push it there first (the service downloads it from there).`); }

    // 1. TinyPhishLLM's own check.
    try { execFileSync(process.execPath, [path.join(src, 'tools', 'check.js')], { cwd: src, stdio: 'pipe' }); }
    catch (e) { fail(`TinyPhishLLM's tools/check.js failed:\n${(e.stdout || '').toString()}`); }

    // 2. The service's input format against the model's.
    const modelInputText = serviceModelInputText();
    const cases = fs.readFileSync(path.join(src, 'model/reference/input-format.jsonl'), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const different = cases.filter(c => modelInputText(c.facts) !== c.text).map(c => c.name);
    if (different.length) fail(`vendor/spruce/ai.js builds a different input than the model was trained with (${different.length} of ${cases.length}: ${different.slice(0, 5).join(', ')}).`);

    // 3. Pin, 4. copy.
    const files = {};
    for (const [from, to] of FILES) {
        fs.mkdirSync(path.dirname(path.join(ROOT, to)), { recursive: true });
        fs.copyFileSync(path.join(src, from), path.join(ROOT, to));
        files[to] = { from, sha256: sha256(path.join(ROOT, to)) };
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(src, 'model/phish-tiny/model.json'), 'utf8'));
    const vendorFile = path.join(ROOT, 'vendor', 'spruce', 'VENDOR.json');
    const vendor = JSON.parse(fs.readFileSync(vendorFile, 'utf8'));
    vendor.model = manifest.version;
    vendor.modelSource = { repository, commit, synced: new Date().toISOString().slice(0, 10),
        note: 'The files under vendor/ are downloaded from the repository at this commit when the image is built or the tests run (tools/fetch-model.js) and used only with these SHA-256; they are not in this repository. The test/fixtures references are copied here.',
        files };
    fs.writeFileSync(vendorFile, JSON.stringify(vendor, null, 2) + '\n');
    console.log(`Pinned phish-tiny ${manifest.version} from ${repository} at ${commit.slice(0, 7)}: ${FILES.length} files; the input format matches on all ${cases.length} cases.`);
}

if (require.main === module) main();
module.exports = { serviceModelInputText, FILES };
