// decoders.js — every OFFLINE link decoder (no network requests). Loaded by the background
// after shared.js. Each decoder identifies its format by the PARSED hostname (exact host or real
// subdomain) plus the path, never by text that merely appears somewhere in the URL.
//
// A decoder takes (url, ctx) and returns null, a destination URL string, or { url, name } when it
// wants a more specific step name in the Link Inspector.
//
// Confidence notes: formats marked [verify] were implemented from documentation and published
// examples, not from samples in your own mail. Paste a real link into the Link Inspector to
// confirm; a wrong guess fails safe (the link is simply not decoded).

function parseUrl(urlString) {
    try { return new URL(urlString); } catch (e) { return null; }
}

function hostOf(urlString) {
    const u = parseUrl(urlString);
    return u ? u.hostname.toLowerCase() : '';
}

function hostIsAny(host, domains) {
    return domains.some(d => hostMatches(host, d));
}

// Accepts a candidate destination taken from a parameter or path. Handles single and double
// percent-encoding. Returns an http(s) URL or null.
function normalizeEmbeddedUrl(value) {
    if (typeof value !== 'string') return null;
    let v = value.trim();
    for (let i = 0; i < 2 && /^https?%3A/i.test(v); i++) {
        try { v = decodeURIComponent(v); } catch (e) { return null; }
    }
    return /^https?:\/\//i.test(v) && parseUrl(v) ? v : null;
}

// Percent-decodes a destination taken from a URL PATH only when it is actually encoded (its
// scheme is "https%3A..." or "https:%2F%2F..."). A destination written there unencoded must be
// left alone, or its own encoded characters (e.g. %20, %26) would be corrupted.
function decodeIfEncoded(value) {
    if (!/^https?(?:%3A|:%2F)/i.test(value)) return value;
    try { return decodeURIComponent(value); } catch (e) { return null; }
}

function base64UrlDecode(value) {
    let b64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (b64.length % 4 === 1) return null;
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    try { return atob(b64); } catch (e) { return null; }
}

// atob() yields one character per byte; this turns UTF-8 bytes back into text.
function binaryToUtf8(binary) {
    try { return decodeURIComponent(escape(binary)); } catch (e) { return binary; }
}

// ===========================================================================
// 1. SECURITY GATEWAYS (strict: also used for one-time links, because they return the complete
//    original URL and never drop a token)
// ===========================================================================

function decodeMicrosoftSafeLinks(url) {
    const u = parseUrl(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    if (hostIsAny(host, ['safelinks.protection.outlook.com', 'safelinks.office.com', 'safelinks.protection.office365.us'])) {
        // searchParams.get() already percent-decodes once; decoding again would corrupt %25.
        return u.searchParams.get('url');
    }
    // Microsoft Teams variant.
    if (host === 'statics.teams.cdn.office.net' && /safelinks/i.test(u.pathname)) {
        const v = normalizeEmbeddedUrl(u.searchParams.get('url'));
        return v ? { url: v, name: 'Microsoft Teams SafeLinks' } : null;
    }
    return null;
}

const PROOFPOINT_RUN_LENGTHS = (() => {
    // 'A' => 2, 'B' => 3, ... mirrors Proofpoint's own reference decoder.
    const map = {};
    let runLength = 2;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < alphabet.length; i++) map[alphabet[i]] = runLength++;
    return map;
})();

