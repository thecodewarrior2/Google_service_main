'use strict';
// The phishing lists the extension uses (its PHISH_FEEDS: OpenPhish's community feed of phishing URLs,
// Phishing Army's list of phishing domains, Sefinek's list of scam-sender addresses), matched here.
//
// Downloaded ONCE A DAY for the whole district by a Cloud Scheduler task (/tasks/sync-feeds), out of
// respect for the projects that publish them for free, and kept in the store (gzip, shared by every
// instance). Each instance loads the shared copy and looks again for a newer one every 30 minutes.
// Matching is local: nothing about an email is sent anywhere.
//
// Licenses (docs/PRIVACY.md): OpenPhish community feed terms; Phishing Army CC BY-NC 4.0
// (non-commercial use, as a school district's own protection is); Sefinek MIT.
const zlib = require('zlib');

const SYNC_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;     // at most about once a day
const RELOAD_CHECK_MS = 30 * 60 * 1000;

function createFeeds({ http, store, engine, now = () => Date.now(), log = console }) {
    const E = engine;
    let sets = null, versions = {}, lastCheck = 0, loading = null;
    const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

    // The extension's sanitizeFeed: what an entry must look like, and what a list may never contain (the
    // protected brands' own domains, cloud-storage hosts, whole personal-mail domains).
    function sanitize(feed, text) {
        const out = new Set();
        for (const raw of String(text).split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || line.startsWith('!')) continue;
            if (feed.kind === 'url') {
                const n = E.normalizeFeedUrl(line);
                const h = n && hostOf(n);
                if (!h || E.PROTECTED_DOMAINS.has(E.registrableDomain(h))) continue;
                out.add(n);
            } else if (feed.kind === 'domain') {
                const d = line.split(/\s+/).pop().toLowerCase().replace(/^\*\./, '');
                if (!E.SENDER_DOMAIN_RE.test(d) || E.PROTECTED_DOMAINS.has(E.registrableDomain(d)) || E.cloudStoragePage(`https://${d}/x.html`)) continue;
                out.add(d);
            } else if (feed.kind === 'address') {
                const a = E.normalizeSenderEntry(line.split(/[\s,;]+/)[0]);
                const d = a.slice(a.lastIndexOf('@') + 1);
                if (!a.includes('@') || (E.PROTECTED_DOMAINS.has(E.registrableDomain(d)) && !E.isPersonalMailDomain(d))) continue;
                out.add(a);
            }
            if (out.size >= E.PHISH_FEED_MAX_ENTRIES) break;
        }
        return out;
    }

    // The daily task: download each list (unless the shared copy is recent), check it, keep it.
    async function sync({ force = false } = {}) {
        const results = [];
        for (const feed of E.PHISH_FEEDS) {
            const name = `feed_${feed.id}`;
            const info = await store.blobInfo(name);
            if (!force && info && now() - info.updated < SYNC_MIN_INTERVAL_MS) { results.push({ id: feed.id, skipped: 'recent' }); continue; }
            try {
                const res = await http.request(feed.url, {}, 60000);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                if (text.length > E.PHISH_FEED_MAX_BYTES) throw new Error(`too large (${text.length} bytes)`);
                const entries = sanitize(feed, text);
                if (entries.size < E.PHISH_FEED_MIN_ENTRIES) throw new Error(`only ${entries.size} entries; the previous copy is kept`);
                const gz = zlib.gzipSync([...entries].sort().join('\n'));
                await store.putBlob(name, gz, { updated: now(), count: entries.size, name: feed.name, kind: feed.kind });
                results.push({ id: feed.id, count: entries.size });
            } catch (e) {
                results.push({ id: feed.id, error: String(e.message || e) });
                await store.addEvent({ kind: 'error', text: `${feed.name} could not be updated (${String(e.message || e).slice(0, 120)}); the previous copy is kept.` });
            }
        }
        lastCheck = 0;                                         // look for the new copy at the next use
        return { feeds: results };
    }

    async function load() {
        const parts = { url: [], domain: [], address: [] }, vers = {};
        for (const feed of E.PHISH_FEEDS) {
            const b = await store.getBlob(`feed_${feed.id}`);
            if (!b) continue;
            vers[feed.id] = b.info.updated;
            parts[feed.kind].push({ name: feed.name, list: new Set(zlib.gunzipSync(b.bytes).toString('utf8').split('\n').filter(Boolean)) });
        }
        const lookup = (ps) => ({ size: ps.reduce((n, p) => n + p.list.size, 0), get: (k) => { const p = ps.find(x => x.list.has(k)); return p ? p.name : null; } });
        sets = { url: lookup(parts.url), domain: lookup(parts.domain), address: lookup(parts.address) };
        versions = vers;
    }
    // Loads the shared copy the first time, and again when the daily task has made a newer one.
    async function ready() {
        if (sets && now() - lastCheck < RELOAD_CHECK_MS) return sets;
        if (loading) return loading;
        loading = (async () => {
            try {
                lastCheck = now();
                let newer = !sets;
                for (const feed of E.PHISH_FEEDS) { const i = await store.blobInfo(`feed_${feed.id}`); if ((i && i.updated) !== versions[feed.id]) newer = true; }
                if (newer) await load();
            } catch (e) { log.error && log.error('phishing lists:', e); if (!sets) sets = null; }
            return sets;
        })().finally(() => { loading = null; });
        return loading;
    }

    // The list that has this link (its exact address, or its site), or null. Never a whole site that is
    // shared hosting (a cloud-storage page is matched by its exact address only).
    async function urlHit(url) {
        const s = await ready();
        if (!s) return null;
        const n = E.normalizeFeedUrl(url);
        if (n && s.url.get(n)) return s.url.get(n);
        const host = hostOf(url);
        if (!host) return null;
        if (!E.cloudStoragePage(url)) for (const scheme of ['https://', 'http://']) { const hit = s.url.get(scheme + host); if (hit) return hit; }
        return domainHitIn(s, host);
    }
    function domainHitIn(s, host) {
        const parts = host.split('.');
        for (let i = 0; i < parts.length - 1; i++) { const hit = s.domain.get(parts.slice(i).join('.')); if (hit) return hit; }
        return null;
    }
    async function domainHit(host) { const s = await ready(); return s ? domainHitIn(s, String(host || '').toLowerCase()) : null; }
    async function addressHit(address) { const s = await ready(); return s ? s.address.get(E.normalizeSenderEntry(address)) : null; }
    async function status() {
        const out = [];
        for (const feed of E.PHISH_FEEDS) { const i = await store.blobInfo(`feed_${feed.id}`); out.push({ id: feed.id, name: feed.name, kind: feed.kind, updated: i ? i.updated : null, count: i ? i.count : 0 }); }
        return out;
    }
    return { sync, ready, urlHit, domainHit, addressHit, status, sanitize };
}

module.exports = { createFeeds, SYNC_MIN_INTERVAL_MS };
