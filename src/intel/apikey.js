'use strict';
// An optional service's key (0.5.37: Spamhaus's Data Query Service, abuse.ch), as the Safe Browsing key is
// kept (src/intel/sbkey.js): an admin adds it on its Settings page; it is tested first, then kept in Secret
// Manager (src/secrets.js) and nowhere else. Firestore keeps only that a key is saved, its version, who saved
// it and when (state/<id>Key), so every instance notices a new or removed key within CHECK_MS and reads it
// again from Secret Manager; and how its lookups go (state/<id>Health). Never the key itself: not in
// Firestore, settings.env, the logs or an answer of the dashboard.
const CHECK_MS = 30 * 1000;
const HEALTH_EVERY_MS = 60 * 60 * 1000;

// id: 'spamhaus' | 'abusech'; label: what the dashboard calls it; secrets: src/secrets.js (or memorySecrets()),
// null when the secret isn't set up (an install before 0.5.37); test(key): { ok } or { ok: false, why, fix };
// keyRe: what a key looks like; offline: never call the service (the demo).
function createApiKey({ id, label, store, secrets = null, test, keyRe, now = () => Date.now(), log = console, offline = false, upgradeWords = 'upgrade from Cloud Shell once (bash deploy/upgrade.sh from the unzipped new version); it sets up Secret Manager for it.' }) {
    const META = `${id}Key`, HEALTH = `${id}Health`;
    let cache = { version: undefined, key: null }, checkedAt = 0, loading = null;
    let health = null, healthWrittenAt = 0, onRefused = null;

    async function refresh() {
        checkedAt = now();
        try {
            const m = await store.getState(META);
            const v = m && m.set ? String(m.version || '') : '';
            if (v === cache.version) return;
            if (!v) { cache = { version: '', key: null }; return; }
            const s = await secrets.latest();
            cache = { version: v, key: s ? s.value : null };
        } catch (e) { log.error && log.error(`${label} key:`, String(e.message || e).slice(0, 200)); }   // (never the key)
    }
    async function get() {
        if (!secrets) return null;
        if (cache.version === undefined || now() - checkedAt >= CHECK_MS) {
            if (!loading) loading = refresh().finally(() => { loading = null; });
            await loading;
        }
        return cache.key || null;
    }
    async function save(key, by) {
        if (!secrets) throw Object.assign(new Error(`The key can't be saved from here yet: ${upgradeWords}`), { status: 409 });
        key = String(key || '').trim();
        if (!keyRe.test(key)) throw Object.assign(new Error(`That doesn't look like a ${label} key.`), { status: 400 });
        const t = offline ? { ok: true, offline: true } : await test(key);
        if (!t.ok) throw Object.assign(new Error(`${t.why} ${t.fix || ''}`.trim()), { status: 400 });
        const version = await secrets.replace(key);
        await store.setState(META, { set: true, version, by, at: now() });
        cache = { version, key }; checkedAt = now();
        await noteResult(true, null, { force: true });
        return { version, tested: !t.offline };
    }
    async function remove(by) {
        if (!secrets) throw Object.assign(new Error('There is no key saved on the dashboard.'), { status: 409 });
        await secrets.destroyAll();
        await store.setState(META, { set: false, version: '', by, at: now() });
        cache = { version: '', key: null }; checkedAt = now();
        await store.setState(HEALTH, null).catch(() => {});
        health = null;
    }
    // A lookup's or download's outcome: noted when it changes, and hourly; a refusal is an alert (the server
    // passes the daily alert: setAlert).
    async function noteResult(ok, error, { force = false, alertText = null } = {}) {
        const changed = !health || health.ok !== ok;
        health = { ok, at: now(), error: ok ? null : String(error || '').slice(0, 200) };
        if (!ok && onRefused) { try { await onRefused(alertText || `${label} refused the saved key (${health.error}). Settings → ${label}: check the key, or save a new one.`); } catch (e) { /* told next time */ } }
        if (!force && !changed && now() - healthWrittenAt < HEALTH_EVERY_MS) return;
        healthWrittenAt = now();
        try { await store.setState(HEALTH, health); } catch (e) { /* noted next time */ }
    }
    async function status() {
        const [m, h] = await Promise.all([store.getState(META).catch(() => null), store.getState(HEALTH).catch(() => null)]);
        return { available: !!secrets, saved: m && m.set ? { by: m.by || '', at: m.at || null } : null, removed: m && !m.set && m.at ? { by: m.by || '', at: m.at } : null, health: h || null, offline };
    }
    return { id, label, get, save, remove, noteResult, status, setAlert(fn) { onRefused = fn; } };
}

module.exports = { createApiKey };
