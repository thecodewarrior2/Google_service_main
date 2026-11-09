'use strict';
// Cloud Scheduler, for the dashboard's "Update group membership now": it runs the spruce-renew-watches
// job (RENEW_JOB), which calls the worker as it does every day. The dashboard never calls the worker
// itself: only Pub/Sub and Cloud Scheduler may (docs/ARCHITECTURE.md). The service account needs the
// Cloud Scheduler Job Runner and Viewer roles (deploy/install.sh).
const { GoogleAuth } = require('google-auth-library');

const API = 'https://cloudscheduler.googleapis.com/v1';

function createScheduler({ fetch: f = fetch, googleAuth = null } = {}) {
    let auth = googleAuth;
    async function call(method, path) {
        auth = auth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const t = await (await auth.getClient()).getAccessToken();
        const res = await f(`${API}/${path}`, { method, headers: { authorization: `Bearer ${t.token || t}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        const text = await res.text();
        if (!res.ok) {
            let why = text;
            try { why = JSON.parse(text).error.message || text; } catch (e) { /* not JSON */ }
            throw new Error(`Cloud Scheduler answered HTTP ${res.status}: ${String(why).slice(0, 200)}`);
        }
        return text ? JSON.parse(text) : {};
    }
    return {
        // Starts the job now (projects/…/locations/…/jobs/…).
        run: (job) => call('POST', `${job}:run`),
        // Its last run: when it started, and whether it reached the service (code 0) or not.
        async lastRun(job) {
            const j = await call('GET', job);
            return { state: j.state || null, at: j.lastAttemptTime ? Date.parse(j.lastAttemptTime) : null, code: (j.status && j.status.code) || 0 };
        }
    };
}

module.exports = { createScheduler };
