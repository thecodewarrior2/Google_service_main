'use strict';
// Settings → Update: from the dashboard, the newest approved version (google_service_main), as
// deploy/update.sh does from Cloud Shell, for versions that change only the service, not the installation.
//
// The dashboard can't deploy anything itself. It records the request (the version and its exact commit,
// state/updateRequest) and runs the spruce-update job (UPDATE_JOB), which deploy/install.sh made and only
// it can change. That job starts a Cloud Build as spruce-updater, whose steps (deploy/cloud-update.sh,
// taken from google_service_main) check the request, check that the commit is on google_service_main's main
// branch and newer than what runs, build it, and redeploy both services with their settings as they are.
//
// To start one an admin ticks the agreement and types the Google Cloud project ID and their own email
// address. A version whose installLevel (package.json) is higher than the one installed changes the
// installation itself (permissions, jobs, settings): that one is updated from Cloud Shell
// (bash deploy/update.sh). Progress is in state/update: requested, building, done or failed, and in the
// page's answer as progress (never status: the server takes a status as the HTTP status code).
//
// A manual install (0.5.24): the installation's level is the spruce-install-level label install.sh puts on
// the services (read from Cloud Run, as the update build itself checks it), else this version's own. When
// the newest approved version needs a higher level, the page says it must be installed from Cloud Shell and
// keeps the button off, for that version and every later one (a level is never lowered), until a manual
// install raises the installation's level. It is noted when first seen (state/manualInstall: since when),
// and the admins are alerted once per version, by the page or by the hourly job, whichever sees it first.
const fs = require('fs');
const path = require('path');
const { compareVersions, modelSourceOf } = require('./releases');

const PKG = require('../package.json');
// The AI model this version runs: its version and where its image build downloaded it (VENDOR.json).
const INSTALLED_MODEL = (() => {
    try { const v = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'vendor', 'spruce', 'VENDOR.json'), 'utf8')); return { model: v.model || null, modelSource: modelSourceOf(v) }; }
    catch (e) { return { model: null, modelSource: null }; }
})();
const RUNNING_MS = 45 * 60 * 1000;   // a build still "requested" or "building" after this has stopped
const LEVEL_CACHE_MS = 10 * 60 * 1000;
let levelCache = null;

// The installation's level, and where it was read: { level, from: 'cloud-run' | 'version' }. Never lower
// than this version's own (it was installed at that level at least).
async function installedLevel({ cfg, cloudrun, now = Date.now() }) {
    const own = Number(PKG.installLevel) || 0;
    if (!cloudrun || !cfg.project || !cfg.region) return { level: own, from: 'version' };
    if (levelCache && now - levelCache.at < LEVEL_CACHE_MS) return levelCache.value;
    let value = { level: own, from: 'version' };
    try {
        const s = await cloudrun.service(cfg.project, cfg.region, 'spruce-worker');
        const n = parseInt(String((s.labels || {})['spruce-install-level'] || ''), 10);
        if (Number.isFinite(n)) value = { level: Math.max(n, own), from: 'cloud-run' };
    } catch (e) { /* the version's own */ }
    levelCache = { at: now, value };
    return value;
}

// A newer approved version that needs a manual install, or null.
function manualInstallOf(newest, installed) {
    if (!newest || compareVersions(newest.version, installed.version) <= 0 || !(newest.installLevel > installed.installLevel)) return null;
    return { version: newest.version, needs: newest.installLevel, installedLevel: installed.installLevel, levelFrom: installed.levelFrom };
}
const manualText = (m) => `Version ${m.version} is approved, but it changes the installation itself (new permissions, jobs or settings: installation level ${m.needs}; this installation is at ${m.installedLevel}), so it must be installed from Cloud Shell: bash deploy/update.sh, from the folder you installed or last upgraded from. Until then, Settings → Update installs nothing, neither ${m.version} nor any later version.`;

// Noted when first seen, cleared once installed; the alert once per version (whichever instance sees it first).
// Returns { since } while one is waiting, or null.
async function noteManualInstall({ store, manual, alert = null, now = Date.now() }) {
    const cur = await store.getState('manualInstall').catch(() => null);
    if (!manual) { if (cur) await store.setState('manualInstall', null); return null; }
    const rec = { version: manual.version, needs: manual.needs, installedLevel: manual.installedLevel, since: (cur && cur.since) || now };
    if (!cur || cur.version !== rec.version || cur.needs !== rec.needs || cur.installedLevel !== rec.installedLevel) await store.setState('manualInstall', rec);
    if (alert && await store.setStateIfUnset(`manualInstallAlert-${manual.version}`, { at: now })) await alert(manualText(manual));
    return rec;
}

