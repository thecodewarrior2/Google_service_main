'use strict';
// The HTTP service (Cloud Run).
//   POST /pubsub/push              Gmail notifications, from Pub/Sub (OIDC-verified)
//   POST /tasks/renew-watches      daily, from Cloud Scheduler (OIDC-verified)
//   POST /tasks/purge              daily, from Cloud Scheduler: records past RETENTION_DAYS deleted
//   POST /tasks/stop-watches       by hand, to switch the service off: every mailbox watch is stopped
//   POST /tasks/sync-feeds         daily, from Cloud Scheduler: the phishing lists, downloaded once for everyone
//   GET  /healthz                  for Cloud Run
//   /api/*  and  /                 the admin dashboard, behind Identity-Aware Proxy, ADMIN_EMAILS / ADMIN_GROUP only
//                                  (POST /api/renew-watches runs the Cloud Scheduler job: src/scheduler.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, configProblems } = require('./config');
const { createStore } = require('./store');
const { Service } = require('./pipeline');
const { verifyPush, verifyTask, verifyAdmin, adminGroupCheck } = require('./auth/verify');
const A = require('./dashboard/aggregate');
const spruce = require('./engine/spruce');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SECURITY_HEADERS = {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store'
};

function send(res, status, body, type = 'application/json', extra = {}) {
    res.writeHead(status, Object.assign({ 'content-type': type }, SECURITY_HEADERS, extra));
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function readBody(req, max = 1024 * 1024) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return text ? JSON.parse(text) : {}; } catch (e) { throw Object.assign(new Error('not JSON'), { status: 400 }); }
}

// The dashboard's view of a record: what an admin needs, nothing of the email's text beyond the
// subject and the checks' own short quotes (both can be turned off: STORE_SUBJECTS, STORE_AI_QUOTES).
const brief = (r) => ({ key: r.key, user: r.user, processedAt: r.processedAt, sender: r.sender, subject: r.subject, campaign: r.campaign,
    status: r.status, score: r.score, ai: r.ai ? Math.round((r.ai.probability || 0) * 1000) / 1000 : null, action: r.action, trigger: r.trigger, state: r.state, releasedByUser: !!r.releasedByUser, falseAlarm: r.falseAlarm });

// The group re-read from the dashboard: at most once a minute, and its last run remembered for 15 s
// (Settings is fetched every 30 s by each open dashboard).
const RENEW_GAP_MS = 60 * 1000, RENEW_STATUS_MS = 15 * 1000;

