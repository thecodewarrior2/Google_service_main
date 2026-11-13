'use strict';
// The approved versions, for the dashboard's Settings → Update: what google_service_main (RELEASES_REPO,
// public on GitHub) holds now. Its newest commit on main, and from that commit the version and its
// installLevel (package.json), the AI model (vendor/spruce/VENDOR.json) and the changelog. Read anonymously
// and kept 10 minutes; nothing about this installation is sent (a plain User-Agent, no token). Since 0.5.38 the
// answer says when GitHub was asked (checkedAt), and it is read again sooner when asked to: fresh (Settings →
// Update's Check again, on the instance that got the click) or freshAfter (a check made on another instance:
// an answer older than it is read again).
const CACHE_MS = 10 * 60 * 1000;

// "0.3.10" > "0.3.9": compared number by number.
function compareVersions(a, b) {
    const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
}

// CHANGELOG.md → [{ version, title, body }], newest first (as the file is written).
function parseChangelog(text) {
    const out = [];
    for (const part of String(text || '').split(/^## /m).slice(1)) {
        const nl = part.indexOf('\n');
        const head = (nl < 0 ? part : part.slice(0, nl)).trim();
        const m = /^(\d+(?:\.\d+)+)\s*:?\s*(.*)$/.exec(head);
        if (!m) continue;
        out.push({ version: m[1], title: m[2], body: (nl < 0 ? '' : part.slice(nl + 1)).trim() });
    }
    return out;
}

// Where a version's AI model comes from (VENDOR.json modelSource: TinyPhishLLM and the commit its image
// build downloads), or null for a version from before 0.5.8 (its model was inside it).
function modelSourceOf(vendor) {
    const s = vendor && vendor.modelSource;
    if (!s || !/^[0-9a-f]{40}$/.test(String(s.commit || '')) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(String(s.repository || ''))) return null;
    return { repository: s.repository, commit: s.commit };
}

function createReleases({ repo = 'thecodewarrior2/Google_service_main', fetch: f = fetch, now = () => Date.now() } = {}) {
    let cached = null, cachedAt = 0;
    const get = async (url, json) => {
        const res = await f(url, { headers: { 'user-agent': 'spruce-mail-protection', accept: json ? 'application/vnd.github+json' : 'text/plain' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`${url.replace(/^https:\/\/[^/]+\//, '')}: HTTP ${res.status}`);
        return json ? res.json() : res.text();
    };
    async function newest({ fresh = false, freshAfter = 0 } = {}) {
        if (!fresh && cached && now() - cachedAt < CACHE_MS && cachedAt >= (Number(freshAfter) || 0)) return cached;
        const c = await get(`https://api.github.com/repos/${repo}/commits/main`, true);
        const sha = String(c.sha || '');
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('no commit on main');
        const raw = (p) => get(`https://raw.githubusercontent.com/${repo}/${sha}/${p}`, false);
        const [pkg, changelog, vendor] = await Promise.all([raw('package.json').then(JSON.parse), raw('CHANGELOG.md'), raw('vendor/spruce/VENDOR.json').then(JSON.parse).catch(() => ({}))]);
        cached = { repo, commit: sha, date: (c.commit && c.commit.committer && c.commit.committer.date) || null, version: String(pkg.version || ''),
            installLevel: Number(pkg.installLevel) || 0, model: vendor.model || null, modelSource: modelSourceOf(vendor), changelog: parseChangelog(changelog), checkedAt: now() };
        cachedAt = cached.checkedAt;
        return cached;
    }
    return { newest, CACHE_MS };
}

module.exports = { createReleases, parseChangelog, compareVersions, modelSourceOf, CACHE_MS };
