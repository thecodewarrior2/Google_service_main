#!/usr/bin/env node
// Copies the S.P.R.U.C.E+ extension's checks and AI model into vendor/spruce/, and records where they
// came from (vendor/spruce/VENDOR.json). Run it when the extension's checks or model change, then run
// the tests (npm test), and commit both.
//
//     node tools/sync-engine.js ../spruce-browser-extension
//
// The files are copied unchanged: the service runs the extension's own code, so both judge an email
// the same way.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILES = ['shared.js', 'decoders.js', 'ai.js', 'models/phish-tiny/model.bin', 'models/phish-tiny/model.json', 'models/phish-tiny/vocab.txt', 'models/phish-tiny/MODEL_CARD.md'];
const src = path.resolve(process.argv[2] || '../spruce-browser-extension');
const dst = path.resolve(__dirname, '..', 'vendor', 'spruce');

if (!fs.existsSync(path.join(src, 'manifest.json'))) { console.error(`${src} is not the extension's folder (no manifest.json).`); process.exit(1); }
for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
let commit = '', branch = '';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: src }).toString().trim(); branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: src }).toString().trim(); } catch (e) { /* not a git checkout */ }
const info = { extensionVersion: JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')).version, commit, branch,
               model: JSON.parse(fs.readFileSync(path.join(src, 'models/phish-tiny/model.json'), 'utf8')).version, files: FILES, synced: new Date().toISOString().slice(0, 10) };
fs.writeFileSync(path.join(dst, 'VENDOR.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`Copied ${FILES.length} files from S.P.R.U.C.E+ ${info.extensionVersion} (${branch} ${commit}), model ${info.model}. Now run: npm test`);
