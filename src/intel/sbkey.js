'use strict';
// The Google Safe Browsing API key (0.5.23). An admin adds it on Settings → Safe Browsing: it is tested with
// Google first (a lookup of Google's own test address, nothing from anyone's mail), then kept in Secret
// Manager (src/secrets.js) and nowhere else. Firestore keeps only that a key is saved, its version, who saved
// it and when (state/safeBrowsingKey), so every instance notices a new or removed key within CHECK_MS and
// reads it again from Secret Manager. Without the secret (an install before 0.5.23), SAFE_BROWSING_KEY from
// the environment is used, as before. Whether lookups work is noted too (state/safeBrowsingHealth).
const META = 'safeBrowsingKey';
const HEALTH = 'safeBrowsingHealth';
const CHECK_MS = 30 * 1000;
const HEALTH_EVERY_MS = 60 * 60 * 1000;
// A Google API key: letters, digits, "-" and "_" (today "AIza" and 35 more). Checked loosely: Google decides.
const KEY_RE = /^[A-Za-z0-9_-]{30,100}$/;
const SB_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
// Google's own test page for Safe Browsing (it is always "malware"): what a key is tested with.
const TEST_URL = 'http://malware.testing.google.test/testing/malware/';

// What Google's answer to a key means, and what to do: { why, fix }.
function keyProblem(status, err) {
    const reason = String(((err.details || []).find(d => d && d.reason) || {}).reason || '');
    const msg = String(err.message || '');
    if (reason === 'API_KEY_INVALID' || /API key not valid|API_KEY_INVALID/i.test(msg)) return { why: 'Google says this isn\'t a valid API key.', fix: 'Copy the key again from APIs & Services → Credentials (Show key).' };
    if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(msg)) return { why: 'The Safe Browsing API isn\'t enabled in the key\'s project.', fix: 'In the Google Cloud console, open APIs & Services → Library, search for "Safe Browsing API" and click Enable, in the project the key belongs to. Then try again (it can take a few minutes).' };
    // (the application restrictions first: their messages say "blocked" too)
    if (reason === 'API_KEY_IP_ADDRESS_BLOCKED' || reason === 'API_KEY_HTTP_REFERRER_BLOCKED' || (!reason && /referer|referrer|IP address/i.test(msg))) return { why: 'The key has an application restriction (websites or IP addresses) that blocks this service.', fix: 'Edit the key and set Application restrictions to None (the service has no fixed address); keep the API restriction to the Safe Browsing API.' };
    if (reason === 'API_KEY_SERVICE_BLOCKED' || /blocked/i.test(msg)) return { why: 'The key\'s API restrictions don\'t allow the Safe Browsing API.', fix: 'Edit the key (APIs & Services → Credentials), and under API restrictions add "Safe Browsing API".' };
    if (status === 429) return { why: 'Google says the key\'s quota is used up for now.', fix: 'Try again later, or check the quota in APIs & Services → Safe Browsing API → Quotas.' };
    return { why: `Google answered HTTP ${status}${msg ? `: ${msg.slice(0, 160)}` : ''}.`, fix: 'Check the key in APIs & Services → Credentials, and that the Safe Browsing API is enabled.' };
}

// A stand-in for Secret Manager (demo mode and the tests): the value stays in this process.
function memorySecrets() {
    let versions = [], n = 0;
    return {
        name: 'memory',
        async latest() { const v = versions[versions.length - 1]; return v ? { value: v.value, version: v.version } : null; },
        async replace(value) { n++; versions = [{ version: String(n), value: String(value) }]; return String(n); },
        async destroyAll() { const k = versions.length; versions = []; return k; }
    };
}

