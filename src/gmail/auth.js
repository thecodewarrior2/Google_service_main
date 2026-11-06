'use strict';
// Access tokens to act as a user of the domain (domain-wide delegation), WITHOUT a key file: the
// service's own Cloud Run identity asks Google's IAM to sign the token request for the delegated
// service account (iamcredentials signJwt). No private key is ever downloaded or stored, so there is
// none to leak; the right to sign is an IAM role that can be revoked at any time (docs/DEPLOY.md).
const { GoogleAuth } = require('google-auth-library');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = {
    gmail: 'https://www.googleapis.com/auth/gmail.modify',
    directory: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
    groupMembers: 'https://www.googleapis.com/auth/admin.directory.group.member.readonly'
};

class DelegatedAuth {
    constructor(cfg, opts = {}) {
        this.sa = cfg.delegatedServiceAccount;
        this.fetch = opts.fetch || fetch;
        this.google = opts.googleAuth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        this.cache = new Map();          // `${scope}|${user}` → { token, exp }
    }
    async tokenFor(user, scope = SCOPES.gmail) {
        const key = `${scope}|${user}`;
        const hit = this.cache.get(key);
        if (hit && hit.exp - Date.now() > 5 * 60 * 1000) return hit.token;
        const now = Math.floor(Date.now() / 1000);
        const payload = JSON.stringify({ iss: this.sa, sub: user, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 });
        const own = await (await this.google.getClient()).getAccessToken();
        const signed = await this.fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.sa)}:signJwt`, {
            method: 'POST', headers: { authorization: `Bearer ${own.token || own}`, 'content-type': 'application/json' }, body: JSON.stringify({ payload })
        });
        if (!signed.ok) throw new Error(`signJwt for ${this.sa}: HTTP ${signed.status} ${(await signed.text()).slice(0, 200)}`);
        const { signedJwt } = await signed.json();
        const res = await this.fetch(TOKEN_URL, {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt }).toString()
        });
        if (!res.ok) throw new Error(`token for ${user}: HTTP ${res.status} ${(await res.text()).slice(0, 200)} (is domain-wide delegation set up for ${scope}?)`);
        const j = await res.json();
        this.cache.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
        if (this.cache.size > 20000) this.cache.delete(this.cache.keys().next().value);
        return j.access_token;
    }
}

module.exports = { DelegatedAuth, SCOPES };
