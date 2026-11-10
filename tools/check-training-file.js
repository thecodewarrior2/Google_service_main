#!/usr/bin/env node
// Checks a retraining file (the dashboard's "Download for retraining", or one you wrote) before it goes
// anywhere, and before training. docs/RETRAINING.md says when to run it.
//
//     node tools/check-training-file.js spruce-retraining-2026-11-10.jsonl           (after your review)
//     node tools/check-training-file.js --final spruce-retraining-2026-11-10.jsonl   (before training)
//
// It refuses (exit code 1) a file with:
//   - a word still marked ⟦like this⟧ (a possible name nobody decided on);
//   - an email address, a phone number or a long number (an account, card, student ID, code);
//   - a line that isn't one example: { "name", "label": 0 | 1, "facts": {…} } (a "text" field too, which
//     make-dataset.js would use instead of the facts);
//   - with --final: a placeholder ([NAME], [SENDER], [OUR-DOMAIN], [SCHOOL], [PLACE]) not yet replaced by
//     a made-up one.
// It also says how many are phishing and how many genuine, and which names repeat (the same email twice).
// It can't see a name it doesn't know: it doesn't replace reading every example yourself.
'use strict';
const fs = require('fs');
const { problems } = require('../src/training');

const args = process.argv.slice(2);
const final = args.includes('--final');
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('Usage: node tools/check-training-file.js [--final] FILE.jsonl'); process.exit(2); }

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
let bad = 0, n = 0, phishing = 0;
const names = new Map();
lines.forEach((line, i) => {
    if (!line.trim()) return;
    n++;
    let x;
    try { x = JSON.parse(line); } catch (e) { console.log(`line ${i + 1}: not JSON (${e.message})`); bad++; return; }
    const p = problems(x, { final });
    if (x && x.label === 1) phishing++;
    if (x && x.name) names.set(x.name, (names.get(x.name) || 0) + 1);
    if (p.length) { bad++; console.log(`line ${i + 1}${x && x.name ? ` (${x.name})` : ''}:\n  - ${p.join('\n  - ')}`); }
});
const twice = [...names].filter(([, c]) => c > 1).map(([k]) => k);
if (twice.length) console.log(`The same example more than once: ${twice.join(', ')}. Keep one of each (variants you wrote need names of their own).`);
console.log(`${n} examples: ${phishing} phishing, ${n - phishing} genuine.${n && Math.min(phishing, n - phishing) / n < 0.25 ? ' Mostly one kind: see "Keep the two kinds balanced" in docs/RETRAINING.md.' : ''}`);
if (bad) { console.log(`${bad} example${bad === 1 ? ' needs' : 's need'} fixing (or leave ${bad === 1 ? 'it' : 'them'} out).`); process.exit(1); }
console.log(final ? 'Ready for training: copy it into the extension\'s tools/ai/data/extra/.' : 'No leftovers found. Read every example yourself as well: the check can\'t see a name it doesn\'t know.');