// cfg: the configuration (safeBrowsingKey: the environment's key, if any); secrets: src/secrets.js (or
// memorySecrets()), null when the secret isn't set up; http: src/intel/http.js; offline: never call Google (the
// demo: a key is only checked for its form).
function createSafeBrowsingKey({ cfg, store, secrets = null, http = null, now = () => Date.now(), log = console, offline = false }) {
    const envKey = cfg.safeBrowsingKey || '';
    let cache = { version: undefined, key: null }, checkedAt = 0, loading = null;
    let health = null, healthWrittenAt = 0;

    async function refresh() {
        checkedAt = now();
        try {
            const m = await store.getState(META);
            const v = m && m.set ? String(m.version || '') : '';
            if (v === cache.version) return;
            if (!v) { cache = { version: '', key: null }; return; }
            const s = await secrets.latest();
            cache = { version: v, key: s ? s.value : null };
        } catch (e) { log.error && log.error('Safe Browsing key:', String(e.message || e).slice(0, 200)); }   // (never the key)
    }
    // The key in use, or null: the one saved on the dashboard, else SAFE_BROWSING_KEY.
    async function get() {
        if (!secrets) return envKey || null;
        if (cache.version === undefined || now() - checkedAt >= CHECK_MS) {
            if (!loading) loading = refresh().finally(() => { loading = null; });
            await loading;
        }
        return cache.key || envKey || null;
    }
    // A key tried with Google: { ok: true } or { ok: false, why, fix }.
    async function test(key) {
        if (!KEY_RE.test(String(key || ''))) return { ok: false, why: 'That doesn\'t look like a Google API key (letters, digits, "-" and "_", usually starting with AIza).', fix: 'Copy it again from APIs & Services → Credentials (Show key).' };
        if (offline) return { ok: true, offline: true };
        const body = { client: { clientId: 'spruce-mail-protection', clientVersion: '0' }, threatInfo: { threatTypes: ['MALWARE'], platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: [{ url: TEST_URL }] } };
        let res;
        // The key in a header, not the address: addresses end up in logs.
        try { res = await http.request(SB_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, 8000); }
        catch (e) { return { ok: false, why: 'Google\'s Safe Browsing service couldn\'t be reached.', fix: 'Try again in a minute.' }; }
        if (res.ok) return { ok: true };
        let err = {};
        try { err = ((await res.json()) || {}).error || {}; } catch (e) { /* not JSON */ }
        return Object.assign({ ok: false }, keyProblem(res.status, err));
    }
    // An admin saves a key: tested, then kept in Secret Manager (older versions destroyed).
    async function save(key, by) {
        if (!secrets) throw Object.assign(new Error('The key can\'t be saved from here yet: upgrade from Cloud Shell once (bash deploy/update.sh (or, from an unzipped new version, bash deploy/upgrade.sh)); it sets up Secret Manager for it.'), { status: 409 });
        key = String(key || '').trim();
        const t = await test(key);
        if (!t.ok) throw Object.assign(new Error(`${t.why} ${t.fix}`), { status: 400 });
        const version = await secrets.replace(key);
        await store.setState(META, { set: true, version, by, at: now() });
        cache = { version, key }; checkedAt = now();
        await noteResult(true, null, { force: true });
        return { version, tested: !t.offline };
    }
    // An admin removes it: every version destroyed.
    async function remove(by) {
        if (!secrets) throw Object.assign(new Error('There is no key saved on the dashboard.'), { status: 409 });
        await secrets.destroyAll();
        await store.setState(META, { set: false, version: '', by, at: now() });
        cache = { version: '', key: null }; checkedAt = now();
        await store.setState(HEALTH, null).catch(() => {});
        health = null;
    }
    // A lookup's outcome (threats.js): noted when it changes from working to failing or back, and hourly.
    async function noteResult(ok, error, { force = false } = {}) {
        const changed = !health || health.ok !== ok;
        health = { ok, at: now(), error: ok ? null : String(error || '').slice(0, 160) };
        if (!force && !changed && now() - healthWrittenAt < HEALTH_EVERY_MS) return;
        healthWrittenAt = now();
        try { await store.setState(HEALTH, health); } catch (e) { /* noted next time */ }
    }
    // For Settings: whether a key can be saved here, whether one is (who, when; never the key), the
    // environment's, and how the lookups went.
    async function status() {
        const [m, h] = await Promise.all([store.getState(META).catch(() => null), store.getState(HEALTH).catch(() => null)]);
        return { available: !!secrets, saved: m && m.set ? { by: m.by || '', at: m.at || null } : null, removed: m && !m.set && m.at ? { by: m.by || '', at: m.at } : null,
            envKey: !!envKey, health: h || null, offline };
    }
    return { get, test, save, remove, noteResult, status };
}

module.exports = { createSafeBrowsingKey, memorySecrets, keyProblem, KEY_RE, TEST_URL, META, HEALTH };
