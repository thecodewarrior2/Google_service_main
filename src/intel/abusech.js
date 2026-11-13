'use strict';
// abuse.ch (0.5.37; optional, off by default: Settings → abuse.ch): URLhaus (links spreading malware) and
// ThreatFox (malware sites, links and control servers), downloaded once a day for the whole district with the
// admin's free abuse.ch key and matched like the phishing lists (src/intel/feeds.js: the `extra` lists). Nothing
// about any email is sent to abuse.ch.
//
// - URLhaus: its export of the URLs added in the past 30 days, recent.csv. abuse.ch puts the key in the
//   export's address (https://urlhaus-api.abuse.ch/v2/files/exports/<key>/recent.csv), so that address is
//   made only when the download starts, and never written anywhere: errors say only the HTTP status.
// - ThreatFox: its API (the key in the Auth-Key header), get_iocs for the last 7 days: the domain and URL
//   indicators, as two lists.
//
// abuse.ch's terms: for not-for-profit use with a key; the data may not be used to train or improve an AI
// model, so the retraining export leaves out what these lists found (src/training.js).
const URLHAUS = (key) => `https://urlhaus-api.abuse.ch/v2/files/exports/${encodeURIComponent(key)}/recent.csv`;
const THREATFOX_API = 'https://threatfox-api.abuse.ch/api/v1/';
const KEY_RE = /^[A-Za-z0-9]{24,80}$/;

// URLhaus's CSV: comment lines (#), then "id","dateadded","url","url_status",…: the url column.
function urlhausUrls(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const m = /^"[^"]*","[^"]*","((?:[^"]|"")*)"/.exec(line);
        if (m) out.push(m[1].replace(/""/g, '"'));
    }
    return out.join('\n');
}
// ThreatFox's answer: { query_status, data: [{ ioc, ioc_type: 'domain' | 'url' | 'ip:port', … }] }.
function threatfoxIocs(json, type) {
    if (!json || json.query_status !== 'ok' || !Array.isArray(json.data)) {
        if (json && json.query_status && json.query_status !== 'no_result') throw new Error(`ThreatFox answered ${String(json.query_status).slice(0, 60)}`);
        return '';
    }
    return json.data.filter(x => x && x.ioc_type === type && typeof x.ioc === 'string').map(x => x.ioc).join('\n');
}

// The lists, for feeds.js: on only when abuse.ch is turned on (cfg.abusech, a policy setting) and a key is
// saved (keys: src/intel/apikey.js).
function abusechFeeds({ cfg, key, http }) {
    const enabled = async () => !!cfg.abusech && !!(await key.get().catch(() => null));
    const threatfox = (type) => async () => {
        const k = await key.get();
        const res = await http.request(THREATFOX_API, { method: 'POST', headers: { 'Auth-Key': k, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'get_iocs', days: 7 }) }, 60000);
        return res;
    };
    const base = { license: 'abuse.ch terms of use (not-for-profit; no AI training)', confidence: 'list', optional: 'abusech', enabled };
    return [
        Object.assign({ id: 'urlhaus', name: 'URLhaus (abuse.ch)', kind: 'url', home: 'https://urlhaus.abuse.ch/',
            // (the key is in the address: made here, never kept or logged)
            fetchWith: async () => http.request(URLHAUS(await key.get()), {}, 60000),
            unpack: async (res) => urlhausUrls(await res.text()) }, base),
        // (a week of ThreatFox can hold few of one kind: a small list is still a good one)
        Object.assign({ id: 'threatfoxdomains', name: 'ThreatFox domains (abuse.ch)', kind: 'domain', home: 'https://threatfox.abuse.ch/', minEntries: 1,
            fetchWith: threatfox('domain'), unpack: async (res) => threatfoxIocs(await res.json(), 'domain') }, base),
        Object.assign({ id: 'threatfoxurls', name: 'ThreatFox links (abuse.ch)', kind: 'url', home: 'https://threatfox.abuse.ch/', minEntries: 1,
            fetchWith: threatfox('url'), unpack: async (res) => threatfoxIocs(await res.json(), 'url') }, base)
    ];
}

// A key tried with abuse.ch: the ThreatFox API's smallest question (the last day's indicators).
async function testAbusechKey(http, key) {
    let res;
    try { res = await http.request(THREATFOX_API, { method: 'POST', headers: { 'Auth-Key': key, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'get_iocs', days: 1 }) }, 15000); }
    catch (e) { return { ok: false, why: 'abuse.ch couldn\'t be reached.', fix: 'Try again in a minute.' }; }
    if (res.status === 401 || res.status === 403) return { ok: false, why: 'abuse.ch refused this key.', fix: 'Copy the Auth-Key again from your profile at auth.abuse.ch.' };
    if (!res.ok) return { ok: false, why: `abuse.ch answered HTTP ${res.status}.`, fix: 'Try again later.' };
    return { ok: true };
}

module.exports = { abusechFeeds, testAbusechKey, urlhausUrls, threatfoxIocs, KEY_RE, URLHAUS, THREATFOX_API };
