'use strict';
// Secret Manager, for the one secret the dashboard manages (0.5.23): the Google Safe Browsing API key
// (deploy/install.sh makes the secret, spruce-safe-browsing-key, and lets the services' account read it, add
// a version and destroy old ones, on that secret only). A secret's value never goes anywhere else: not in
// Firestore, settings.env, the logs or an answer of the dashboard.
const { GoogleAuth } = require('google-auth-library');

const API = 'https://secretmanager.googleapis.com/v1';

// name: projects/<project>/secrets/<secret>
function createSecrets({ name, fetch: f = fetch, googleAuth = null }) {
    let auth = googleAuth;
    async function call(method, path, body) {
        auth = auth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const t = await (await auth.getClient()).getAccessToken();
        const res = await f(`${API}/${path}`, { method, headers: Object.assign({ authorization: `Bearer ${t.token || t}` }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        if (!res.ok) {
            let why = text, status = '';
            try { const e = JSON.parse(text).error || {}; why = e.message || text; status = e.status || ''; } catch (e) { /* not JSON */ }
            throw Object.assign(new Error(`Secret Manager answered HTTP ${res.status}: ${String(why).slice(0, 200)}`), { httpStatus: res.status, apiStatus: status });
        }
        return text ? JSON.parse(text) : {};
    }
    return {
        name,
        // The latest version's value and its version number, or null when there is none (never added,
        // or destroyed).
        async latest() {
            try {
                const r = await call('GET', `${name}/versions/latest:access`);
                return { value: Buffer.from((r.payload && r.payload.data) || '', 'base64').toString('utf8'), version: String(r.name || '').split('/').pop() };
            } catch (e) {
                if (e.httpStatus === 404 || e.apiStatus === 'FAILED_PRECONDITION' || e.apiStatus === 'NOT_FOUND') return null;
                throw e;
            }
        },
        // A new version with this value; then every older one is destroyed. Returns its version number.
        async replace(value) {
            const v = await call('POST', `${name}:addVersion`, { payload: { data: Buffer.from(String(value), 'utf8').toString('base64') } });
            const version = String(v.name || '').split('/').pop();
            await this.destroyAll({ except: version });
            return version;
        },
        // Every version destroyed (but `except`): the value can't be read again by anyone.
        async destroyAll({ except = null } = {}) {
            const list = await call('GET', `${name}/versions?filter=${encodeURIComponent('state:ENABLED OR state:DISABLED')}&pageSize=100`);
            let n = 0;
            for (const v of list.versions || []) {
                const id = String(v.name || '').split('/').pop();
                if (id === except) continue;
                await call('POST', `${v.name}:destroy`, {});
                n++;
            }
            return n;
        }
    };
}

module.exports = { createSecrets };
