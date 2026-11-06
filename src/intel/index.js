'use strict';
// The network checks, put together for the worker (docs/PRIVACY.md lists what each one sends where).
const { createHttp } = require('./http');
const { createThreats } = require('./threats');
const { createFeeds } = require('./feeds');
const { createRdap } = require('./rdap');

function createIntel({ cfg, store, engine, fetch: fetchImpl, version = '0', log = console }) {
    const http = createHttp({ fetch: fetchImpl || fetch });
    return {
        threats: cfg.cloudflareThreats || (cfg.safeBrowsing && cfg.safeBrowsingKey) ? createThreats({ http, cfg, engine, version }) : null,
        feeds: cfg.phishingLists ? createFeeds({ http, store, engine, log }) : null,
        rdap: cfg.siteAge ? createRdap({ http, store, engine }) : null,
        http
    };
}

module.exports = { createIntel };
