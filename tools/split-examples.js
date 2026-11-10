#!/usr/bin/env node
// Splits a checked retraining file into the examples to train on and the ones kept aside to measure the
// new model with (docs/RETRAINING.md, step 6): every third email of each kind (phishing, genuine) is held
// out. Variants of one email (names ending -v1, -v2…) stay together, on the same side, or the score
// would be measured on emails the model has already seen.
//
//     node tools/split-examples.js spruce-retraining-2026-11-10.jsonl
//     → spruce-retraining-2026-11-10-train.jsonl, spruce-retraining-2026-11-10-held-out.jsonl
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('Usage: node tools/split-examples.js FILE.jsonl'); process.exit(2); }
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
const emailOf = (r) => String(r.name || '').replace(/-v\d+$/, '');
const held = new Set();
for (const label of [1, 0]) {
    const emails = [...new Set(rows.filter(r => r.label === label).map(emailOf))];
    emails.forEach((e, i) => { if (i % 3 === 2) held.add(e); });
}
const base = file.replace(/\.jsonl$/, '');
const write = (f, rs) => fs.writeFileSync(f, rs.map(r => JSON.stringify(r)).join('\n') + (rs.length ? '\n' : ''));
const train = rows.filter(r => !held.has(emailOf(r))), out = rows.filter(r => held.has(emailOf(r)));
write(`${base}-train.jsonl`, train);
write(`${base}-held-out.jsonl`, out);
const kinds = (rs) => `${rs.filter(r => r.label === 1).length} phishing, ${rs.filter(r => r.label === 0).length} genuine`;
console.log(`${base}-train.jsonl: ${train.length} (${kinds(train)}). ${base}-held-out.jsonl: ${out.length} (${kinds(out)}): never train on these.`);
