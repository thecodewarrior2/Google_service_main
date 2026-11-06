'use strict';
// Every request to an outside service goes through here (the extension's fetchWithTimeout, ported):
//   - a time limit per request;
//   - per service (host) at most PARALLEL requests at once, the rest waiting their turn;
//   - after "too many requests" (429), or 3 server errors (5xx) in a row, the service is left alone for a
//     while (its Retry-After, at most 15 minutes, or 2 s doubling to 5 minutes, with jitter), and
//     requests to it fail at once (ServiceBusyError) so the caller moves on. A failed lookup is never
//     taken for "safe": the link or domain is only "not checked".
const PARALLEL_DEFAULT = 8;
const PARALLEL = { 'safebrowsing.googleapis.com': 4 };
const BACKOFF = { firstMs: 2000, maxMs: 5 * 60 * 1000, retryAfterMaxMs: 15 * 60 * 1000 };

class ServiceBusyError extends Error {
    constructor(host, until) { super(`${host} asked to be left alone until ${new Date(until).toISOString()}`); this.name = 'ServiceBusyError'; this.until = until; }
}

function createHttp({ fetch: fetchImpl = fetch, now = () => Date.now(), parallel = {} } = {}) {
    const states = new Map();
    const stateOf = (host) => {
        let st = states.get(host);
        if (!st) { if (states.size > 500) states.delete(states.keys().next().value); st = { running: 0, waiting: [], failures: 0, until: 0 }; states.set(host, st); }
        return st;
    };
    const limitOf = (host) => parallel[host] || PARALLEL[host] || (/rdap/.test(host) ? 2 : PARALLEL_DEFAULT);
    const release = (st) => { const next = st.waiting.shift(); if (next) { clearTimeout(next.timer); next.resolve(); } else st.running = Math.max(0, st.running - 1); };
    const backoffMs = (st, res) => {
        const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
        let after = NaN;
        if (h) after = /^\s*\d+\s*$/.test(h) ? Number(h) * 1000 : Date.parse(h) - now();
        if (Number.isFinite(after) && after > 0) return Math.min(after, BACKOFF.retryAfterMaxMs);
        return Math.round(Math.min(BACKOFF.maxMs, BACKOFF.firstMs * 2 ** Math.min(20, Math.max(0, st.failures - 1))) * (0.75 + Math.random() * 0.5));
    };
    async function request(url, options = {}, ms = 6000) {
        const host = new URL(url).host.toLowerCase();
        const st = stateOf(host);
        if (st.until > now()) throw new ServiceBusyError(host, st.until);
        const t0 = Date.now();
        if (st.running >= limitOf(host)) {
            await new Promise((resolve, reject) => {
                const w = { resolve, timer: setTimeout(() => { st.waiting = st.waiting.filter(x => x !== w); const e = new Error(`timed out waiting for ${host}`); e.name = 'AbortError'; reject(e); }, ms) };
                st.waiting.push(w);
            });
        } else st.running++;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), Math.max(1, ms - (Date.now() - t0)));
        try {
            const res = await fetchImpl(url, Object.assign({}, options, { signal: ctl.signal }));
            const status = res && typeof res.status === 'number' ? res.status : 200;
            if (status === 429 || (status >= 500 && status <= 599)) {
                st.failures++;
                if (status === 429 || st.failures >= 3) st.until = now() + backoffMs(st, res);
            } else if (status < 400 || status === 404) { st.failures = 0; st.until = 0; }
            return res;
        } finally { clearTimeout(timer); release(st); }
    }
    return { request, states };
}

// A small time-limited cache (answers are remembered for a while so the same link in 40 copies of a
// campaign is looked up once).
class TtlCache {
    constructor(max = 50000) { this.max = max; this.map = new Map(); }
    get(k) { const e = this.map.get(k); if (!e) return undefined; if (e.exp < Date.now()) { this.map.delete(k); return undefined; } return e.v; }
    set(k, v, ttlMs) { if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value); this.map.set(k, { v, exp: Date.now() + ttlMs }); }
}

module.exports = { createHttp, ServiceBusyError, TtlCache };