function decodeProofpoint(url) {
    const u = parseUrl(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    if (!hostMatches(host, 'urldefense.com') && !hostMatches(host, 'urldefense.proofpoint.com')) return null;
    const v2Match = url.match(/urldefense(?:\.proofpoint)?\.com\/(v[12])\/url\?[^#]*\bu=([^&]+)/i);
    if (v2Match) {
        let raw = v2Match[2];
        if (v2Match[1] === 'v2') raw = raw.replace(/-/g, '%').replace(/_/g, '/');
        try { return decodeURIComponent(raw); } catch (e) { return unescape(raw); }
    }
    const v3Match = url.match(/urldefense(?:\.proofpoint)?\.com\/v3\/__(.+?)__;([A-Za-z0-9_=-]*)!/i);
    if (v3Match) {
        try {
            let urlPart = v3Match[1];
            try { urlPart = decodeURIComponent(urlPart); } catch (e) {}
            let encBytes = v3Match[2].replace(/=+$/, '');
            encBytes += '='.repeat((4 - (encBytes.length % 4)) % 4);
            const decBytes = atob(encBytes.replace(/-/g, '+').replace(/_/g, '/'));
            let curPos = 0, result = '', i = 0;
            while (i < urlPart.length) {
                if (urlPart[i] === '*' && urlPart[i + 1] === '*') {
                    const runLen = PROOFPOINT_RUN_LENGTHS[urlPart[i + 2]] || 2;
                    result += decBytes.substr(curPos, runLen);
                    curPos += runLen;
                    i += 3;
                } else if (urlPart[i] === '*') {
                    result += decBytes.substr(curPos, 1);
                    curPos += 1;
                    i += 1;
                } else {
                    result += urlPart[i];
                    i += 1;
                }
            }
            return result;
        } catch (e) { return null; }
    }
    return null;
}

// Amazon SES click tracking: the path STARTS with /L0/ or /CL0/ followed by the encoded destination.
// The path alone is only a CLAIM about the destination (any server can carry it and redirect
// elsewhere), so which hosts are believed is split in two:
//   - decodeAmazonSes (strict, also one-time links): only Amazon's own tracking domain awstrack.me,
//     whose redirect Amazon itself operates.
//   - decodeAmazonSesCustomDomain (generic): a customer's own click domain (click.example.com…),
//     only when the host is shaped like or listed as a redirector, like every other generic decoder;
//     the safety check still verifies the wrapper host itself (assessSafety).
function decodeSesPath(url, u) {
    const rest = url.slice(u.origin.length);
    const m = rest.match(/^\/C?L0\/(https?(?::|%3A)(?:\/\/|%2F%2F))(.+?)(\/\d+\/|$)/i);
    if (!m) return null;
    return decodeIfEncoded(m[1] + m[2]);
}

function decodeAmazonSes(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname.toLowerCase(), 'awstrack.me')) return null;
    return decodeSesPath(url, u);
}

function decodeAmazonSesCustomDomain(url, ctx) {
    const u = parseUrl(url);
    if (!u || hostMatches(u.hostname.toLowerCase(), 'awstrack.me')) return null;   // strict decoder's case
    if (!isRedirectorUrl(u, ctx)) return null;
    return decodeSesPath(url, u);
}

// Barracuda Email Protection: linkprotect.cudasvc.com/url?a=<encoded URL>&c=...
function decodeBarracuda(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname, 'linkprotect.cudasvc.com') || u.pathname !== '/url') return null;
    const a = u.searchParams.get('a');
    const plain = normalizeEmbeddedUrl(a);
    if (plain) return plain;
    const decoded = base64UrlDecode(a);                       // some deployments base64-encode "a"
    return decoded ? normalizeEmbeddedUrl(binaryToUtf8(decoded)) : null;
}

// Sophos Email: *.protection.sophos.com/?d=<domain>&u=<base64 URL>&... [verify]
function decodeSophos(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname, 'protection.sophos.com')) return null;
    const raw = u.searchParams.get('u');
    if (!raw) return null;
    const plain = normalizeEmbeddedUrl(raw);
    if (plain) return plain;
    const decoded = base64UrlDecode(raw);
    return decoded ? normalizeEmbeddedUrl(binaryToUtf8(decoded)) : null;
}

// Trend Micro Email Security click-time protection: */wis/clicktime/v1/query?url=<encoded>&...
function decodeTrendMicro(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname, 'trendmicro.com') || !/^\/wis\/clicktime\//i.test(u.pathname)) return null;
    // The destination may be written unencoded, in which case its own "&" would split it: take
    // everything between "url=" and Trend Micro's "&umid=" parameter.
    const raw = url.match(/[?&]url=(https?:\/\/.+?)&umid=/i);
    if (raw) return normalizeEmbeddedUrl(raw[1]);
    return normalizeEmbeddedUrl(u.searchParams.get('url'));
}

// Symantec / Broadcom Email Security.cloud click-time protection: clicktime.symantec.com/...?u=<encoded> [verify]
function decodeSymantec(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname, 'clicktime.symantec.com')) return null;
    return normalizeEmbeddedUrl(u.searchParams.get('u'));
}

// Cisco Secure Email (IronPort): secure-web.cisco.com/<token>/<percent-encoded URL> [verify]
function decodeCisco(url) {
    const u = parseUrl(url);
    if (!u || u.hostname.toLowerCase() !== 'secure-web.cisco.com') return null;
    const m = url.slice(u.origin.length).match(/^\/[^/]+\/(https?(?::|%3A).*)$/i);
    if (!m) return null;
    return normalizeEmbeddedUrl(decodeIfEncoded(m[1]));
}

