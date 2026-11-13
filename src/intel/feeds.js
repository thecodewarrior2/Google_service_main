'use strict';
// The phishing lists (PHISH_FEEDS in vendor/spruce/shared.js: OpenPhish's community feed of phishing URLs,
// Phishing Army's list of phishing domains, HaGeZi's Threat Intelligence Feeds, TweetFeed's domains reported
// by security researchers, Sefinek's list of scam-sender addresses), matched here.
//
// Downloaded ONCE A DAY for the whole district by a Cloud Scheduler task (/tasks/sync-feeds), out of
// respect for the projects that publish them for free, and kept in the store (gzip, shared by every
// instance). Each instance loads the shared copy and looks again for a newer one every 30 minutes.
// Matching is local: nothing about an email is sent anywhere.
//
// Licenses (docs/PRIVACY.md): OpenPhish community feed terms; Phishing Army CC BY-NC 4.0
// (non-commercial use, as a school district's own protection is); HaGeZi GPL-3.0 (the list is used, not
// redistributed); TweetFeed CC0 1.0; Sefinek MIT.
const zlib = require('zlib');

const SYNC_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;     // at most about once a day
const RELOAD_CHECK_MS = 30 * 60 * 1000;
// A list "missed its download" (0.5.22) when its last download failed, or when its copy is older than this
// (the daily download isn't happening at all). The overview, Settings → About and Status say so, and the
// admins get an alert.
const STALE_MS = 48 * 60 * 60 * 1000;
// Each list's download health, in the store (state): { [id]: { lastAttempt, error, failedSince, failures } }.
const HEALTH = 'feedHealth';