// The hourly job's look (worker): the newest approved version against the installation. { manual } or null.
async function checkManualInstall({ cfg, store, releases, cloudrun = null, alert = null }) {
    const newest = await releases.newest({ freshAfter: await sharedCheckAt(store) });
    const lv = await installedLevel({ cfg, cloudrun });
    const manual = manualInstallOf(newest, { version: PKG.version, installLevel: lv.level, levelFrom: lv.from });
    const rec = await noteManualInstall({ store, manual, alert });
    return rec ? { manual: rec } : null;
}

// Settings → Update's Check again (0.5.38): GitHub asked now, by any admin, at most once every CHECK_GAP_MS for
// the whole dashboard (every instance, through state/releasesCheckedAt), whoever presses it and however often;
// each admin at most CHECK_PER_ADMIN times an hour. A press too soon is refused, saying when it can be pressed
// again; GitHub isn't asked. The time is kept before GitHub is asked, so a failing GitHub isn't asked faster.
const CHECK_GAP_MS = 60 * 1000;
const CHECK_PER_ADMIN = 10;
const sharedCheckAt = async (store) => Number(await store.getState('releasesCheckedAt').catch(() => 0)) || 0;
const checksBy = new Map();   // admin → times of their checks in the last hour (this instance)
async function checkNow({ cfg, store, releases, cloudrun = null, alert = null, admin, now = Date.now() }) {
    const last = await sharedCheckAt(store);
    const wait = last + CHECK_GAP_MS - now;
    if (wait > 0) return { error: `GitHub was asked ${Math.max(1, Math.round((now - last) / 1000))} seconds ago. Check again in ${Math.ceil(wait / 1000)} seconds.`, status: 429, retryAfter: Math.ceil(wait / 1000) };
    const mine = (checksBy.get(admin) || []).filter(t => now - t < 60 * 60 * 1000);
    if (mine.length >= CHECK_PER_ADMIN) return { error: `You checked ${CHECK_PER_ADMIN} times in the last hour. Check again later: the page also asks GitHub by itself every 10 minutes.`, status: 429, retryAfter: Math.ceil((mine[0] + 60 * 60 * 1000 - now) / 1000) };
    mine.push(now); checksBy.set(admin, mine);
    if (checksBy.size > 1000) checksBy.delete(checksBy.keys().next().value);
    await store.setState('releasesCheckedAt', now);
    try { await releases.newest({ fresh: true }); }
    catch (e) { /* updateInfo says what went wrong */ }
    return Object.assign(await updateInfo({ cfg, store, releases, cloudrun, alert }), { checked: true });
}

// What the page shows, and whether (and why not) the button is offered.
async function updateInfo({ cfg, store, releases, cloudrun = null, alert = null }) {
    const lv = await installedLevel({ cfg, cloudrun });
    const installed = { version: PKG.version, installLevel: lv.level, levelFrom: lv.from, ...INSTALLED_MODEL };
    // The last update's progress, when it is about a newer version (or is the one installed, done). One
    // about a version already installed or passed (installed from Cloud Shell since, say) is history.
    const last = await store.getState('update');
    const status = last && (compareVersions(last.version, installed.version) > 0 || (last.phase === 'done' && compareVersions(last.version, installed.version) === 0)) ? last : null;
    const running = !!(status && ['requested', 'building'].includes(status.phase) && Date.now() - status.at < RUNNING_MS);
    let newest = null, error = null;
    // (an admin's Check again on any instance makes every instance read GitHub again: 0.5.38)
    const shared = await sharedCheckAt(store);
    try { newest = await releases.newest({ freshAfter: shared }); } catch (e) { error = `Couldn't read the approved versions from GitHub: ${String(e.message).slice(0, 200)}`; }
    let why = null;
    if (!newest) why = error;
    else if (compareVersions(newest.version, installed.version) === 0) why = `${installed.version} is the newest approved version.`;
    else if (compareVersions(newest.version, installed.version) < 0) why = `The version installed, ${installed.version}, is newer than the newest approved one (${newest.version}): there is nothing to update to. (A version not yet approved was installed from a zip.)`;
    else if (newest.installLevel > installed.installLevel) why = `${newest.version} changes the installation itself (new permissions, jobs or settings), so it is installed from Cloud Shell: bash deploy/update.sh, from the folder you installed or last upgraded from. Until then no update is installed from here, neither ${newest.version} nor any later version.`;
    else if (!cfg.updateJob && !cfg.demo) why = 'Updating from the dashboard isn\'t set up yet: run bash deploy/update.sh in Cloud Shell once (it sets it up), then the next versions can be installed from here.';
    else if (running) why = `An update to ${status.version} is under way (started by ${status.by}).`;
    const newer = newest ? newest.changelog.filter(c => compareVersions(c.version, installed.version) > 0) : [];
    // A manual install waiting: noted (since when), the admins alerted once; the page keeps the button off.
    let manualInstall = null;
    if (newest) {
        const m = manualInstallOf(newest, installed);
        const rec = await noteManualInstall({ store, manual: m, alert }).catch(() => null);
        if (m) manualInstall = Object.assign({}, m, { since: rec ? rec.since : null, command: 'bash deploy/update.sh' });
    }
    return { installed, newest: newest && { version: newest.version, commit: newest.commit, date: newest.date, model: newest.model, modelSource: newest.modelSource || null, installLevel: newest.installLevel, repo: newest.repo },
        newer, changelog: newest ? newest.changelog.slice(0, 20) : [], canUpdate: !why, why, manualInstall, progress: status || null, running, setUp: !!cfg.updateJob, demo: !!cfg.demo,
        // When GitHub was asked for this answer, how long it is kept, and when Check again can be pressed (0.5.38).
        checkedAt: newest ? newest.checkedAt || null : null, keptMs: releases.CACHE_MS || null, nextCheckAt: shared ? shared + CHECK_GAP_MS : null };
}

