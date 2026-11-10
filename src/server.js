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
const { Service, POLICY_KEYS } = require('./pipeline');
const { verifyPush, verifyTask, verifyAdmin, adminGroupCheck } = require('./auth/verify');
const { RecordCache } = require('./dashboard/cache');
const VERSION = require('../package.json').version;
const A = require('./dashboard/aggregate');
const spruce = require('./engine/spruce');
const training = require('./training');
const { createReleases, parseChangelog } = require('./releases');
const { updateInfo, startUpdate } = require('./update');

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
// "Check an email": the largest email accepted (as pasted or uploaded).
const CHECK_MAX_BYTES = 10 * 1024 * 1024;
// Changing the policy on the dashboard needs the Google Cloud project ID (in demo mode: this one), and a
// few wrong ones in a row lock it for a while.
const DEMO_PROJECT = 'demo-project';
const POLICY_TRIES = 5, POLICY_LOCK_MS = 10 * 60 * 1000;
// The project ID a policy change must be confirmed with ('' when the dashboard doesn't know it).
const expectedProject = (cfg) => cfg.project || (cfg.demo ? DEMO_PROJECT : '');

// Recorded emails nobody has reviewed yet (the review queue): moved or "would move", not by an admin.
const unreviewed = (r) => (r.action === 'move' || r.action === 'would-move') && r.trigger !== 'admin' && !r.markedBy;
// A user took back an email the checks flagged, and no admin has looked yet.
const rescueToCheck = (r) => r.state === 'released' && r.releasedByUser && !r.markedBy && r.score >= 5 && r.trigger !== 'ai';

// Demo mode reads no GitHub: a made-up newer version, then this version's own changelog.
function demoReleases() {
    const file = path.resolve(__dirname, '..', 'CHANGELOG.md');
    const own = fs.existsSync(file) ? parseChangelog(fs.readFileSync(file, 'utf8')) : [];
    const PKG = require('../package.json');
    let model = null; try { model = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'vendor', 'spruce', 'VENDOR.json'), 'utf8')).model; } catch (e) { /* none */ }
    return { newest: async () => ({ repo: 'demo (GitHub not read)', commit: '0'.repeat(40), date: new Date().toISOString(), version: '9.9.9', installLevel: Number(PKG.installLevel) || 0, model,
        changelog: [{ version: '9.9.9', title: 'A made-up newer version (demo mode)', body: '- Demo mode doesn\'t read GitHub: this entry is made up, so you can try the page.\n- The real page shows google_service_main\'s changelog: everything newer than the version installed, then the rest.' }, ...own] }) };
}