// Check Point Harmony Email (Avanan): url.avanan.click/v2/[r0N/]___<URL>___.<base64 metadata>
// (Check Point admin guide). Some versions write the scheme as "https:/". When the tenant enables
// path obfuscation only the domain is real, which the destination check still uses.
function decodeAvanan(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname, 'avanan.click')) return null;
    const m = url.match(/\/v\d+\/(?:r\d+\/)?___(.+?)___/) || url.match(/___(.+?)___/);
    if (!m) return null;
    let v = m[1];
    if (/^https?%3A/i.test(v)) { try { v = decodeURIComponent(v); } catch (e) { return null; } }
    v = v.replace(/^(https?):\/(?!\/)/i, '$1://');
    return normalizeEmbeddedUrl(v);
}

// Libraesva UrlSand: urlsand.esvalabs.com/?u=<encoded original>&e=…&h=… — the vendor documents that
// the original "can always be recovered" by URL-decoding u.
function decodeLibraesva(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname, 'esvalabs.com')) return null;
    return normalizeEmbeddedUrl(u.searchParams.get('u'));
}

// Forcepoint Remote Browser Isolation: <tenant>.rbi.forcepoint.net/loader?tenantId=…&url=<URI>
function decodeForcepointRbi(url) {
    const u = parseUrl(url);
    if (!u || !hostMatches(u.hostname, 'rbi.forcepoint.net')) return null;
    return normalizeEmbeddedUrl(u.searchParams.get('url'));
}

// ===========================================================================
// 2. PLATFORM, SEARCH, AD AND AFFILIATE REDIRECTS (rule table)
//    hosts : exact host or real subdomain (hostMatches)
//    path  : RegExp tested against the URL's pathname
//    params: query parameters that hold the destination, in priority order
//    extract(u, url): custom extraction instead of params
// ===========================================================================
const AMAZON_HOST_RE = /(^|\.)amazon\.(com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.be|ie|com\.tr|ae|sa|eg|in|sg|com\.au|co\.jp)$/i;
const CJ_HOSTS = ['anrdoezrs.net', 'jdoqocy.com', 'kqzyfj.com', 'tkqlhce.com', 'dpbolvw.net', 'qksrv.net', 'emjcd.com'];
const IMPACT_HOSTS = ['sjv.io', 'pxf.io', '7eer.net', 'ojrq.net', 'evyy.net', 'impactradius-go.com'];

