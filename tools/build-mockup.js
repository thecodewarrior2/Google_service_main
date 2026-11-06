#!/usr/bin/env node
// Builds the clickable mockup: ONE self-contained HTML file with the real dashboard (public/), the real
// dashboard numbers (src/dashboard/aggregate.js) and the demo data (src/demo/seed.js, all made up),
// with a stand-in for the service's API that runs in the page. Nothing is sent anywhere; Release and
// the marks change only the page's own copy of the data.
//
//     node tools/build-mockup.js [out.html]
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { buildDemo } = require('../src/demo/seed');
const spruce = require('../src/engine/spruce');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
    const out = path.resolve(process.argv[2] || path.join(ROOT, 'build', 'mockup.html'));
    const cfg = loadConfig({ DEMO: '1', MODE: 'enforce', ORG_DOMAINS: 'maple-schools.example', ADMIN_EMAILS: 'demo-admin@example.org' });
    const now = Date.now();
    const { store } = await buildDemo({ cfg, now });
    const E = spruce.load();
    const data = {
        now,
        records: await store.listRecords({ sinceMs: 0, limit: 100000 }),
        stats: await store.getStats('2000-01-01', '2999-12-31'),
        events: await store.listEvents(0),
        settings: { mode: cfg.mode, aiThreshold: cfg.aiThreshold, moveOnRules: cfg.moveOnRules, aiMovesInside: cfg.aiMovesInside, brakePerHour: cfg.brakePerHour,
                    orgDomains: ['maple-schools.example'], pilotOu: '/Staff', pilotUsers: 0, allowDomains: [], allowAddresses: 0, retentionDays: cfg.retentionDays,
                    storeSubjects: true, storeAiQuotes: true, movedLabel: cfg.movedLabel, model: E.modelInfo, engine: E.vendor, watched: (await store.listUsers()).length, demo: true }
    };
    // The API stand-in: the same routes and answers as src/server.js, over the data above.
    const fakeApi = `
(function () {
  const D = window.SPRUCE_DEMO_DATA, A = window.SpruceAggregate, ADMIN = 'demo-admin@example.org';
  const DAY = A.DAY;
  const brief = (r) => ({ key: r.key, user: r.user, processedAt: r.processedAt, sender: r.sender, subject: r.subject, campaign: r.campaign, status: r.status, score: r.score,
    ai: r.ai ? Math.round((r.ai.probability || 0) * 1000) / 1000 : null, action: r.action, trigger: r.trigger, state: r.state, falseAlarm: r.falseAlarm });
  const wait = () => new Promise(r => setTimeout(r, 120));
  window.SPRUCE_API = async function (p, opts) {
    await wait();
    const u = new URL(p, 'http://x'), q = u.searchParams, n = Math.min(90, Math.max(1, Number(q.get('days')) || 30)), now = Date.now();
    const recs = D.records, since = now - n * DAY;
    const base = { admin: ADMIN, demo: true };
    const body = (opts && opts.body) || {};
    switch (u.pathname) {
      case '/api/overview': return Object.assign(base, { summary: A.summary(recs, D.stats, now, n), trend: A.trend(recs, D.stats, now, n), topReasons: A.topReasons(recs, now, n).slice(0, 8),
        campaigns: A.campaigns(recs, now, n).slice(0, 5), alerts: D.events.filter(e => e.at >= now - 7 * DAY).sort((a, b) => b.at - a.at).slice(0, 10), brake: null, mode: D.settings.mode });
      case '/api/campaigns': return Object.assign(base, { campaigns: A.campaigns(recs, now, n) });
      case '/api/users': return Object.assign(base, { users: A.users(recs, now, n) });
      case '/api/messages': { const l = A.filterRecords(recs, { user: q.get('user') || '', campaign: q.get('campaign') || '', action: q.get('action') || '', state: q.get('state') || '', q: q.get('q') || '', since });
        return Object.assign(base, { total: l.length, messages: l.slice(0, 500).map(brief) }); }
      case '/api/message': { const r = recs.find(x => x.key === q.get('key')); if (!r) throw new Error('not found'); return Object.assign(base, { message: r }); }
      case '/api/health': return Object.assign(base, A.modelHealth(recs, now, n), { threshold: D.settings.aiThreshold });
      case '/api/settings': return Object.assign(base, D.settings);
      case '/api/release': { const r = recs.find(x => x.key === body.key); if (!r || r.state !== 'moved') throw new Error('it is not in Spam');
        Object.assign(r, { state: 'released', releasedBy: ADMIN, releasedAt: Date.now(), falseAlarm: r.falseAlarm === null ? true : r.falseAlarm, markedBy: r.markedBy || ADMIN });
        D.events.push({ at: Date.now(), kind: 'release', text: ADMIN + ' released an email from ' + r.sender.address + ' to ' + r.user + '.' }); return Object.assign(base, { record: r }); }
      case '/api/mark': { const r = recs.find(x => x.key === body.key); if (!r) throw new Error('not found'); Object.assign(r, { falseAlarm: body.falseAlarm === true, markedBy: ADMIN }); return Object.assign(base, { record: r }); }
      case '/api/resume': return Object.assign(base, { ok: true });
    }
    throw new Error('not found');
  };
})();`;
    // Shift the demo's times so the mockup is "live" whenever it's opened.
    const shift = `(function(){const D=window.SPRUCE_DEMO_DATA,d=Date.now()-D.now;if(Math.abs(d)<60000)return;const day=(ms)=>new Date(ms).toISOString().slice(0,10);
for(const r of D.records){for(const k of ['processedAt','receivedAt','releasedAt'])if(r[k])r[k]+=d;}for(const e of D.events)e.at+=d;
const sh=Math.round(d/86400000);if(sh)for(const s of D.stats){s.day=day(Date.parse(s.day+'T12:00:00Z')+sh*86400000);}D.now=Date.now();})();`;
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    let html = read('public/index.html');
    html = html.replace('<title>Mail Protection Admin</title>', '<title>Mail Protection Admin</title>\n<meta name="description" content="Clickable mockup of the S.P.R.U.C.E+ Mail Protection admin dashboard, with made-up data.">');
    html = html.replace('<link rel="stylesheet" href="app.css">', `<style>\n${read('public/app.css')}\n</style>`);
    html = html.replace('<script src="app.js" defer></script>', '');
    html = html.replace('</body>', `<script>window.SPRUCE_DEMO_DATA = ${json};</script>\n<script>${shift}</script>\n<script>\n${read('src/dashboard/aggregate.js')}\n</script>\n<script>${fakeApi}</script>\n<script>\n${read('public/app.js')}\n</script>\n</body>`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    console.log(`Mockup: ${out} (${Math.round(html.length / 1024)} KB, ${data.records.length} made-up records)`);
})().catch((e) => { console.error(e); process.exit(1); });
