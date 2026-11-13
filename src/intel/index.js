'use strict';
// The network checks, put together for the worker (docs/PRIVACY.md lists what each one sends where).
const { createHttp } = require('./http');
const { createThreats } = require('./threats');
const { createFeeds } = require('./feeds');
const { createRdap } = require('./rdap');
const { createSafeBrowsingKey } = require('./sbkey');
const { createDnsCheck } = require('../lookalike');
const { createApiKey } = require('./apikey');
const { abusechFeeds, testAbusechKey, KEY_RE: ABUSECH_KEY_RE } = require('./abusech');
const { createSpamhaus, KEY_RE: SPAMHAUS_KEY_RE } = require('./spamhaus');

// secrets: Secret Manager for the Safe Browsing key (src/secrets.js), when install.sh set it up
// (SAFE_BROWSING_SECRET); otherwise the key comes from SAFE_BROWSING_KEY, as before 0.5.23.
// secretsFor (0.5.37): { spamhaus, abusech } Secret Manager clients for the two optional services' keys
// (SPAMHAUS_SECRET, ABUSECH_SECRET, made by install.sh from 0.5.37 on); null for one not set up.
function createIntel({ cfg, store, engine, fetch: fetchImpl, version = '0', log = console, secrets = undefined, secretsFor = undefined, resolver = undefined, offline = false }) {
    const http = createHttp({ fetch: fetchImpl || fetch });
    if (secrets === undefined) secrets = cfg.safeBrowsingSecret ? require('../secrets').createSecrets({ name: cfg.safeBrowsingSecret }) : null;
    const sbKey = createSafeBrowsingKey({ cfg, store, secrets, http, log });
    if (secretsFor === undefined) {
        const mk = (name) => (name ? require('../secrets').createSecrets({ name }) : null);
        secretsFor = { spamhaus: mk(cfg.spamhausSecret), abusech: mk(cfg.abusechSecret) };
    }
    const spamhaus = createSpamhaus({ cfg, store, resolver, log });
    const keys = {
        spamhaus: createApiKey({ id: 'spamhaus', label: 'Spamhaus', store, secrets: secretsFor.spamhaus, keyRe: SPAMHAUS_KEY_RE, test: (k) => spamhaus.testKey(k), log, offline }),
        abusech: createApiKey({ id: 'abusech', label: 'abuse.ch', store, secrets: secretsFor.abusech, keyRe: ABUSECH_KEY_RE, test: (k) => testAbusechKey(http, k), log, offline })
    };
    spamhaus.setKey(keys.spamhaus);
    return {
        // (always made: Safe Browsing can be turned on from the dashboard at any time)
        threats: createThreats({ http, cfg, engine, version, sbKey }),
        sbKey,
        keys,
        // Spamhaus's DBL and ZRD (0.5.37; off by default): looked up per email when on, with a key.
        spamhaus,
        // the phishing lists, and abuse.ch's when it is on with a key (0.5.37)
        feeds: cfg.phishingLists ? createFeeds({ http, store, engine, log, extra: () => abusechFeeds({ cfg, key: keys.abusech, http }) }) : null,
        rdap: cfg.siteAge ? createRdap({ http, store, engine }) : null,
        // the look-alike watch's lookups (0.5.36): candidate names only, to Cloudflare's public resolver
        dnsCheck: cfg.lookalikeWatch ? createDnsCheck({ http }) : null,
        http
    };
}

module.exports = { createIntel };