function createFeeds({ http, store, engine, now = () => Date.now(), log = console }) {
    const E = engine;
    let sets = null, versions = {}, lastCheck = 0, loading = null;
    const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

    // A download as lines: plain text as it is; TweetFeed's CSV (date,user,type,value,tags,tweet) as the values of
    // its domain rows (a download that isn't that gives nothing, so the previous copy is kept).
    function linesOf(feed, text) {
        if (feed.format !== 'tweetfeed-csv') return String(text).split('\n');
        return String(text).split('\n').map(l => l.split(',')).filter(c => c.length >= 4 && c[2] === 'domain').map(c => c[3]);
    }
    // How sure a list is (PHISH_FEEDS confidence): 'report' for community reports, else 'list'.
    const CONFIDENCE = new Map(E.PHISH_FEEDS.map(f => [f.name, f.confidence || 'list']));
    const confidenceOf = (name) => CONFIDENCE.get(name) || 'list';

    // The extension's sanitizeFeed: what an entry must look like, and what a list may never contain (the
    // protected brands' own domains, cloud-storage hosts, whole personal-mail domains).
    function sanitize(feed, text) {
        const out = new Set();
        for (const raw of linesOf(feed, text)) {
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
    //   force: every list, even a recent one; retryFailed: also a list whose last download failed, even
    //   when its copy is recent; only: just these lists (ids). Each list's outcome is kept (HEALTH): a
    //   failure says since when and how often, and the next success clears it.
    //   { feeds: [{ id, name, count, kind?, added? } | { id, name, skipped } | { id, name, error, newly }], recovered: [names] }
    //   added: the entries that weren't in the previous copy (none on a list's first download).
    async function sync({ force = false, retryFailed = false, only = null } = {}) {
        const results = [], recovered = [];
        const health = Object.assign({}, (await store.getState(HEALTH).catch(() => null)) || {});
        for (const feed of E.PHISH_FEEDS) {
            if (only && !only.includes(feed.id)) continue;
            const name = `feed_${feed.id}`;
            const info = await store.blobInfo(name);
            const prev = health[feed.id] || {};
            if (!force && !(retryFailed && prev.error) && info && now() - info.updated < SYNC_MIN_INTERVAL_MS) { results.push({ id: feed.id, name: feed.name, skipped: 'recent' }); continue; }
            try {
                const res = await http.request(feed.url, {}, 60000);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                if (text.length > E.PHISH_FEED_MAX_BYTES) throw new Error(`too large (${text.length} bytes)`);
                const entries = sanitize(feed, text);
                if (entries.size < E.PHISH_FEED_MIN_ENTRIES) throw new Error(`only ${entries.size} entries; the previous copy is kept`);
                // What this download adds to the previous copy (0.5.35): delivered mail is checked again for it
                // (pipeline.js recheckFromLists). Nothing on a list's first download (everything would be new).
                let added = null;
                if (info) {
                    try {
                        const old = await store.getBlob(name);
                        if (old) {
                            const had = new Set(zlib.gunzipSync(old.bytes).toString('utf8').split('\n'));
                            added = [];
                            for (const x of entries) if (!had.has(x)) added.push(x);
                        }
                    } catch (e) { added = null; log.error && log.error(`${feed.name}, the previous copy:`, e); }
                }
                const gz = zlib.gzipSync([...entries].sort().join('\n'));
                await store.putBlob(name, gz, { updated: now(), count: entries.size, name: feed.name, kind: feed.kind });
                results.push(Object.assign({ id: feed.id, name: feed.name, count: entries.size }, added ? { kind: feed.kind, added } : {}));
                if (prev.error) {
                    recovered.push(feed.name);
                    await store.addEvent({ kind: 'lists', text: `${feed.name} downloaded again (${entries.size.toLocaleString('en-US')} entries), after missing its download since ${new Date(prev.failedSince || prev.lastAttempt || now()).toISOString().slice(0, 16).replace('T', ' ')} UTC.` });
                }
                health[feed.id] = { lastAttempt: now() };
            } catch (e) {
                const error = String(e.message || e).slice(0, 160);
                results.push({ id: feed.id, name: feed.name, error, newly: !prev.error });
                health[feed.id] = { lastAttempt: now(), error, failedSince: prev.error ? (prev.failedSince || now()) : now(), failures: (prev.error ? (prev.failures || 1) : 0) + 1 };
                await store.addEvent({ kind: 'error', text: `${feed.name} could not be updated (${error.slice(0, 120)}); the previous copy is kept.` });
            }
        }
        await store.setState(HEALTH, health).catch(e => log.error && log.error('phishing lists, health:', e));
        lastCheck = 0;                                         // look for the new copy at the next use
        return { feeds: results, recovered };
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
        // (while a newer copy is being loaded, every caller waits for it: not the old copy, 0.5.35)
        if (loading) return loading;
        if (sets && now() - lastCheck < RELOAD_CHECK_MS) return sets;
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
    // shared hosting (a cloud-storage page is matched by its exact address only), nor one of the
    // organization's own (exactOnly: a hacked school site listed whole must not flag every staff email).
    async function urlHit(url, { exactOnly = false } = {}) {
        const s = await ready();
        if (!s) return null;
        const n = E.normalizeFeedUrl(url);
        if (n && s.url.get(n)) return s.url.get(n);
        const host = hostOf(url);
        if (!host || exactOnly) return null;
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
    // Each list's state, for the dashboard: its copy (updated, count), its last download (lastAttempt, and
    // error, failedSince, failures when it failed), and missed: 'failed' (its last download failed), 'stale'
    // (its copy is older than two days: the daily download isn't happening) or null.
    async function status() {
        const out = [];
        const health = (await store.getState(HEALTH).catch(() => null)) || {};
        for (const feed of E.PHISH_FEEDS) {
            const i = await store.blobInfo(`feed_${feed.id}`);
            const hl = health[feed.id] || {};
            const updated = i ? i.updated : null;
            const missed = hl.error ? 'failed' : updated && now() - updated > STALE_MS ? 'stale' : null;
            out.push({ id: feed.id, name: feed.name, kind: feed.kind, confidence: feed.confidence || 'list', home: feed.home || null, updated, count: i ? i.count : 0,
                lastAttempt: hl.lastAttempt || null, error: hl.error || null, failedSince: hl.error ? (hl.failedSince || hl.lastAttempt || null) : null, failures: hl.error ? (hl.failures || 1) : 0, missed });
        }
        return out;
    }
    return { sync, ready, urlHit, domainHit, addressHit, status, sanitize, confidenceOf };
}

module.exports = { createFeeds, SYNC_MIN_INTERVAL_MS, STALE_MS };
