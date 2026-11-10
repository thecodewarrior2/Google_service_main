'use strict';
// Cloud Run, read-only, for the dashboard's Status page: whether Identity-Aware Proxy is off on the
// worker, who may call it, and which build it runs. Needs the Cloud Run Viewer role for the service
// account (deploy/install.sh).
const { GoogleAuth } = require('google-auth-library');

const API = 'https://run.googleapis.com/v2';

function createCloudRun({ fetch: f = fetch, googleAuth = null } = {}) {
    let auth = googleAuth;
    async function call(path) {
        auth = auth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const t = await (await auth.getClient()).getAccessToken();
        const res = await f(`${API}/${path}`, { headers: { authorization: `Bearer ${t.token || t}` } });
        const text = await res.text();
        if (!res.ok) {
            let why = text;
            try { why = JSON.parse(text).error.message || text; } catch (e) { /* not JSON */ }
            throw new Error(`Cloud Run answered HTTP ${res.status}: ${String(why).slice(0, 200)}`);
        }
        return text ? JSON.parse(text) : {};
    }
    return {
        // { iap, image, url } of a service.
        async service(project, region, name) {
            const s = await call(`projects/${project}/locations/${region}/services/${name}`);
            const c = (s.template && s.template.containers && s.template.containers[0]) || {};
            return { iap: !!s.iapEnabled, image: c.image || '', url: s.uri || '' };
        },
        // The members with roles/run.invoker on a service.
        async invokers(project, region, name) {
            const p = await call(`projects/${project}/locations/${region}/services/${name}:getIamPolicy`);
            return ((p.bindings || []).find(b => b.role === 'roles/run.invoker') || {}).members || [];
        }
    };
}

module.exports = { createCloudRun };
