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
// (bash deploy/update.sh). Progress is in state/update: requested, building, done or failed.
const { compareVersions } = require('./releases');

const PKG = require('../package.json');
const RUNNING_MS = 45 * 60 * 1000;   // a build still "requested" or "building" after this has stopped

// What the page shows, and whether (and why not) the button is offered.
async function updateInfo({ cfg, store, releases }) {
    const installed = { version: PKG.version, installLevel: Number(PKG.installLevel) || 0 };
    const status = await store.getState('update');
    const running = !!(status && ['requested', 'building'].includes(status.phase) && Date.now() - status.at < RUNNING_MS);
    let newest = null, error = null;
    try { newest = await releases.newest(); } catch (e) { error = `Couldn't read the approved versions from GitHub: ${String(e.message).slice(0, 200)}`; }
    let why = null;
    if (!newest) why = error;
    else if (compareVersions(newest.version, installed.version) === 0) why = `${installed.version} is the newest approved version.`;
    else if (compareVersions(newest.version, installed.version) < 0) why = `The version installed, ${installed.version}, is newer than the newest approved one (${newest.version}): there is nothing to update to. (A version not yet approved was installed from a zip.)`;
    else if (newest.installLevel > installed.installLevel) why = `${newest.version} changes the installation itself (new permissions, jobs or settings), so it is installed from Cloud Shell: bash deploy/update.sh, from the folder you installed or last upgraded from.`;
    else if (!cfg.updateJob && !cfg.demo) why = 'Updating from the dashboard isn\'t set up yet: run bash deploy/update.sh in Cloud Shell once (it sets it up), then the next versions can be installed from here.';
    else if (running) why = `An update to ${status.version} is under way (started by ${status.by}).`;
    const newer = newest ? newest.changelog.filter(c => compareVersions(c.version, installed.version) > 0) : [];
    return { installed, newest: newest && { version: newest.version, commit: newest.commit, date: newest.date, model: newest.model, installLevel: newest.installLevel, repo: newest.repo },
        newer, changelog: newest ? newest.changelog.slice(0, 20) : [], canUpdate: !why, why, status: status || null, running, setUp: !!cfg.updateJob };
}

// The button: the checks, then the request and the job. Returns { started } or { error, status }.
async function startUpdate({ cfg, store, releases, scheduler, service, admin, body, expectedProject, wrong }) {
    if (body.agree !== true) return { error: 'Tick "I agree" to update. Nothing was changed.', status: 400 };
    const project = expectedProject(cfg);
    if (!project) return { error: 'This dashboard doesn\'t know its Google Cloud project (GOOGLE_CLOUD_PROJECT). Run bash deploy/install.sh once, then try again.', status: 409 };
    if (wrong.locked(admin.email)) return { error: 'Too many wrong answers. Try again in 10 minutes.', status: 429 };
    if (String(body.projectId || '').trim().toLowerCase() !== project.toLowerCase()) { wrong.add(admin.email); return { error: 'That isn\'t the Google Cloud project ID of this service. Nothing was changed.', status: 403 }; }
    if (String(body.email || '').trim().toLowerCase() !== String(admin.email || '').toLowerCase()) { wrong.add(admin.email); return { error: 'That isn\'t the email address you are signed in with. Nothing was changed.', status: 403 }; }
    wrong.clear(admin.email);
    const info = await updateInfo({ cfg, store, releases });
    if (!info.canUpdate) return { error: `${info.why} Nothing was changed.`, status: 409 };
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
    await service.alert('update', `${admin.email} started an update from ${from} to ${to} on the dashboard (confirmed with the project ID and their own email address, and agreed). Both services are rebuilt and redeployed with their settings as they are; it takes about 10 minutes.`, { version: to });
    return { started: { from, to } };
}

module.exports = { updateInfo, startUpdate, RUNNING_MS };