const REDIRECT_RULES = [
    // --- Platforms' own "you are leaving" pages ---
    { name: 'Google redirect',            hosts: ['google.com'],              path: /^\/url$/,              params: ['q', 'url'] },
    { name: 'Google AMP page',            hosts: ['google.com'],              path: /^\/amp\/s?\/?./,
      extract: (u, url) => {
          const m = url.slice(u.origin.length).match(/^\/amp\/(s\/)?(.+)$/);
          return m ? `${m[1] ? 'https' : 'http'}://${m[2]}` : null;
      } },
    { name: 'YouTube redirect',           hosts: ['youtube.com'],             path: /^\/redirect$/,         params: ['q'] },
    { name: 'Google Meet redirect',       hosts: ['meet.google.com'],         path: /^\/linkredirect$/,     params: ['dest'] },   // abused in 2026 phishing chains
    { name: 'Google Ads click',           hostTest: h => /(^|\.)google\.[a-z.]{2,6}$/i.test(h), path: /^\/(aclk|pagead\/iclk)$/, params: ['adurl'] },
    { name: 'Google Ads click',           hosts: ['googleads.g.doubleclick.net', 'pagead2.googlesyndication.com'], path: /^\/pagead\/iclk$/, params: ['adurl'] },
    { name: 'DoubleClick click',          hosts: ['doubleclick.net'],         path: /^\/pcs\/click$/,      params: ['adurl'] },
    { name: 'Facebook link shim',         hosts: ['facebook.com'],            path: /^\/l\.php$/,           params: ['u'] },
    { name: 'Facebook link warning',      hosts: ['facebook.com'],            path: /^\/flx\/warn\/?$/,     params: ['u'] },
    { name: 'Messenger link shim',        hosts: ['l.messenger.com'],         path: /^\/l\.php$/,           params: ['u'] },
    { name: 'Instagram link shim',        hosts: ['l.instagram.com'],         path: /^\/?$/,                params: ['u'] },
    { name: 'Threads link shim',          hosts: ['l.threads.net', 'l.threads.com'], path: /^\/?$/,         params: ['u'] },
    { name: 'LinkedIn redirect',          hosts: ['linkedin.com'],            path: /^\/(redir|safety\/go)/, params: ['url'] },
    { name: 'Slack redirect',             hosts: ['slack-redir.net'],         path: /^\/link$/,             params: ['url'] },
    { name: 'Reddit outbound link',       hosts: ['out.reddit.com'],          path: /./,                    params: ['url'] },
    { name: 'Steam link filter',          hosts: ['steamcommunity.com'],      path: /^\/linkfilter\/?$/,    params: ['url', 'u'] },
    { name: 'Tumblr redirect',            hosts: ['t.umblr.com'],             path: /^\/redirect$/,         params: ['z'] },
    { name: 'VK outbound link',           hosts: ['vk.com'],                  path: /^\/away\.php$/,        params: ['to'] },
    // YouTube share-tracking link: u= is a YouTube path ("/watch?v=…"), not a full address.
    { name: 'YouTube attribution link',   hosts: ['youtube.com'],             path: /^\/attribution_link$/,
      extract: (u) => { const p = u.searchParams.get('u') || ''; return /^\/[^/\\]/.test(p) ? 'https://www.youtube.com' + p : null; } },
    { name: 'Pinterest outbound link',    hosts: ['pinterest.com'],           path: /^\/offsite\/?$/,      params: ['url'] },
    { name: 'Telegram Instant View',      hosts: ['t.me'],                    path: /^\/iv\/?$/,           params: ['url'] },
    { name: 'Medium redirect',            hosts: ['medium.com'],              path: /^\/r\/?$/,             params: ['url'] },
    { name: 'Disqus outbound link',       hosts: ['disq.us'],                 path: /^\/url$/,
      extract: (u) => {
          // Disqus appends ":<signature>" to the destination. [verify]
          const v = u.searchParams.get('url');
          return v ? v.replace(/:[A-Za-z0-9_-]{8,}$/, '') : null;
      } },
    // --- Search engines ---
    { name: 'Bing click link',            hosts: ['bing.com'],                path: /^\/ck\/a$/,
      extract: (u) => {
          const v = u.searchParams.get('u');
          if (!v) return null;
          if (/^a1/.test(v)) { const d = base64UrlDecode(v.slice(2)); return d ? binaryToUtf8(d) : null; }
          return v;
      } },
    { name: 'Yahoo search redirect',      hosts: ['r.search.yahoo.com'],      path: /\/RU=/,
      extract: (u) => {
          const m = u.pathname.match(/\/RU=([^/]+)\//);
          if (!m) return null;
          try { return decodeURIComponent(m[1]); } catch (e) { return null; }
      } },
    { name: 'DuckDuckGo redirect',        hosts: ['duckduckgo.com'],          path: /^\/l\/?$/,             params: ['uddg'] },
    // --- Advertising ---
    { name: 'Google Ads click',           hosts: ['googleadservices.com'],    path: /^\/pagead\/aclk$/,     params: ['adurl'] },
    { name: 'Google Marketing Platform click', hosts: ['ad.doubleclick.net'], path: /^\/ddm\/(trackclk|clk)\//,
      extract: (u, url) => {
          // The destination follows the first "?" raw, after ";key=value" pairs. [verify]
          const i = url.indexOf('?');
          return i > -1 ? url.slice(i + 1) : null;
      } },
    // --- Shopping / marketplaces ---
    { name: 'Amazon email redirect',      hostTest: h => AMAZON_HOST_RE.test(h), path: /^\/gp\/r\.html$/,  params: ['U'] },
    { name: 'eBay Rover redirect',        hosts: ['rover.ebay.com'],          path: /^\/rover\//,           params: ['mpre'] },
    // --- Affiliate networks ---
    { name: 'Awin affiliate link',        hosts: ['awin1.com'],               path: /^\/cread\.php$/,       params: ['ued'] },
    { name: 'Rakuten affiliate link',     hosts: ['click.linksynergy.com'],   path: /^\/deeplink$/,         params: ['murl'] },
    { name: 'CJ affiliate link',          hosts: CJ_HOSTS,                    path: /./,
      extract: (u, url) => {
          const m = url.slice(u.origin.length).match(/\/type\/dlg\/(?:sid\/[^/]+\/)?(https?(?::|%3A).+)$/i);
          if (m) return decodeIfEncoded(m[1]);
          return u.searchParams.get('url');
      } },
    { name: 'Impact affiliate link',      hosts: IMPACT_HOSTS,                path: /./,                    params: ['u'] },
    // iContact email marketing: click-<account>.icptrack.com/icp/relay.php?...&destination=<url>
    { name: 'iContact click tracker',     hosts: ['icptrack.com'],            path: /^\/icp\/relay\.php$/i, params: ['destination'] },
    { name: 'Partnerize affiliate link',  hosts: ['prf.hn'],                  path: /\/destination:/,
      extract: (u, url) => {
          const m = url.match(/\/destination:([^/?#]+)/);
          if (!m) return null;
          try { return decodeURIComponent(m[1]); } catch (e) { return null; }
      } },
    { name: 'Skimlinks affiliate link',   hosts: ['go.skimresources.com'],    path: /./,                    params: ['url'] },
    { name: 'ShareASale affiliate link',  hosts: ['shareasale.com'],          path: /^\/r\.cfm$/,
      extract: (u) => { const v = u.searchParams.get('urllink'); return v && !/^https?:/i.test(v) ? 'https://' + v.replace(/^\/+/, '') : v; } }
];

function decodeRedirectRules(url) {
    const u = parseUrl(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    for (const rule of REDIRECT_RULES) {
        const hostOk = rule.hostTest ? rule.hostTest(host) : hostIsAny(host, rule.hosts);
        if (!hostOk || !rule.path.test(u.pathname)) continue;
        let candidate = null;
        if (rule.extract) {
            try { candidate = normalizeEmbeddedUrl(rule.extract(u, url)); } catch (e) { candidate = null; }
        } else {
            for (const p of rule.params) {
                candidate = normalizeEmbeddedUrl(u.searchParams.get(p));
                if (candidate) break;
            }
        }
        if (candidate) return { url: candidate, name: rule.name };
    }
    return null;
}

// Google Translate's website proxy (used in phishing because the host looks like Google):
// example-com.translate.goog/path?_x_tr_sl=... => https://example.com/path
function decodeTranslateProxy(url) {
    const u = parseUrl(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('.translate.goog')) return null;
    const label = host.slice(0, -'.translate.goog'.length);
    if (!label || label.includes('.')) return null;
    const realHost = label.replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
    const params = new URLSearchParams(u.search);
    [...params.keys()].filter(k => k.startsWith('_x_tr_')).forEach(k => params.delete(k));
    const query = params.toString();
    return { url: `https://${realHost}${u.pathname}${query ? '?' + query : ''}${u.hash}`, name: 'Google Translate proxy' };
}

// ===========================================================================
// 3. GENERIC DECODERS (only on hosts that are actually redirectors / trackers)
// ===========================================================================

// Social "share" endpoints carry the article URL in ?u= / ?url=, but the user wants the share
// dialog, not the article. They are never rewritten.
const SHARE_PATH_RE = /\/(sharer|share|sharing|shareArticle|intent|pin\/create|submit|bookmark|plusone)(?=[\/._?-]|$)/i;

// First host label typical of click-tracking / redirect hosts (click.brand.com, links.news.com, r.mail.x.com).
// A number may follow, with or without a hyphen (click3., click-175967.).
const REDIRECTOR_HOST_RE = /^(click|clicks|clk|trk|ctrk|track|tracking|link|links|lnk|go|redirect|redir|r|l|url|mkt|email|e|em|ct|cl|t|out|away|exit)(?:-?\d+)?\./i;

// Built-in email trackers and shorteners always count, whatever context the caller passes.
const BUILTIN_REDIRECTORS = BUILTIN_TRACKER_SET;

function isRedirectorUrl(urlObj, ctx) {
    if (SHARE_PATH_RE.test(urlObj.pathname)) return false;
    const host = urlObj.hostname.toLowerCase();
    return hostInSet(host, BUILTIN_REDIRECTORS) || !!emailTrackerProvider(urlObj.href) ||
           hostInSet(host, (ctx && ctx.redirectorSet) || new Set()) ||
           REDIRECTOR_HOST_RE.test(host);
}

function decodeBase64Pattern(url, ctx) {
    try {
        const urlObj = parseUrl(url);
        if (!urlObj || !isRedirectorUrl(urlObj, ctx)) return null;
        const match = url.match(/(aHR0c[A-Za-z0-9+/_-]+={0,2})/);
        if (!match) return null;
        let b64 = match[1].replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
        if (b64.length % 4 === 1) b64 = b64.slice(0, -1);
        b64 += '='.repeat((4 - (b64.length % 4)) % 4);
        const decoded = atob(b64);
        // The URL runs while characters are legal in a URL. Binary padding after it is dropped, but
        // if it is followed by more readable text (e.g. '","unsub":...') it is part of structured
        // data such as JSON, and picking it out could select the wrong link, so nothing is decoded.
        const urlMatch = decoded.match(/^https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
        if (!urlMatch) return null;
        const next = decoded.charCodeAt(urlMatch[0].length);
        if (!Number.isNaN(next) && next >= 0x20 && next <= 0x7e) return null;
        return urlMatch[0];
    } catch (e) { return null; }
}

// Destination inside an encoded JSON payload (a path segment or parameter starting "eyJ", i.e.
// base64 of '{"'). Used by Substack, Mandrill, Customer.io and many in-house trackers. The JSON is
// searched (including JSON nested inside strings); the link is decoded only if it contains exactly
// ONE distinct web address, so it can never pick the wrong one (e.g. an unsubscribe link).
function collectUrlsFromJson(value, out, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
        const v = value.trim();
        if (/^https?:\/\//i.test(v)) { out.add(v); return; }
        if (/^[{[]/.test(v)) { try { collectUrlsFromJson(JSON.parse(v), out, depth + 1); } catch (e) {} }
        return;
    }
    if (Array.isArray(value)) { value.forEach(x => collectUrlsFromJson(x, out, depth + 1)); return; }
    if (typeof value === 'object') Object.values(value).forEach(x => collectUrlsFromJson(x, out, depth + 1));
}

function decodeJsonPayload(url, ctx) {
    const u = parseUrl(url);
    if (!u) return null;
    const isSubstack = hostMatches(u.hostname, 'substack.com') && u.pathname.startsWith('/redirect/');
    if (!isSubstack && !isRedirectorUrl(u, ctx)) return null;
    const candidates = [
        ...u.pathname.split('/'),
        ...[...u.searchParams.values()]
    ].map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } })
     .map(s => s.split('.')[0])                       // drop a ".signature" suffix (JWT style)
     .filter(s => /^eyJ[A-Za-z0-9_+/=-]{8,}$/.test(s));
    for (const c of candidates) {
        const decoded = base64UrlDecode(c);
        if (!decoded) continue;
        let json;
        try { json = JSON.parse(binaryToUtf8(decoded)); } catch (e) { continue; }
        const urls = new Set();
        collectUrlsFromJson(json, urls);
        if (urls.size === 1) {
            const v = normalizeEmbeddedUrl([...urls][0]);
            if (v) return { url: v, name: isSubstack ? 'Substack redirect' : 'Encoded JSON payload' };
        }
    }
    return null;
}

// Parameters that mean "redirect to a DIFFERENT site". Same-site targets (login "next",
// "return_to", internal navigation) are deliberately never rewritten.
const REDIRECT_PARAM_KEYS = ['url', 'u', 'dest', 'destination', 'target', 'redirect', 'redirect_url', 'redir', 'r', 'goto', 'link', 'uri', 'href', 'to', 'out', 'continue_to', 'ued', 'murl', 'adurl'];

function decodeQueryCatalog(url, ctx) {
    const urlObj = parseUrl(url);
    if (!urlObj || !isRedirectorUrl(urlObj, ctx)) return null;
    const sourceDomain = registrableDomain(urlObj.hostname);
    for (const key of REDIRECT_PARAM_KEYS) {
        const val = normalizeEmbeddedUrl(urlObj.searchParams.get(key));
        if (val) {
            const targetHost = hostOf(val);
            if (!targetHost || registrableDomain(targetHost) === sourceDomain) continue;
            return val;
        }
    }
    return null;
}

// Destination written straight into the path: /https%3A%2F%2Fexample.com/... or /https://example.com/
function decodePathEmbeddedUrl(url, ctx) {
    const u = parseUrl(url);
    if (!u || !isRedirectorUrl(u, ctx)) return null;
    const m = url.slice(u.origin.length).match(/\/(https?(?::|%3A)(?:\/\/|%2F%2F).+)$/i);
    if (!m) return null;
    const v = normalizeEmbeddedUrl(decodeIfEncoded(m[1]));
    if (!v || registrableDomain(hostOf(v)) === registrableDomain(u.hostname)) return null;
    return v;
}

// SendGrid click tracking: <host>/ls/click?upn=… or /wf/click?upn=… (on ct.sendgrid.net or a
// customer's branded link domain). SendGrid writes the value with its own escaping ("-2F" for "/",
// "-3D" for "=") followed by "_<signature>". Older links carry the destination as base64 and can be
// read here; current links start "u001." and are ENCRYPTED: only SendGrid can read them, so they
// are not decoded (describeOpaqueLink explains it). Anything that does not decode to a clean web
// address is left alone.
function sendgridUnescape(value) {
    return String(value || '').replace(/-([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function isSendgridClick(u) {
    return /^\/(ls|wf)\/click$/i.test(u.pathname) && u.searchParams.has('upn') &&
           (hostMatches(u.hostname, 'sendgrid.net') || emailTrackerProvider(u.href) === 'SendGrid');
}

function decodeSendgrid(url) {
    const u = parseUrl(url);
    if (!u || !isSendgridClick(u)) return null;
    const upn = u.searchParams.get('upn') || '';
    if (/^u\d{3}\./i.test(upn)) return null;                         // encrypted (current format)
    const payload = sendgridUnescape(upn).split('_')[0];
    const b64 = (payload.match(/^[A-Za-z0-9+/]+={0,2}/) || [''])[0];
    if (b64.length < 12) return null;
    const decoded = base64UrlDecode(b64.replace(/\+/g, '-').replace(/\//g, '_'));
    if (!decoded) return null;
    const text = binaryToUtf8(decoded);
    const m = text.match(/^https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/);
    // Readable text after the address means structured data, not a lone destination: not decoded.
    if (!m || /[\x20-\x7e]/.test(text.charAt(m[0].length))) return null;
    const v = normalizeEmbeddedUrl(m[0]);
    return v ? { url: v, name: 'SendGrid click tracking' } : null;
}

// ===========================================================================
// 4. OFFLINE SHORTENER EXPANSION (destination is fully determined by the short link itself)
// ===========================================================================
const FLICKR_BASE58 = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

function expandKnownShortLink(url) {
    const u = parseUrl(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' && seg.length === 1 && /^[A-Za-z0-9_-]{6,20}$/.test(seg[0])) {
        const out = new URL('https://www.youtube.com/watch');
        out.searchParams.set('v', seg[0]);
        ['t', 'list', 'index'].forEach(k => { if (u.searchParams.has(k)) out.searchParams.set(k, u.searchParams.get(k)); });
        return { url: out.toString(), name: 'YouTube short link (expanded offline)' };
    }
    if (host === 'redd.it' && seg.length === 1 && /^[a-z0-9]{3,12}$/i.test(seg[0])) {
        return { url: `https://www.reddit.com/comments/${seg[0]}`, name: 'Reddit short link (expanded offline)' };
    }
    if (host === 'dai.ly' && seg.length === 1 && /^[A-Za-z0-9]{4,20}$/.test(seg[0])) {
        return { url: `https://www.dailymotion.com/video/${seg[0]}`, name: 'Dailymotion short link (expanded offline)' };
    }
    if (host === 'flic.kr' && seg.length === 2 && seg[0] === 'p' && /^[1-9a-km-zA-HJ-NP-Z]{1,15}$/.test(seg[1])) {
        let n = 0n;
        for (const ch of seg[1]) n = n * 58n + BigInt(FLICKR_BASE58.indexOf(ch));
        return { url: `https://www.flickr.com/photo.gne?id=${n.toString()}`, name: 'Flickr short link (expanded offline)' };
    }
    if (host === 'instagr.am' && seg.length >= 1) {
        return { url: `https://www.instagram.com${u.pathname}${u.search}`, name: 'Instagram short domain (expanded offline)' };
    }
    return null;
}

// ===========================================================================
// 5. WRAPPERS THAT CANNOT BE DECODED OFFLINE (recognized and explained, not decoded)
// ===========================================================================
function describeOpaqueLink(url) {
    const u = parseUrl(url);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    if ((hostMatches(host, 'mimecast.com') && /^protect/.test(host)) || hostMatches(host, 'mimecastprotect.com')) {
        // The token is a lookup key with no embedded URL; "domain" appears only if the admin enabled it.
        const domain = u.searchParams.get('domain');
        return 'Mimecast URL Protect link: the destination is stored by Mimecast and cannot be decoded offline' +
               (domain ? ` (Mimecast reports the destination domain as ${domain})` : '') + '.';
    }
    // Gateways whose links carry only an opaque token (vendor documentation, 2025–2026).
    const OPAQUE_GATEWAYS = [
        [['atpscan.global.hornetsecurity.com', 'hornetsecurity.com'], 'Hornetsecurity Secure Links'],
        [['linklock.titanhq.com'], 'SpamTitan LinkLock'],
        [['antiphishing.vadesecure.com'], 'Vade Time-of-Click'],
        [['url.emailprotection.link'], 'Intermedia LinkSafe / Proofpoint Essentials'],
        [['link.edgepilot.com'], 'Zix / AppRiver Link Protection']
    ];
    for (const [hosts, name] of OPAQUE_GATEWAYS) {
        if (hostIsAny(host, hosts)) return `${name} link: the destination is stored by the security service and cannot be decoded offline. The service checks it when you click.`;
    }
    if (hostMatches(host, 'inky.com') && u.pathname === '/link') {
        const domain = u.searchParams.get('domain');
        return 'INKY protected link: only the destination domain is visible' + (domain ? ` (${domain})` : '') + '; the full address is behind INKY\'s token.';
    }
    if (hostIsAny(host, ['fortimail.com', 'fortinet.com']) && /urlsafe|clicktime/i.test(url)) {
        return 'Fortinet URL protection link: the destination cannot be decoded offline.';
    }
    const pixel = openPixelRule(url);
    if (pixel) {
        return `Open-tracking pixel (${pixel}), not a link: an invisible image that tells the sender when and where the email was opened. It leads nowhere, so there is no destination to reveal; its code identifies the person the email was sent to. The extension blocks these in your webmail. Loading it, here or anywhere, would report the email as opened.`;
    }
    if (isSendgridClick(u) && !decodeSendgrid(url)) {      // u001. links, and unlabelled ones that don't decode
        return 'SendGrid click-tracking link (encrypted format): SendGrid encrypts the destination, so no tool can read it offline. Only following the link reveals it, and that registers a click as the person the email was sent to. Use "Follow it to reveal the destination" below, or "Look up on VirusTotal" (if set up), which follows it from VirusTotal\'s servers.';
    }
    const provider = emailTrackerProvider(url) ||
        (hostIsAny(host, ['sendgrid.net', 'list-manage.com', 'rs6.net', 'hubspotlinks.com', 'mailgun.net']) ? 'an email provider' : null);
    if (provider) {
        return `Email tracking link (${provider}): the destination is stored by the provider and is only revealed by following the link, which would register a click as you. It is never followed or sent anywhere.`;
    }
    return null;
}

// ===========================================================================
// DECODER LISTS AND THE UNWRAPPING LOOP
// ===========================================================================
const STRICT_DECODERS = [
    ['Proofpoint TAP (URL Defense)', decodeProofpoint],
    ['Microsoft Defender SafeLinks', decodeMicrosoftSafeLinks],
    ['Amazon SES Fast-Path', decodeAmazonSes],
    ['Barracuda Link Protection', decodeBarracuda],
    ['Sophos Email Time-of-Click', decodeSophos],
    ['Trend Micro Time-of-Click', decodeTrendMicro],
    ['Symantec Click-Time Protection', decodeSymantec],
    ['Cisco Secure Email', decodeCisco],
    ['Check Point Harmony Email (Avanan)', decodeAvanan],
    ['Libraesva UrlSand', decodeLibraesva],
    ['Forcepoint Remote Browser Isolation', decodeForcepointRbi]
];
const GENERIC_DECODERS = [
    ['Amazon SES Fast-Path', decodeAmazonSesCustomDomain],
    ['SendGrid click tracking', decodeSendgrid],
    ['Known Redirect', decodeRedirectRules],
    ['Google Translate proxy', decodeTranslateProxy],
    ['Offline Short-Link Expansion', expandKnownShortLink],
    ['Encoded JSON payload', decodeJsonPayload],
    ['Base64 Parameter Payload', decodeBase64Pattern],
    ['URL Query Redirect Parameter', decodeQueryCatalog],
    ['URL Embedded in Path', decodePathEmbeddedUrl]
];

// Domains on which the generic decoders may treat a URL parameter as the destination. Built once per
// settings object (the synced list can hold thousands of domains), not once per link.
const decoderContexts = new WeakMap();
function decoderContext(cfg) {
    let ctx = decoderContexts.get(cfg);
    if (!ctx) {
        ctx = { redirectorSet: new Set([...cfg.remoteShorteners, ...cfg.blocklist]) };   // built-ins are checked separately
        decoderContexts.set(cfg, ctx);
    }
    return ctx;
}

// strictOnly = true limits decoding to security-gateway formats, which return the complete original
// URL. One-time links use it so a token can never be dropped by a generic rewrite.
async function unwrapNestedUrl(inputUrl, strictOnly = false, ctx = null) {
    let currentUrl = inputUrl;
    const steps = [];
    const decoders = strictOnly ? STRICT_DECODERS : [...STRICT_DECODERS, ...GENERIC_DECODERS];

    for (let layer = 1; layer <= 6; layer++) {
        let hit = null;
        for (const [name, decode] of decoders) {
            let out = null;
            try { out = decode(currentUrl, ctx); } catch (e) { out = null; }
            const outUrl = out && typeof out === 'object' ? out.url : out;
            if (outUrl && outUrl !== currentUrl && /^https?:\/\//i.test(outUrl) && parseUrl(outUrl)) {
                hit = { name: (out && out.name) || name, out: outUrl };
                break;
            }
        }
        if (!hit) break;
        steps.push({ layer, decoder: hit.name, inputUrl: currentUrl, outputUrl: hit.out });
        currentUrl = hit.out;
    }

    return {
        unwrappedUrl: currentUrl,
        strategyPath: steps.map(s => s.decoder).join(' -> '),
        steps: steps
    };
}
