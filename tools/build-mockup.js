#!/usr/bin/env node
// Builds the clickable mockup: ONE self-contained HTML file with the real dashboard (public/), the real
// dashboard numbers (src/dashboard/aggregate.js) and the demo data (src/demo/seed.js, all made up),
// with a stand-in for the service's API that runs in the page. Nothing is sent anywhere; Release and
// the marks change only the page's own copy of the data.
//
//     node tools/build-mockup.js [out.html]
//
// Also writes <out>-artifact.html: the same page without its own <html>/<head>/<body> (for publishing as
// a claude.ai artifact, which adds those).
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { buildDemo } = require('../src/demo/seed');
const spruce = require('../src/engine/spruce');
const { parseChangelog } = require('../src/releases');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
    const out = path.resolve(process.argv[2] || path.join(ROOT, 'build', 'mockup.html'));
    const cfg = loadConfig({ DEMO: '1', MODE: 'enforce', ORG_DOMAINS: 'maple-schools.example', ADMIN_EMAILS: 'demo-admin@example.org' });
    const now = Date.now();
    const { store, intel } = await buildDemo({ cfg, now });
    const E = spruce.load();
    const data = {
        now,
        records: await store.listRecords({ sinceMs: 0, limit: 100000 }),
        stats: await store.getStats('2000-01-01', '2999-12-31'),
        events: await store.listEvents(0),
        changelog: parseChangelog(read('CHANGELOG.md')).slice(0, 20),
        settings: { mode: cfg.mode, aiThreshold: cfg.aiThreshold, aiSuspicious: cfg.aiSuspicious, moveOnRules: cfg.moveOnRules, aiMovesInside: cfg.aiMovesInside, brakePerHour: cfg.brakePerHour,
                    orgDomains: ['maple-schools.example'], pilotOu: '/Staff', pilotUsers: 0, allowDomains: [], allowAddresses: 0, retentionDays: cfg.retentionDays,
                    storeSubjects: true, storeAiQuotes: true, movedLabel: cfg.movedLabel, model: E.modelInfo, engine: E.vendor, watched: (await store.listUsers()).length, demo: true,
                    mailboxes: (await store.listUsers()).sort((a, b) => a.email.localeCompare(b.email)).map(u => ({ email: u.email, lastNotification: u.lastNotification || null, watchExpiration: u.watchExpiration || null })),
                    renew: { available: true, last: { at: now - 15 * 60 * 60 * 1000, code: 0 } },
                    brakePerHour: 0, brakeLimit: 100, campaignHoldAfter: cfg.campaignHoldAfter, alertEmail: 'spruce-admins@maple-schools.example',
                    digest: { enabled: false }, trainingExport: { enabled: false }, timeZone: 'America/New_York',
                    projectKnown: true, demoProjectId: 'demo-project',
                    policy: { mode: { value: cfg.mode, env: cfg.mode, changed: null, replaced: null }, aiThreshold: { value: cfg.aiThreshold, env: cfg.aiThreshold, changed: null, replaced: null }, aiSuspicious: { value: cfg.aiSuspicious, env: cfg.aiSuspicious, changed: null, replaced: null },
                              brakePerHour: { value: 0, env: 0, changed: null, replaced: null }, timeZone: { value: 'America/New_York', env: 'America/New_York', changed: null, replaced: null },
                              allowDomains: { value: [], env: [], changed: null, replaced: null }, allowAddresses: { value: [], env: [], changed: null, replaced: null },
                              retentionDays: { value: cfg.retentionDays, env: cfg.retentionDays, changed: null, replaced: null } }, version: require('../package.json').version,
                    checks: { cloudflare: true, safeBrowsing: false, phishingLists: true, siteAge: true }, lists: await intel.feeds.status() }
    };
    // The API stand-in: the same routes and answers as src/server.js, over the data above.
    const fakeApi = `
(function () {
  const D = window.SPRUCE_DEMO_DATA, A = window.SpruceAggregate, ADMIN = 'demo-admin@example.org';
  const DAY = A.DAY;
  const brief = (r) => ({ key: r.key, user: r.user, processedAt: r.processedAt, sender: r.sender, subject: r.subject, campaign: r.campaign, status: r.status, score: r.score,
    ai: r.ai ? Math.round((r.ai.probability || 0) * 1000) / 1000 : null, action: r.action, trigger: r.trigger, state: r.state, releasedByUser: !!r.releasedByUser, falseAlarm: r.falseAlarm });
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
      case '/api/message': { const r = recs.find(x => x.key === q.get('key')); if (!r) throw new Error('not found'); return Object.assign(base, { message: r, mode: D.settings.mode }); }
      case '/api/health': return Object.assign(base, A.modelHealth(recs, now, n, { orgDomains: D.settings.orgDomains, aiSuspicious: D.settings.aiSuspicious, aiThreshold: D.settings.aiThreshold }), { current: D.settings.model.name + ' ' + D.settings.model.version, threshold: D.settings.aiThreshold, trainingExport: !!D.settings.trainingExport.enabled });
      case '/api/settings': return Object.assign(base, D.settings);
      case '/api/release': { const r = recs.find(x => x.key === body.key); if (!r || r.state !== 'moved') throw new Error('it is not in Spam');
        Object.assign(r, { state: 'released', releasedBy: ADMIN, releasedAt: Date.now(), falseAlarm: r.falseAlarm === null ? true : r.falseAlarm, markedBy: r.markedBy || ADMIN });
        D.events.push({ at: Date.now(), kind: 'release', text: ADMIN + ' moved an email from ' + r.sender.address + ' to ' + r.user + ' back to the Inbox.' }); return Object.assign(base, { record: r }); }
      case '/api/mark': { const r = recs.find(x => x.key === body.key); if (!r) throw new Error('not found'); Object.assign(r, { falseAlarm: body.falseAlarm === true, markedBy: ADMIN });
        let moved = null;
        if (body.move === true && body.falseAlarm !== true) moved = D.settings.mode !== 'enforce' ? 'monitor' : r.state !== 'inbox' || r.action === 'move' ? 'not-in-inbox' : 'moved';
        if (moved === 'moved') Object.assign(r, { action: 'move', state: 'moved', why: r.why + '; moved when ' + ADMIN + ' confirmed it as phishing', heldMovedBy: ADMIN, heldMovedAt: Date.now() });
        return Object.assign(base, { record: r, moved }); }
      case '/api/resume': return Object.assign(base, { ok: true });
      case '/api/renew-watches': return Object.assign(base, { ok: true });
      case '/api/activity': return Object.assign(base, { events: A.activity(D.events.filter(e => e.at >= since).sort((a, b) => b.at - a.at), q.get('kind') || '').slice(0, 500) });
      case '/api/readiness': return Object.assign(base, { readiness: A.readiness(recs, { now, days: n, mode: D.settings.mode, installedAt: now - 60 * DAY, brakeLimit: D.settings.brakeLimit, holdAfter: D.settings.campaignHoldAfter,
        watched: D.settings.watched, lastNotification: now - 4 * 60000, quietHours: 12, renew: D.settings.renew.last }) });
      case '/api/campaign': { const c = recs.filter(r => r.campaign === q.get('key')); if (!c.length) throw new Error('not found');
        const k = (f) => c.filter(f).length;
        return Object.assign(base, { campaign: { key: q.get('key'), label: c[0].campaignLabel, decision: null, copies: c.length, moved: k(r => r.state === 'moved'), held: 0, recorded: k(r => r.state === 'inbox'),
          released: k(r => r.state === 'released'), strong: k(r => r.evidence === 'strong'), holdAfter: D.settings.campaignHoldAfter } }); }
      case '/api/pending': return Object.assign(base, { brake: false, held: 0, rescues: recs.filter(r => r.state === 'released' && r.releasedByUser && !r.markedBy && r.score >= 5 && r.trigger !== 'ai').length,
        unreviewed: recs.filter(r => (r.action === 'move' || r.action === 'would-move') && !r.markedBy).length, total: 0 });
      case '/api/review': { const moved = recs.filter(r => r.processedAt >= since && (r.action === 'move' || r.action === 'would-move') && r.trigger !== 'admin' && !r.markedBy).sort((a, b) => a.processedAt - b.processedAt);
        const sus = recs.filter(r => r.processedAt >= since && r.action === 'flag' && r.state === 'inbox' && !r.markedBy).sort((a, b) => b.processedAt - a.processedAt);
        const queue = q.get('queue') === 'suspicious' ? 'suspicious' : 'moved', l = queue === 'suspicious' ? sus : moved;
        return Object.assign(base, { queue, total: l.length, keys: l.map(r => r.key), mode: D.settings.mode, counts: { moved: moved.length, suspicious: sus.length } }); }
      case '/api/status': return Object.assign(base, { checks: [{ id: 'mockup', ok: null, text: 'The clickable mockup has no service to check: the real dashboard checks it here.', fix: null }] });
      case '/api/digest/preview': return Object.assign(base, { preview: { subject: 'S.P.R.U.C.E+ weekly summary (mockup)', text: 'The real dashboard shows the summary of the last 7 days here.' } });
      case '/api/digest': return Object.assign(base, { enabled: body.enabled === true });
      case '/api/policy': {
        if (String(body.projectId || '').trim() !== 'demo-project') throw new Error("That isn't the Google Cloud project ID of this service. Nothing was changed.");
        const p = D.settings.policy[body.key];
        if (!p) throw new Error('Choose a setting to change.');
        if (body.key === 'mode' && body.value === 'enforce' && p.value !== 'enforce' && body.agree !== true) throw new Error('Tick "I agree" to switch to enforce mode. Nothing was changed.');
        const before = p.value;
        Object.assign(p, { value: body.value, changed: { by: ADMIN, at: Date.now(), before } });
        if (Array.isArray(p.env)) body.value = [...new Set(String(body.value || '').split(/[\\r\\n,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean))].sort();
        p.value = body.value;
        D.settings[body.key] = body.value;
        if (body.key === 'brakePerHour') D.settings.brakeLimit = body.value || 100;
        return Object.assign(base, { changed: { key: body.key, value: body.value, before } });
      }
      case '/api/update':
        if (body && body.agree !== undefined) {
          if (body.agree !== true) throw new Error('Tick "I agree" to update. Nothing was changed.');
          if (String(body.projectId || '').trim() !== 'demo-project') throw new Error("That isn't the Google Cloud project ID of this service. Nothing was changed.");
          if (String(body.email || '').trim().toLowerCase() !== ADMIN) throw new Error("That isn't the email address you are signed in with. Nothing was changed.");
          return Object.assign(base, { started: { from: D.settings.version, to: '9.9.9', demo: true } });
        }
        return Object.assign(base, { installed: { version: D.settings.version, installLevel: 1 }, newest: { version: '9.9.9', commit: '0'.repeat(40), date: new Date().toISOString(), model: D.settings.model.version, installLevel: 1, repo: 'mockup (GitHub not read)' },
          newer: [{ version: '9.9.9', title: 'A made-up newer version (mockup)', body: '- The mockup reads no GitHub: this entry is made up, so you can try the page.' }], changelog: D.changelog, canUpdate: true, why: null, progress: null, running: false, setUp: true });
      case '/api/training-export/allow': D.settings.trainingExport = { enabled: body.enabled === true, updatedBy: ADMIN, updatedAt: Date.now() }; return Object.assign(base, { enabled: body.enabled === true });
      case '/api/bulk': return Object.assign(base, { done: (body.keys || []).length, skipped: 0, failed: 0 });
      case '/api/campaign/confirm': return Object.assign(base, { moved: { moved: 0, gone: 0, failed: 0, left: 0 }, found: null });
      case '/api/campaign/release': return Object.assign(base, { released: 0, failed: 0 });
      case '/api/campaign/find': return Object.assign(base, { found: { searched: 0, of: 0, found: 0, moved: 0, failed: 0 } });
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
    html = html.replace('</body>', `<script>window.SPRUCE_MEMORY_ROUTER = true; window.SPRUCE_DEMO_DATA = ${json};</script>\n<script>${shift}</script>\n<script>\n${read('src/dashboard/aggregate.js')}\n</script>\n<script>${fakeApi}</script>\n<script>\n${read('public/app.js')}\n</script>\n</body>`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    // The artifact version: the head's title, description and style, then the body's content.
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1].replace(/<meta charset="utf-8">\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '');
    const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
    const art = out.replace(/\.html$/, '') + '-artifact.html';
    fs.writeFileSync(art, `${head.trim()}\n${body.trim()}\n`);
    console.log(`Mockup: ${out} (${Math.round(html.length / 1024)} KB, ${data.records.length} made-up records); artifact version: ${art}`);
})().catch((e) => { console.error(e); process.exit(1); });
