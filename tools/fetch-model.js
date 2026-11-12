#!/usr/bin/env node
'use strict';
// tools/fetch-model.js — downloads the AI model (phish-tiny) from TinyPhishLLM, the model's own public
// repository, at the commit vendor/spruce/VENDOR.json pins ("modelSource"), and checks each file's SHA-256.
//
//     node tools/fetch-model.js                  download what is missing or different (npm test does this first)
//     node tools/fetch-model.js --from <folder>  take the files from a TinyPhishLLM checkout instead (offline)
//     node tools/fetch-model.js --check          download nothing: exit 1 if a file is missing or different
//
// The model's files are not kept in this repository: every build of the image downloads them here
// (Dockerfile: install.sh, update.sh, upgrade.sh and Settings → Update all build it), so the model always
// comes from TinyPhishLLM, at exactly the commit and bytes this version was tested and approved with. A
// file whose SHA-256 differs is never used: the download (or the build) stops. Nothing else is sent:
// a plain request for a public file, with no token and nothing about this installation.
// SPRUCE_MODEL_BASE replaces https://raw.githubusercontent.com/<owner>/<repo> (a mirror; the tests).
// Self-contained (Node's own modules only): the Dockerfile runs it before anything else is installed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_FILE = path.join(ROOT, 'vendor', 'spruce', 'VENDOR.json');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The files to download: modelSource.files entries under vendor/ (the references in test/fixtures are
// kept in the repository; the tests check those against the same hashes).
function plan(vendor = JSON.parse(fs.readFileSync(VENDOR_FILE, 'utf8'))) {
    const src = vendor.modelSource;
    if (!src || !/^[0-9a-f]{40}$/.test(String(src.commit || '')) || !src.files) throw new Error('vendor/spruce/VENDOR.json has no modelSource (run node tools/sync-model.js <TinyPhishLLM folder>)');
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(src.repository || ''));
    if (!m) throw new Error(`modelSource.repository isn't a GitHub repository: ${src.repository}`);
    const files = Object.entries(src.files).filter(([to]) => to.startsWith('vendor/')).map(([to, f]) => ({ to, from: f.from, sha256: f.sha256 }));
    if (!files.length || files.some(f => !f.from || !/^[0-9a-f]{64}$/.test(f.sha256) || f.to.includes('..') || f.from.includes('..'))) throw new Error('modelSource.files is incomplete');
    return { repository: src.repository, owner: m[1], repo: m[2], commit: src.commit, files };
}

const matches = (file, hash) => { try { return sha256(fs.readFileSync(file)) === hash; } catch (e) { return false; } };

async function download(url) {
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'user-agent': 'spruce-mail-protection' }, signal: AbortSignal.timeout(120000) });
            if (res.ok) return Buffer.from(await res.arrayBuffer());
            last = new Error(`HTTP ${res.status}`);
            if (res.status === 404) break;
        } catch (e) { last = e; }
        await new Promise(r => setTimeout(r, 2000 * attempt));
    }
    throw new Error(`${url}: ${last && (last.cause && last.cause.code || last.message)}`);
}

async function fetchModel({ from = null, check = false, quiet = false, base = process.env.SPRUCE_MODEL_BASE, vendor, root: into = ROOT } = {}) {
    const p = plan(vendor);
    const say = (s, always) => { if (!quiet || always) console.log(s); };
    const root = base ? base.replace(/\/+$/, '') : `https://raw.githubusercontent.com/${p.owner}/${p.repo}`;
    let fetched = 0;
    for (const f of p.files) {
        const dest = path.join(into, f.to);
        if (matches(dest, f.sha256)) continue;
        if (check) throw new Error(`${f.to} is missing or isn't TinyPhishLLM's (commit ${p.commit.slice(0, 7)}): run node tools/fetch-model.js`);
        const buf = from ? fs.readFileSync(path.join(path.resolve(from), f.from)) : await download(`${root}/${p.commit}/${f.from}`);
        if (sha256(buf) !== f.sha256) throw new Error(`${f.from} from ${from || root} (commit ${p.commit.slice(0, 7)}) has SHA-256 ${sha256(buf)}, not ${f.sha256}: not used`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(`${dest}.part`, buf);
        fs.renameSync(`${dest}.part`, dest);
        fetched++;
    }
    if (fetched) say(`phish-tiny: ${fetched} of ${p.files.length} files from ${from || p.repository} at ${p.commit.slice(0, 7)}, SHA-256 checked.`, true);
    else say(`phish-tiny: all ${p.files.length} files are TinyPhishLLM's at ${p.commit.slice(0, 7)} (SHA-256 checked).`);
    return { fetched, files: p.files.length, commit: p.commit };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    fetchModel({ from: opt('--from'), check: args.includes('--check'), quiet: args.includes('--quiet') })
        .catch((e) => { console.error(`The AI model wasn't downloaded: ${e.message}`); process.exit(1); });
}
module.exports = { fetchModel, plan };
