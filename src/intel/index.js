'use strict';
// The network checks, put together for the worker (docs/PRIVACY.md lists what each one sends where).
const { createHttp } = require('./http');
const { createThreats } = require('./threats');
const { createFeeds } = require('./feeds');
const { createRdap } = require('./rdap');
const { createSafeBrowsingKey } = require('./sbkey');

// secrets: Secret Manager for the Safe Browsing key (src/secrets.js), when install.sh set it up
// (SAFE_BROWSING_SECRET); otherwise the key comes from SAFE_BROWSING_KEY, as before 0.5.23.
function createIntel({ cfg, store, engine, fetch: fetchImpl, version = '0', log = console, secrets = undefined }) {
    const http = createHttp({ fetch: fetchImpl || fetch });
    if (secrets === undefined) secrets = cfg.safeBrowsingSecret ? require('../secrets').createSecrets({ name: cfg.safeBrowsingSecret }) : null;
    const sbKey = createSafeBrowsingKey({ cfg, store, secrets, http, log });
    return {
        // (always made: Safe Browsing can be turned on from the dashboard at any time)
        threats: createThreats({ http, cfg, engine, version, sbKey }),
        sbKey,
        feeds: cfg.phishingLists ? createFeeds({ http, store, engine, log }) : null,
        rdap: cfg.siteAge ? createRdap({ http, store, engine }) : null,
        http
    };
}

module.exports = { createIntel };