// The button: the checks, then the request and the job. Returns { started } or { error, status }.
async function startUpdate({ cfg, store, releases, scheduler, service, admin, body, expectedProject, wrong, cloudrun = null }) {
    if (body.agree !== true) return { error: 'Tick "I agree" to update. Nothing was changed.', status: 400 };
    const project = expectedProject(cfg);
    if (!project) return { error: 'This dashboard doesn\'t know its Google Cloud project (GOOGLE_CLOUD_PROJECT). Run bash deploy/install.sh once, then try again.', status: 409 };
    // (each wrong entry noted in Activity, 0.5.30; what was typed never)
    const what = `the version installed (an update to ${String(body.version || 'the newest approved version').slice(0, 20)})`;
    if (wrong.locked(admin.email)) { if (wrong.lockedTry) await wrong.lockedTry(admin.email, what); return { error: 'Too many wrong answers. Try again in 10 minutes.', status: 429 }; }
    if (String(body.projectId || '').trim().toLowerCase() !== project.toLowerCase()) { await wrong.add(admin.email, what); return { error: 'That isn\'t the Google Cloud project ID of this service. Nothing was changed.', status: 403 }; }
    if (String(body.email || '').trim().toLowerCase() !== String(admin.email || '').toLowerCase()) { await wrong.add(admin.email, what, 'email address (not the one they are signed in with)'); return { error: 'That isn\'t the email address you are signed in with. Nothing was changed.', status: 403 }; }
    wrong.clear(admin.email);
    const info = await updateInfo({ cfg, store, releases, cloudrun });
    // (refused here too, whatever the page showed: a manual install waiting, or anything else)
    if (!info.canUpdate) return { error: `${info.manualInstall ? 'Manual install required. ' : ''}${info.why} Nothing was changed.`, status: 409 };
    if (body.version && body.version !== info.newest.version) return { error: `The newest approved version is now ${info.newest.version}: read its changes, then try again. Nothing was changed.`, status: 409 };
    const from = info.installed.version, to = info.newest.version, at = Date.now();
    if (cfg.demo) return { started: { from, to, demo: true } };
    await store.setState('updateRequest', { version: to, commit: info.newest.commit, by: admin.email, at });
    await store.setState('update', { phase: 'requested', version: to, from, by: admin.email, at });
    try { await scheduler.run(cfg.updateJob); }
    catch (e) {
        await store.setState('updateRequest', null);
        await store.setState('update', { phase: 'failed', version: to, from, by: admin.email, at, message: `the spruce-update job couldn't be started: ${String(e.message).slice(0, 200)}` });
        return { error: `The update couldn't be started: ${String(e.message).slice(0, 200)}`, status: 502 };
    }
    await service.adminNotice('update', `${admin.email} started an update from ${from} to ${to} on the dashboard (confirmed with the project ID and their own email address, and agreed). Both services are rebuilt and redeployed with their settings as they are; it takes about 10 minutes.`, { version: to });
    return { started: { from, to } };
}

module.exports = { updateInfo, startUpdate, checkNow, checkManualInstall, installedLevel, manualInstallOf, RUNNING_MS, CHECK_GAP_MS, CHECK_PER_ADMIN, _resetLevelCache: () => { levelCache = null; }, _resetChecks: () => checksBy.clear() };