function createApp({ cfg, store, service, scheduler = null }) {
    let renewAskedAt = 0, renewStatus = null, renewStatusAt = 0;
    const canRenew = () => !!(scheduler && cfg.renewJob);
    async function lastRenew() {
        if (cfg.demo && !canRenew()) return { at: Date.now() - 15 * 60 * 60 * 1000, code: 0 };
        if (!canRenew()) return null;
        if (Date.now() - renewStatusAt > RENEW_STATUS_MS) {
            renewStatus = await scheduler.lastRun(cfg.renewJob).catch(e => ({ error: String(e.message).slice(0, 200) }));
            renewStatusAt = Date.now();
        }
        return renewStatus;
    }
    const groupCheck = cfg.adminGroups.length && service.gmail && service.gmail.hasMember ? adminGroupCheck(cfg, service.gmail) : null;
    const since = (q) => Date.now() - Math.min(90, Math.max(1, Number(q.get('days')) || 30)) * A.DAY;
    const nDays = (q) => Math.min(90, Math.max(1, Number(q.get('days')) || 30));
    const load = async (q) => ({ records: await store.listRecords({ sinceMs: since(q) - A.DAY, limit: 20000 }), stats: await store.getStats(A.dayOf(since(q)), A.dayOf(Date.now())) });

    // The brake, and how many emails it holds (still in the Inbox, recorded since it came on).
    async function brakeInfo(records) {
        const b = await store.getState('brake');
        if (!b) return null;
        return Object.assign({}, b, { held: records.filter(r => r.held === 'brake' && r.state === 'inbox' && r.processedAt >= b.at).length });
    }
    // Campaigns held on weak evidence, waiting for an admin's decision.
    async function heldCampaigns(records) {
        const held = (await store.listCampaignStates()).filter(c => c.heldAt && !c.decision);
        return held.map(c => ({ campaign: c.key, label: c.label, heldAt: c.heldAt, held: records.filter(r => r.campaign === c.key && r.held === 'campaign' && r.state === 'inbox').length }))
            .sort((a, b) => b.held - a.held).slice(0, 20);
    }
    const ACTIONS_GAP_MS = 5000;   // a campaign action at most every 5 s per campaign (no double clicks)
    const lastAction = new Map();
    const once = (key) => { const t = lastAction.get(key) || 0; if (Date.now() - t < ACTIONS_GAP_MS) return false; lastAction.set(key, Date.now()); return true; };

    const api = {
        'GET /api/overview': async (q) => {
            const { records, stats } = await load(q);
            const n = nDays(q), now = Date.now();
            return { summary: A.summary(records, stats, now, n), trend: A.trend(records, stats, now, n), topReasons: A.topReasons(records, now, n).slice(0, 8),
                     campaigns: A.campaigns(records, now, n).slice(0, 5), alerts: (await store.listEvents(now - 7 * A.DAY)).slice(0, 10),
                     brake: await brakeInfo(records), heldCampaigns: await heldCampaigns(records), mode: cfg.mode };
        },
        'GET /api/campaigns': async (q) => { const { records } = await load(q); return { campaigns: A.campaigns(records, Date.now(), nDays(q)) }; },
        'GET /api/users': async (q) => { const { records } = await load(q); return { users: A.users(records, Date.now(), nDays(q)) }; },
        'GET /api/messages': async (q) => {
            const { records } = await load(q);
            const list = A.filterRecords(records, { user: q.get('user') || '', campaign: q.get('campaign') || '', action: q.get('action') || '', state: q.get('state') || '', q: q.get('q') || '', since: since(q) });
            return { total: list.length, messages: list.slice(0, 500).map(brief) };
        },
        'GET /api/message': async (q) => { const r = await store.getRecord(String(q.get('key') || '')); return r ? { message: r } : { error: 'not found', status: 404 }; },
        'GET /api/health': async (q) => { const { records } = await load(q); return Object.assign(A.modelHealth(records, Date.now(), nDays(q)), { threshold: cfg.aiThreshold }); },
        'GET /api/settings': async () => {
            const E = spruce.load();
            const renew = { available: canRenew() || cfg.demo, last: await lastRenew() };
            const watchedUsers = (await store.listUsers()).filter(u => u.watched);
            return { mode: cfg.mode, aiThreshold: cfg.aiThreshold, moveOnRules: cfg.moveOnRules, aiMovesInside: cfg.aiMovesInside, brakePerHour: cfg.brakePerHour,
                     brakeLimit: await service.brakeLimit(), campaignHoldAfter: cfg.campaignHoldAfter, alertEmail: cfg.alertEmail || '',
                     orgDomains: cfg.orgDomains, pilotGroups: cfg.pilotGroups, pilotOu: cfg.pilotOu, pilotUsers: cfg.pilotUsers.length, allowDomains: cfg.allowDomains, allowAddresses: cfg.allowAddresses.length,
                     retentionDays: cfg.retentionDays, storeSubjects: cfg.storeSubjects, storeAiQuotes: cfg.storeAiQuotes, movedLabel: cfg.movedLabel,
                     model: E.modelInfo, engine: E.vendor, watched: watchedUsers.length, demo: cfg.demo,
                     // Each watched mailbox, and when Gmail last said it changed: none since the watch
                     // started means no notifications arrive for it.
                     mailboxes: watchedUsers.sort((a, b) => String(a.email).localeCompare(String(b.email))).slice(0, 500)
                         .map(u => ({ email: u.email, lastNotification: u.lastNotification || null, watchExpiration: u.watchExpiration || null })),
                     renew,
                     checks: { cloudflare: cfg.cloudflareThreats, safeBrowsing: cfg.safeBrowsing && !!cfg.safeBrowsingKey, phishingLists: cfg.phishingLists, siteAge: cfg.siteAge },
                     lists: service.intel && service.intel.feeds ? await service.intel.feeds.status() : [] };
        },
        'POST /api/release': async (q, body, admin) => service.release(String(body.key || ''), admin.email),
        'POST /api/mark': async (q, body, admin) => service.mark(String(body.key || ''), body.falseAlarm === true, admin.email),
        // Resume moving; with moveHeld, the emails the brake held are moved now too.
        'POST /api/resume': async (q, body, admin) => service.resume(admin.email, { moveHeld: body.moveHeld === true }),
        // A campaign: what the brakes and admins decided, and how many copies are where.
        'GET /api/campaign': async (q) => {
            const key = String(q.get('key') || '');
            const recs = await service.campaignRecords(key);
            if (!recs.length) return { error: 'not found', status: 404 };
            const st = (await store.getCampaign(key)) || {};
            const count = (f) => recs.filter(f).length;
            return { campaign: { key, label: recs[0].campaignLabel, decision: st.decision || null, decidedBy: st.decidedBy || null, decidedAt: st.decidedAt || null, heldAt: st.heldAt || null,
                copies: recs.length, moved: count(r => r.state === 'moved'), held: count(r => r.held === 'campaign' && r.state === 'inbox'), recorded: count(r => r.state === 'inbox'),
                released: count(r => r.state === 'released'), strong: count(r => r.evidence === 'strong'), holdAfter: cfg.campaignHoldAfter } };
        },
        'POST /api/campaign/confirm': async (q, body, admin) => {
            const key = String(body.key || '');
            if (!once(`confirm|${key}`)) return { error: 'already under way', status: 429 };
            return service.confirmCampaign(key, admin.email, { search: body.search === true });
        },
        'POST /api/campaign/release': async (q, body, admin) => {
            const key = String(body.key || '');
            if (!once(`release|${key}`)) return { error: 'already under way', status: 429 };
            return service.releaseCampaign(key, admin.email);
        },
        'POST /api/campaign/find': async (q, body, admin) => {
            const key = String(body.key || '');
            if (!once(`find|${key}`)) return { error: 'already under way', status: 429 };
            const found = await service.findCopies(key, admin.email);
            await store.addEvent({ kind: 'campaign', campaign: key, text: `${admin.email} searched ${found.searched} mailboxes for copies of a campaign: ${found.found} found${found.moved ? `, ${found.moved} moved to Spam` : ''}.` });
            return { found };
        },
        // The records shown on Messages (same filters), as a CSV file.
        'GET /api/export.csv': async (q) => {
            const { records } = await load(q);
            const list = A.filterRecords(records, { user: q.get('user') || '', campaign: q.get('campaign') || '', action: q.get('action') || '', state: q.get('state') || '', q: q.get('q') || '', since: since(q) });
            return { csv: A.toCsv(list), filename: `spruce-messages-${A.dayOf(Date.now())}.csv` };
        },
        // Everything in Recent activity for the period, by kind (alert, admin, error, watch).
        'GET /api/activity': async (q) => ({ events: A.activity(await store.listEvents(since(q)), String(q.get('kind') || '')).slice(0, 500) }),
        // "Ready for enforce mode?"
        'GET /api/readiness': async (q) => {
            const { records } = await load(q);
            const users = (await store.listUsers()).filter(u => u.watched);
            return { readiness: A.readiness(records, { now: Date.now(), days: nDays(q), mode: cfg.mode, installedAt: await store.getState('installedAt'),
                brakeLimit: await service.brakeLimit(), holdAfter: cfg.campaignHoldAfter, watched: users.length,
                lastNotification: Math.max(0, ...users.map(u => Number(u.lastNotification) || 0)) || null, quietHours: cfg.quietHours, renew: await lastRenew() }) };
        },
        // "Update group membership now": runs the daily re-read job at once (it calls the worker; the
        // dashboard doesn't). Said in Recent activity, with who asked.
        'POST /api/renew-watches': async (q, body, admin) => {
            if (Date.now() - renewAskedAt < RENEW_GAP_MS) return { error: 'Asked less than a minute ago. The list updates once that re-read has run.', status: 429 };
            if (canRenew()) {
                try { await scheduler.run(cfg.renewJob); }
                catch (e) { return { error: `Couldn't start the re-read: ${e.message}`, status: 502 }; }
                renewAskedAt = Date.now(); renewStatusAt = 0;
                await store.addEvent({ kind: 'watch-asked', text: `${admin.email} asked for the pilot group to be read again.` });
                return { ok: true };
            }
            if (cfg.demo) {
                renewAskedAt = Date.now();
                await store.addEvent({ kind: 'watch-asked', text: `${admin.email} asked for the pilot group to be read again (demo: nothing is read).` });
                return { ok: true };
            }
            return { error: 'Not set up here: RENEW_JOB isn\'t set. Run deploy/install.sh again (docs/DEPLOY.md).', status: 503 };
        }
    };

    return async function handle(req, res) {
        const url = new URL(req.url, 'http://local');
        const route = `${req.method} ${url.pathname}`;
        try {
            if (route === 'GET /healthz') return send(res, 200, { ok: true, role: cfg.role });
            const workerRoute = url.pathname === '/pubsub/push' || url.pathname.startsWith('/tasks/');
            if ((workerRoute && cfg.role === 'admin') || (!workerRoute && cfg.role === 'worker')) return send(res, 404, { error: 'not found' });
            if (route === 'POST /pubsub/push') {
                const v = await verifyPush(req, cfg);
                if (!v.ok) return send(res, 403, { error: v.why });
                const body = await readBody(req);
                let note;
                try { note = JSON.parse(Buffer.from(String((body.message && body.message.data) || ''), 'base64').toString('utf8')); } catch (e) { return send(res, 204, ''); }
                // Something left to do (a failed try, a message another instance is still on): Pub/Sub
                // delivers the notification again later (the subscription's retry delay), and it is tried again.
                const out = await service.handleNotification(note);
                return out && out.held ? send(res, 503, { retry: 'later' }) : send(res, 204, '');
            }
            const TASKS = { 'POST /tasks/renew-watches': () => service.renewWatches(), 'POST /tasks/purge': async () => ({ deleted: await service.purge() }), 'POST /tasks/stop-watches': () => service.stopAll(), 'POST /tasks/sync-feeds': () => service.syncFeeds() };
            if (TASKS[route]) {
                const v = await verifyTask(req, cfg);
                if (!v.ok) return send(res, 403, { error: v.why });
                return send(res, 200, await TASKS[route]());
            }
            // Everything else is the dashboard: admins only.
            const admin = await verifyAdmin(req, cfg, groupCheck);
            if (!admin.ok) return send(res, admin.status || 403, { error: admin.why });
            if (api[route]) {
                if (req.method === 'POST' && req.headers['x-requested-with'] !== 'spruce-dashboard') return send(res, 403, { error: 'missing request header' });
                const body = req.method === 'POST' ? await readBody(req, 64 * 1024) : {};
                const out = await api[route](url.searchParams, body, admin);
                if (out && typeof out.csv === 'string') return send(res, 200, out.csv, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${out.filename}"` });
                return send(res, out && out.status ? out.status : (out && out.error ? 400 : 200), Object.assign({ admin: admin.email, demo: cfg.demo }, out));
            }
            if (req.method === 'GET') {
                const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
                const file = path.resolve(PUBLIC, rel);
                if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
                return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
            }
            return send(res, 404, { error: 'not found' });
        } catch (e) {
            console.error(route, e);
            return send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
        }
    };
}

async function main() {
    const cfg = loadConfig();
    const problems = configProblems(cfg);
    if (problems.length) { console.error('Not started; fix the configuration:\n - ' + problems.join('\n - ')); process.exit(1); }
    let store, gmail, intel = null;
    if (cfg.demo) {
        const { buildDemo } = require('./demo/seed');
        ({ store, intel } = await buildDemo({ cfg, now: Date.now() }));
        gmail = { labelId: async (u, n) => `Label_${n}`, modify: async () => ({}), labels: async () => ['INBOX'], search: async () => ({ ids: [], next: null }), headers: async () => ({}) };
        console.log('DEMO mode: made-up data, no Google access.');
    } else {
        const { DelegatedAuth } = require('./gmail/auth');
        const { GmailClient } = require('./gmail/client');
        store = createStore(cfg);
        gmail = new GmailClient(new DelegatedAuth(cfg));
        // The network checks run where mail is judged (the worker).
        if (cfg.role !== 'admin') intel = require('./intel').createIntel({ cfg, store, engine: spruce.load(), version: require('../package.json').version });
    }
    spruce.load();
    const service = new Service({ cfg, store, gmail, intel });
    // The dashboard can start the group re-read job (Cloud Scheduler); the worker doesn't need to.
    const scheduler = !cfg.demo && cfg.role !== 'worker' && cfg.renewJob ? require('./scheduler').createScheduler() : null;
    http.createServer(createApp({ cfg, store, service, scheduler })).listen(cfg.port, () => console.log(`Listening on ${cfg.port} (${cfg.role}, ${cfg.mode} mode).`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { createApp };
