'use strict';
// Who may call what.
//   /pubsub/push   only Google Pub/Sub, with an OIDC token for PUSH_SERVICE_ACCOUNT and PUSH_AUDIENCE.
//   /tasks/*       only Cloud Scheduler, with an OIDC token for TASK_SERVICE_ACCOUNT.
//   the dashboard  only through Identity-Aware Proxy (its signed x-goog-iap-jwt-assertion header, for
//                  IAP_AUDIENCE), and only for the addresses in ADMIN_EMAILS or the members of ADMIN_GROUP.
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

// Whether a signed-in address may use the dashboard: listed in ADMIN_EMAILS, or a member of ADMIN_GROUP
// (an account in the organization's own domains; checked with Google, remembered a few minutes).
// When the group can't be checked, the answer is no.
async function authorizeAdmin(email, cfg, groupCheck) {
    if (cfg.adminEmails.includes(email)) return { ok: true, email };
    const denied = { ok: false, status: 403, why: `${email} is not an administrator of this service` };
    if (!cfg.adminGroups.length || !groupCheck || !cfg.orgDomains.includes(email.split('@')[1])) return denied;
    try { return (await groupCheck(email)) ? { ok: true, email } : denied; }
    catch (e) { return { ok: false, status: 503, why: `couldn't check the admin group: ${String(e.message).slice(0, 160)}` }; }
}

// Group membership answers, remembered: yes for 5 minutes, no for 1 (so someone just added gets in soon).
function adminGroupCheck(cfg, gmail, now = () => Date.now()) {
    const cache = new Map();
    return async (email) => {
        const hit = cache.get(email);
        if (hit && now() - hit.at < (hit.yes ? 5 : 1) * 60 * 1000) return hit.yes;
        let yes = false;
        for (const g of cfg.adminGroups) if (await gmail.hasMember(cfg.directoryAdmin, g, email)) { yes = true; break; }
        cache.set(email, { yes, at: now() });
        if (cache.size > 1000) cache.delete(cache.keys().next().value);
        return yes;
    };
}

async function verifyAdmin(req, cfg, groupCheck) {
    if (cfg.demo) return { ok: true, email: 'demo-admin@example.org' };
    const jwt = req.headers['x-goog-iap-jwt-assertion'];
    if (!jwt) return { ok: false, status: 401, why: 'not signed in through Identity-Aware Proxy' };
    let email;
    try {
        if (!iapKeys || Date.now() - iapKeysAt > 60 * 60 * 1000) { iapKeys = (await client.getIapPublicKeys()).pubkeys; iapKeysAt = Date.now(); }
        const ticket = await client.verifySignedJwtWithCertsAsync(String(jwt), iapKeys, cfg.iapAudience, ['https://cloud.google.com/iap']);
        email = String((ticket.getPayload() || {}).email || '').toLowerCase().replace(/^accounts\.google\.com:/, '');
    } catch (e) {
        return { ok: false, status: 401, why: 'invalid Identity-Aware Proxy signature' };
    }
    if (!email) return { ok: false, status: 401, why: 'no address in the Identity-Aware Proxy signature' };
    return authorizeAdmin(email, cfg, groupCheck);
}

module.exports = { verifyPush, verifyTask, verifyAdmin, authorizeAdmin, adminGroupCheck, IAP_KEYS_URL };
