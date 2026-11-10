#!/usr/bin/env node
// Scores a file of examples ({ "facts", "label" } per line, as the retraining export writes them) with
// the AI model in vendor/spruce/ (the one the service runs), at the service's move threshold. Run it on
// your held-out examples before and after a new model is synced (docs/RETRAINING.md, "Is the new model
// better?"): the false alarms and the missed phishing should go down, not up.
//
//     node tools/score-examples.js held-out.jsonl [--threshold 0.9]
'use strict';
const fs = require('fs');
const spruce = require('../src/engine/spruce');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const ti = args.indexOf('--threshold');
const threshold = ti >= 0 ? Number(args[ti + 1]) : Number(process.env.AI_MOVE_THRESHOLD || 0.9);
if (!file || !(threshold > 0 && threshold < 1)) { console.error('Usage: node tools/score-examples.js FILE.jsonl [--threshold 0.9]'); process.exit(2); }

const E = spruce.load();
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
let falseAlarms = 0, missed = 0, phishing = 0, genuine = 0;
const wrong = [];
for (const x of rows) {
    if (!x.facts || (x.label !== 0 && x.label !== 1)) continue;
    const p = E.model.analyze(x.facts).probability;
    if (x.label === 1) { phishing++; if (p < threshold) { missed++; wrong.push(`missed (${Math.round(p * 100)}%): ${x.name || x.facts.subject}`); } }
    else { genuine++; if (p >= threshold) { falseAlarms++; wrong.push(`false alarm (${Math.round(p * 100)}%): ${x.name || x.facts.subject}`); } }
}
const pc = (a, b) => (b ? `${Math.round(1000 * a / b) / 10}%` : '-');
console.log(`Model ${E.modelInfo.name} ${E.modelInfo.version}, threshold ${threshold}: ${phishing} phishing, ${genuine} genuine.`);
console.log(`Missed phishing: ${missed} (${pc(missed, phishing)}). False alarms: ${falseAlarms} (${pc(falseAlarms, genuine)}).`);
for (const w of wrong) console.log(`  ${w}`);
