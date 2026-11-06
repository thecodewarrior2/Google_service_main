'use strict';
// Who may call what.
//   /pubsub/push   only Google Pub/Sub, with an OIDC token for PUSH_SERVICE_ACCOUNT and PUSH_AUDIENCE.
//   /tasks/*       only Cloud Scheduler, with an OIDC token for TASK_SERVICE_ACCOUNT.
//   the dashboard  only through Identity-Aware Proxy (its signed x-goog-iap-jwt-assertion header, for
//                  IAP_AUDIENCE), and only for the addresses in ADMIN_EMAILS.
// Demo mode (fake data, no Google access) lets everyone in as "demo-admin".
const { OAuth2Client } = require('google-auth-library');

const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key';
const client = new OAuth2Client();
let iapKeys = null, iapKeysAt = 0;

async function verifyOidc(req, cfg, serviceAccount, audience) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return { ok: false, why: 'no token' };
    try {
        const ticket = await client.verifyIdToken({ idToken: m[1], audience });
        const p = ticket.getPayload() || {};
        if (!p.email_verified || String(p.email || '').toLowerCase() !== serviceAccount) return { ok: false, why: `token for ${p.email || 'nobody'}` };
        return { ok: true, email: p.email };
    } catch (e) {
        return { ok: false, why: 'invalid token' };
    }
}

const verifyPush = (req, cfg) => (cfg.demo ? { ok: true, email: 'demo' } : verifyOidc(req, cfg, cfg.pushServiceAccount, cfg.pushAudience));
const verifyTask = (req, cfg) => (cfg.demo ? { ok: true, email: 'demo' } : verifyOidc(req, cfg, cfg.taskServiceAccount, cfg.pushAudience));

async function verifyAdmin(req, cfg) {
    if (cfg.demo) return { ok: true, email: 'demo-admin@example.org' };
    const jwt = req.headers['x-goog-iap-jwt-assertion'];
    if (!jwt) return { ok: false, status: 401, why: 'not signed in through Identity-Aware Proxy' };
    try {
        if (!iapKeys || Date.now() - iapKeysAt > 60 * 60 * 1000) { iapKeys = (await client.getIapPublicKeys()).pubkeys; iapKeysAt = Date.now(); }
        const ticket = await client.verifySignedJwtWithCertsAsync(String(jwt), iapKeys, cfg.iapAudience, ['https://cloud.google.com/iap']);
        const email = String((ticket.getPayload() || {}).email || '').toLowerCase().replace(/^accounts\.google\.com:/, '');
        if (!cfg.adminEmails.includes(email)) return { ok: false, status: 403, why: `${email} is not an administrator of this service` };
        return { ok: true, email };
    } catch (e) {
        return { ok: false, status: 401, why: 'invalid Identity-Aware Proxy signature' };
    }
}

module.exports = { verifyPush, verifyTask, verifyAdmin, IAP_KEYS_URL };
