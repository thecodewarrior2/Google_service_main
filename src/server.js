'use strict';
// The HTTP service (Cloud Run).
//   POST /pubsub/push              Gmail notifications, from Pub/Sub (OIDC-verified)
//   POST /tasks/renew-watches      daily, from Cloud Scheduler (OIDC-verified)
//   POST /tasks/purge              daily, from Cloud Scheduler: records past RETENTION_DAYS deleted
//   POST /tasks/stop-watches       by hand, to switch the service off: every mailbox watch is stopped
//   GET  /healthz                  for Cloud Run
//   /api/*  and  /                 the admin dashboard, behind Identity-Aware Proxy, ADMIN_EMAILS only
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, configProblems } = require('./config');
const { createStore } = require('./store');
const { Service } = require('./pipeline');
const { verifyPush, verifyTask, verifyAdmin } = require('./auth/verify');
const A = require('./dashboard/aggregate');
const spruce = require('./engine/spruce');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SECURITY_HEADERS = {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store'
};

function send(res, status, body, type = 'application/json') {
    res.writeHead(status, Object.assign({ 'content-type': type }, SECURITY_HEADERS));
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
    status: r.status, score: r.score, ai: r.ai ? Math.round((r.ai.probability || 0) * 1000) / 1000 : null, action: r.action, trigger: r.trigger, state: r.state, falseAlarm: r.falseAlarm });

function createApp({ cfg, store, service }) {
    const since = (q) => Date.now() - Math.min(90, Math.max(1, Number(q.get('days')) || 30)) * A.DAY;
    const nDays = (q) => Math.min(90, Math.max(1, Number(q.get('days')) || 30));
    const load = async (q) => ({ records: await store.listRecords({ sinceMs: since(q) - A.DAY, limit: 20000 }), stats: await store.getStats(A.dayOf(since(q)), A.dayOf(Date.now())) });

    const api = {
        'GET /api/overview': async (q) => {
            const { records, stats } = await load(q);
            const n = nDays(q), now = Date.now();
            return { summary: A.summary(records, stats, now, n), trend: A.trend(records, stats, now, n), topReasons: A.topReasons(records, now, n).slice(0, 8),
                     campaigns: A.campaigns(records, now, n).slice(0, 5), alerts: (await store.listEvents(now - 7 * A.DAY)).slice(0, 10),
                     brake: await store.getState('brake'), mode: cfg.mode };
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
            return { mode: cfg.mode, aiThreshold: cfg.aiThreshold, moveOnRules: cfg.moveOnRules, aiMovesInside: cfg.aiMovesInside, brakePerHour: cfg.brakePerHour,
                     orgDomains: cfg.orgDomains, pilotOu: cfg.pilotOu, pilotUsers: cfg.pilotUsers.length, allowDomains: cfg.allowDomains, allowAddresses: cfg.allowAddresses.length,
                     retentionDays: cfg.retentionDays, storeSubjects: cfg.storeSubjects, storeAiQuotes: cfg.storeAiQuotes, movedLabel: cfg.movedLabel,
                     model: E.modelInfo, engine: E.vendor, watched: (await store.listUsers()).filter(u => u.watched).length, demo: cfg.demo };
        },
        'POST /api/release': async (q, body, admin) => service.release(String(body.key || ''), admin.email),
        'POST /api/mark': async (q, body, admin) => service.mark(String(body.key || ''), body.falseAlarm === true, admin.email),
        'POST /api/resume': async (q, body, admin) => { await service.resume(admin.email); return { ok: true }; }
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
                await service.handleNotification(note);
                return send(res, 204, '');
            }
            const TASKS = { 'POST /tasks/renew-watches': () => service.renewWatches(), 'POST /tasks/purge': async () => ({ deleted: await service.purge() }), 'POST /tasks/stop-watches': () => service.stopAll() };
            if (TASKS[route]) {
                const v = await verifyTask(req, cfg);
                if (!v.ok) return send(res, 403, { error: v.why });
                return send(res, 200, await TASKS[route]());
            }
            // Everything else is the dashboard: admins only.
            const admin = await verifyAdmin(req, cfg);
            if (!admin.ok) return send(res, admin.status || 403, { error: admin.why });
            if (api[route]) {
                if (req.method === 'POST' && req.headers['x-requested-with'] !== 'spruce-dashboard') return send(res, 403, { error: 'missing request header' });
                const body = req.method === 'POST' ? await readBody(req, 64 * 1024) : {};
                const out = await api[route](url.searchParams, body, admin);
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
    let store, gmail;
    if (cfg.demo) {
        const { buildDemo } = require('./demo/seed');
        ({ store } = await buildDemo({ cfg, now: Date.now() }));
        gmail = { labelId: async (u, n) => `Label_${n}`, modify: async () => ({}) };
        console.log('DEMO mode: made-up data, no Google access.');
    } else {
        const { DelegatedAuth } = require('./gmail/auth');
        const { GmailClient } = require('./gmail/client');
        store = createStore(cfg);
        gmail = new GmailClient(new DelegatedAuth(cfg));
    }
    spruce.load();
    const service = new Service({ cfg, store, gmail });
    http.createServer(createApp({ cfg, store, service })).listen(cfg.port, () => console.log(`Listening on ${cfg.port} (${cfg.role}, ${cfg.mode} mode).`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { createApp };
