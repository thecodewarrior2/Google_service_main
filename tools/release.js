#!/usr/bin/env node
'use strict';
// The install zip (docs/INSTALL.md): build/spruce-mail-protection-<version>.zip, holding exactly the
// committed files of HEAD in a folder of the same name. Refuses uncommitted changes, so the zip is
// always a commit you can point to.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) { console.error('Commit or stash your changes first: the zip is made from a commit.'); process.exit(1); }
const version = require('../package.json').version;
const name = `spruce-mail-protection-${version}`;
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const out = path.join(root, 'build', `${name}.zip`);
git('archive', '--format=zip', `--prefix=${name}/`, '-o', out, 'HEAD');
console.log(`${out} (${Math.round(fs.statSync(out).size / 1024)} KB, commit ${git('rev-parse', '--short', 'HEAD')})`);