function createApp({ cfg, store, service, scheduler = null, cloudrun = null, releases = null }) {
    releases = releases || (cfg.demo ? demoReleases() : createReleases({ repo: cfg.releasesRepo }));
    // (records past RETENTION_DAYS are deleted daily: the copy forgets them too)
    const cache = new RecordCache(store, { keepDays: Math.min(92, cfg.retentionDays || 92) });
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
    const load = async (q) => ({ records: await cache.list(since(q) - A.DAY, 20000), stats: await store.getStats(A.dayOf(since(q)), A.dayOf(Date.now())) });

    // The brake, and how many emails it holds (still in the Inbox, recorded since it came on).
    async function brakeInfo(records) {
        const b = await store.getState('brake');
        if (!b) return null;
        return Object.assign({}, b, { held: records.filter(r => r.held === 'brake' && r.state === 'inbox' && r.processedAt >= b.at).length });
    }
    // Campaigns held on weak evidence, waiting for an admin's decision.
    async function heldCampaigns(records) {
        const held = (await store.listHeldCampaigns()).filter(c => !c.decision);
        return held.map(c => ({ campaign: c.key, label: c.label, heldAt: c.heldAt, held: records.filter(r => r.campaign === c.key && r.held === 'campaign' && r.state === 'inbox').length }))
            .sort((a, b) => b.held - a.held).slice(0, 20);
    }
    let digestSentAt = 0;
    // The Status page's checks: { id, ok (true, false, or null: couldn't check), text, fix }.
    async function statusChecks() {
        const now = Date.now(), out = [];
        const add = (id, ok, text, fix) => out.push({ id, ok, text, fix: ok === true ? null : fix || null });
        const project = cfg.project || (cfg.demo ? 'demo' : ''), region = cfg.region || (cfg.demo ? 'demo' : '');
        if (cloudrun && project && region) {
            try {
                const w = await cloudrun.service(project, region, 'spruce-worker');
                add('iap', !w.iap, w.iap ? 'Identity-Aware Proxy is ON for spruce-worker: Gmail\'s notifications and the scheduled jobs are refused.' : 'Identity-Aware Proxy is off for spruce-worker, as it must be.',
                    'Run bash deploy/install.sh (it turns it off), or: gcloud beta run services update spruce-worker --region=REGION --no-iap');
                const wv = ((w.image.split(':')[1] || '').split('-')[0]) || '';
                add('version', wv === VERSION, wv === VERSION ? `Both services run ${VERSION}.` : `The worker runs ${wv || 'an unknown build'}, the dashboard ${VERSION}.`, 'Run bash deploy/install.sh (or upgrade.sh), so both run the same build.');
                const inv = await cloudrun.invokers(project, region, 'spruce-worker');
                const okInv = inv.some(m => /^serviceAccount:spruce-invoker@/.test(m));
                add('invoker', okInv, okInv ? 'spruce-invoker may call the worker (Pub/Sub and the scheduled jobs sign in as it).' : 'spruce-invoker may not call the worker: notifications and jobs are refused.', 'Run bash deploy/install.sh (it grants roles/run.invoker to spruce-invoker).');
            } catch (e) { add('cloudrun', null, `Couldn't read the worker's settings: ${String(e.message).slice(0, 160)}`, 'The service account needs the Cloud Run Viewer role: run bash deploy/install.sh again.'); }
        } else add('cloudrun', null, 'The worker\'s settings aren\'t checked here (GOOGLE_CLOUD_PROJECT and CLOUD_RUN_REGION aren\'t set).', 'Run bash deploy/install.sh again.');
        const renew = await lastRenew();
        if (renew && renew.at) add('renew', !renew.code, renew.code ? `The last re-read of the group (${new Date(renew.at).toISOString().slice(0, 16).replace('T', ' ')} UTC) didn't reach the worker.` : 'The last re-read of the group reached the worker.',
            'docs/INSTALL.md, Troubleshooting, "The jobs and notifications are refused" (or run bash deploy/doctor.sh).');
        else add('renew', null, renew && renew.error ? `Couldn't read the re-read job: ${renew.error}` : 'The re-read job isn\'t known here (RENEW_JOB).', 'Run bash deploy/install.sh again.');
        if (canRenew()) {
            const sync = await scheduler.lastRun(cfg.renewJob.replace(/spruce-renew-watches$/, 'spruce-sync-feeds')).catch(e => ({ error: e.message }));
            if (sync.error) add('hourly', null, `Couldn't read the hourly job: ${String(sync.error).slice(0, 160)}`);
            else add('hourly', !!sync.at && !sync.code && now - sync.at < 2 * 3600 * 1000, sync.at ? `The hourly job (health check, phishing lists, weekly summary) last ran ${Math.round((now - sync.at) / 60000)} minutes ago${sync.code ? ', and didn\'t reach the worker' : ''}.` : 'The hourly job hasn\'t run yet.',
                'Check spruce-sync-feeds in Cloud Scheduler, or run bash deploy/doctor.sh.');
        }
        const users = (await store.listUsers()).filter(u => u.watched);
        const last = Math.max(0, ...users.map(u => Number(u.lastNotification) || 0));
        add('notifications', users.length > 0 && !!last && now - last < cfg.quietHours * 3600 * 1000,
            !users.length ? 'No mailbox is watched.' : last ? `Gmail's last notification: ${Math.round((now - last) / 60000)} minutes ago, for ${users.length} watched mailboxes.` : 'No notification from Gmail yet.',
            !users.length ? 'Settings → Mailboxes → Update group membership now, then the list below it.' : 'Send a test email to a watched mailbox; if nothing comes, run bash deploy/doctor.sh.');
        const expiring = users.filter(u => u.watchExpiration && u.watchExpiration < now + 24 * 3600 * 1000).length;
        add('watches', !expiring, expiring ? `${expiring} mailbox watches end within a day.` : 'Every watch is renewed in time.', 'Settings → Mailboxes → Update group membership now.');
        if (service.intel && service.intel.feeds) {
            const lists = await service.intel.feeds.status().catch(() => []);
            const oldest = Math.min(...lists.map(l => l.updated || 0));
            add('lists', lists.length > 0 && oldest > now - 2 * 24 * 3600 * 1000, lists.length && oldest ? `The phishing lists were updated ${Math.round((now - oldest) / 3600000)} hours ago at the oldest.` : 'The phishing lists haven\'t been downloaded yet.', 'Activity → Errors shows why a download failed.');
        }
        // (install.sh always sets it, to the admin group by default: empty means ALERT_EMAIL=off, a choice)
        add('alerts', true, cfg.alertEmail ? `Alerts are emailed to ${cfg.alertEmail}.` : 'Alerts aren\'t emailed (ALERT_EMAIL=off): they show in Status → Activity.');
        const errors = (await store.listEvents(now - 24 * 3600 * 1000)).filter(e => e.kind === 'error').length;
        add('errors', errors === 0, errors ? `${errors} errors in the last day.` : 'No errors in the last day.', 'Status → Activity → Errors and gaps.');
        const brake = await store.getState('brake');
        add('brake', !brake, brake ? 'The domain-wide brake is on: nothing is moved.' : 'The domain-wide brake is off.', 'Overview → Resume.');
        return out;
    }
    const ACTIONS_GAP_MS = 5000;   // a campaign action at most every 5 s per campaign (no double clicks)
    const lastAction = new Map();
    let exporting = false;   // one retraining export at a time (it reads up to 100 emails from Gmail)
    // Wrong project IDs (and email addresses) typed per admin, on the policy and Update: five in 10 minutes lock both.
    const wrongIds = new Map();
    const wrong = {
        locked: (who) => (wrongIds.get(who) || []).filter(t => Date.now() - t < POLICY_LOCK_MS).length >= POLICY_TRIES,
        add: (who) => wrongIds.set(who, [...(wrongIds.get(who) || []).filter(t => Date.now() - t < POLICY_LOCK_MS), Date.now()]),
        clear: (who) => wrongIds.delete(who)
    };
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
        'GET /api/health': async (q) => {
            const { records } = await load(q);
            const tx = (await store.getState('trainingExport')) || {};
            return Object.assign(A.modelHealth(records, Date.now(), nDays(q)), { threshold: cfg.aiThreshold, trainingExport: !!tx.enabled });
        },
        'GET /api/settings': async () => {
            const E = spruce.load();
            const renew = { available: canRenew() || cfg.demo, last: await lastRenew() };
            const digest = Object.assign({ enabled: false }, await store.getState('digest'));
            const trainingExport = Object.assign({ enabled: false }, await store.getState('trainingExport'));
            const policy = service.policyInfo ? service.policyInfo() : null;
            const watchedUsers = (await store.listUsers()).filter(u => u.watched);
            return { mode: cfg.mode, aiThreshold: cfg.aiThreshold, aiSuspicious: cfg.aiSuspicious, moveOnRules: cfg.moveOnRules, aiMovesInside: cfg.aiMovesInside, brakePerHour: cfg.brakePerHour,
                     brakeLimit: await service.brakeLimit(), campaignHoldAfter: cfg.campaignHoldAfter, alertEmail: cfg.alertEmail || '',
                     orgDomains: cfg.orgDomains, pilotGroups: cfg.pilotGroups, pilotOu: cfg.pilotOu, pilotUsers: cfg.pilotUsers.length, allowDomains: cfg.allowDomains, allowAddresses: cfg.allowAddresses.length,
                     retentionDays: cfg.retentionDays, storeSubjects: cfg.storeSubjects, storeAiQuotes: cfg.storeAiQuotes, movedLabel: cfg.movedLabel,
                     model: E.modelInfo, engine: E.vendor, watched: watchedUsers.length, demo: cfg.demo,
                     // Each watched mailbox, and when Gmail last said it changed: none since the watch
                     // started means no notifications arrive for it.
                     mailboxes: watchedUsers.sort((a, b) => String(a.email).localeCompare(String(b.email))).slice(0, 500)
                         .map(u => ({ email: u.email, lastNotification: u.lastNotification || null, watchExpiration: u.watchExpiration || null })),
                     renew, digest, trainingExport, timeZone: cfg.timeZone, version: VERSION,
                     policy, projectKnown: !!expectedProject(cfg), demoProjectId: cfg.demo ? DEMO_PROJECT : null,
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
        // "Check an email": what the service would decide for a pasted email, and why. Nothing of it is
        // stored; Activity notes who checked one, and the sender's domain.
        'POST /api/check': async (q, body, admin) => {
            const raw = typeof body.raw === 'string' ? body.raw : '';
            if (!raw.trim()) return { error: 'Paste the email\'s original (in Gmail: Show original), or choose an .eml file.', status: 400 };
            if (Buffer.byteLength(raw) > CHECK_MAX_BYTES) return { error: 'That email is over 10 MB.', status: 413 };
            const result = await service.checkPasted(raw, { by: admin.email });
            await store.addEvent({ kind: 'check', text: `${admin.email} checked a pasted email from ${result.sender.domain || 'an unknown sender'}.` });
            return { result };
        },
        // The review queue: emails moved or "would move" nobody has reviewed, oldest first.
        'GET /api/review': async (q) => {
            const list = (await cache.list(since(q))).filter(unreviewed).sort((a, b) => a.processedAt - b.processedAt);
            return { total: list.length, keys: list.slice(0, 1000).map(r => r.key) };
        },
        // Several emails at once: release, false-alarm or phishing (at most 500).
        'POST /api/bulk': async (q, body, admin) => {
            const keys = Array.isArray(body.keys) ? [...new Set(body.keys.map(String))].slice(0, 500) : [];
            if (!['release', 'false-alarm', 'phishing'].includes(body.action) || !keys.length) return { error: 'Choose emails and what to do with them.', status: 400 };
            return service.bulk(keys, body.action, admin.email);
        },
        // What needs an admin (the browser tab's title shows the count): the brake, held campaigns, users
        // who took flagged mail back; and how many emails wait for review.
        'GET /api/pending': async () => {
            const records = await cache.list(Date.now() - 30 * A.DAY);
            const brake = !!(await store.getState('brake'));
            const held = (await store.listHeldCampaigns()).filter(c => !c.decision).length;
            const rescues = records.filter(rescueToCheck).length;
            return { brake, held, rescues, unreviewed: records.filter(unreviewed).length, total: (brake ? 1 : 0) + held + rescues };
        },
        // The Status page: what this week's troubleshooting needed, checked in one place.
        'GET /api/status': async () => ({ checks: await statusChecks() }),
        // The weekly summary email: on or off (off by default), a preview, and one now.
        'GET /api/digest/preview': async () => ({ preview: await service.digestContent() }),
        'POST /api/digest': async (q, body, admin) => service.setDigest(body.enabled === true, admin.email),
        'POST /api/digest/send': async (q, body, admin) => {
            if (Date.now() - digestSentAt < 60 * 1000) return { error: 'Sent less than a minute ago.', status: 429 };
            digestSentAt = Date.now();
            if (cfg.demo) return { sent: 0, to: [], failed: [], demo: true };
            try { return await service.sendDigest({ by: admin.email }); } catch (e) { return { error: `Couldn't send it: ${String(e.message).slice(0, 200)}`, status: 502 }; }
        },
        // A policy setting changed on the dashboard (POLICY_KEYS: the mode, the AI lines, the brake, the time
        // zone, the allowlists). Needs the
        // project ID typed in; switching to enforce mode also needs the agreement ticked.
        'POST /api/policy': async (q, body, admin) => {
            const key = String(body.key || '');
            if (!POLICY_KEYS.includes(key)) return { error: 'Choose a setting to change.', status: 400 };
            const expected = expectedProject(cfg);
            if (!expected) return { error: 'This dashboard doesn\'t know its Google Cloud project (GOOGLE_CLOUD_PROJECT). Run bash deploy/install.sh once, then try again.', status: 409 };
            if (wrong.locked(admin.email)) return { error: 'Too many wrong project IDs. Try again in 10 minutes.', status: 429 };
            if (String(body.projectId || '').trim().toLowerCase() !== expected.toLowerCase()) {
                wrong.add(admin.email);
                return { error: 'That isn\'t the Google Cloud project ID of this service. Nothing was changed.', status: 403 };
            }
            wrong.clear(admin.email);
            if (key === 'mode' && body.value === 'enforce' && cfg.mode !== 'enforce' && body.agree !== true) return { error: 'Tick "I agree" to switch to enforce mode. Nothing was changed.', status: 400 };
            try { return { changed: await service.setPolicy(key, body.value, admin.email), policy: service.policyInfo() }; }
            catch (e) { if (e.status) return { error: `${e.message} Nothing was changed.`, status: e.status }; throw e; }
        },
        // The retraining export: allowed or not (off by default), and the download (docs/RETRAINING.md).
        // Settings → Update: the approved versions (google_service_main) and their changes; the button.
        'GET /api/update': async () => updateInfo({ cfg, store, releases }),
        'POST /api/update': async (q, body, admin) => startUpdate({ cfg, store, releases, scheduler, service, admin, body, expectedProject, wrong }),
        'POST /api/training-export/allow': async (q, body, admin) => service.setTrainingExport(body.enabled === true, admin.email),
        'POST /api/training-export': async (q, body, admin) => {
            if (!((await store.getState('trainingExport')) || {}).enabled) return { error: 'The retraining export is off. An admin can allow it in Settings → Retraining.', status: 403 };
            if (exporting) return { error: 'A download is already being made. Try again in a minute.', status: 429 };
            exporting = true;
            try {
                const days = Math.min(Math.max(Math.round(Number(body.days) || 90), 1), cfg.retentionDays || 365);
                const out = await service.trainingExport({ days, falseAlarms: body.falseAlarms === true, by: admin.email });
                const c = out.counts;
                if (!out.rows.length) {
                    return { error: c.candidates ? `None of the ${c.candidates} marked emails could be read (${c.gone} no longer in a mailbox${c.failed ? `, ${c.failed} failed` : ''}).`
                        : `No emails an admin marked in the last ${days} days${body.falseAlarms === true ? '' : ' as phishing (tick "Include false alarms" for those)'}.`, status: 404 };
                }
                return { download: { body: training.toJsonl(out.rows), type: 'application/x-ndjson; charset=utf-8', filename: `spruce-retraining-${A.dayOf(Date.now())}.jsonl`,
                    headers: { 'x-spruce-examples': String(out.rows.length), 'x-spruce-phishing': String(c.phishing), 'x-spruce-genuine': String(c.genuine),
                        'x-spruce-gone': String(c.gone), 'x-spruce-failed': String(c.failed), 'x-spruce-not-reached': String(c.notReached), 'x-spruce-conflicting': String(c.conflicting) } } };
            } finally { exporting = false; }
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
                // The policy settings changed on the dashboard (at most every 30 s), before anything reads them.
                if (service.refreshPolicy) await service.refreshPolicy();
                // (a pasted email for "Check an email" can be large: its attachments come with it)
                const body = req.method === 'POST' ? await readBody(req, route === 'POST /api/check' ? CHECK_MAX_BYTES * 2 : 64 * 1024) : {};
                const out = await api[route](url.searchParams, body, admin);
                if (req.method === 'POST') cache.stale();
                if (out && typeof out.csv === 'string') return send(res, 200, out.csv, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${out.filename}"` });
                if (out && out.download) return send(res, 200, out.download.body, out.download.type, Object.assign({ 'content-disposition': `attachment; filename="${out.download.filename}"` }, out.download.headers));
                return send(res, out && out.status ? out.status : (out && out.error ? 400 : 200), Object.assign({ admin: admin.email, demo: cfg.demo, aiThreshold: cfg.aiThreshold }, out));
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
        let raws;
        ({ store, intel, raws } = await buildDemo({ cfg, now: Date.now() }));
        gmail = { labelId: async (u, n) => `Label_${n}`, modify: async () => ({}), labels: async () => ['INBOX'], search: async () => ({ ids: [], next: null }), headers: async () => ({}),
            // the made-up emails themselves, for the retraining export
            raw: async (u, id) => { const b = raws.get(id); if (!b) throw Object.assign(new Error('not found'), { status: 404 }); return { id, threadId: `t-${id}`, labelIds: ['INBOX'], historyId: null, internalDate: Date.now(), raw: b }; } };
        console.log('DEMO mode: made-up data, no Google access.');
    } else {
        const { DelegatedAuth } = require('./gmail/auth');
        const { GmailClient } = require('./gmail/client');
        store = createStore(cfg);
        gmail = new GmailClient(new DelegatedAuth(cfg));
        // The network checks: where mail is judged (the worker), and for "Check an email" (the dashboard).
        intel = require('./intel').createIntel({ cfg, store, engine: spruce.load(), version: require('../package.json').version });
    }
    spruce.load();
    const service = new Service({ cfg, store, gmail, intel });
    // The dashboard can start the group re-read job (Cloud Scheduler); the worker doesn't need to.
    const scheduler = !cfg.demo && cfg.role !== 'worker' && (cfg.renewJob || cfg.updateJob) ? require('./scheduler').createScheduler() : null;
    // The Status page reads the worker's Cloud Run settings (a stand-in in demo mode).
    const cloudrun = cfg.demo ? { service: async () => ({ iap: false, image: `demo:${VERSION}-demo`, url: '' }), invokers: async () => ['serviceAccount:spruce-invoker@demo.iam.gserviceaccount.com'] }
        : cfg.role !== 'worker' ? require('./cloudrun').createCloudRun() : null;
    http.createServer(createApp({ cfg, store, service, scheduler, cloudrun })).listen(cfg.port, () => console.log(`Listening on ${cfg.port} (${cfg.role}, ${cfg.mode} mode).`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { createApp, expectedProject };
