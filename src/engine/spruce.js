'use strict';
// The checks and the AI model, run on the server.
//
// vendor/spruce/ holds shared.js, decoders.js, ai.js and the model (models/phish-tiny). They began as the
// S.P.R.U.C.E+ browser extension's files (VENDOR.json says from which commit); since 0.4.0 they are this
// project's own code, changed here. They are plain JavaScript written for the browser; they run here in a
// separate context with the few browser things they use (URL, TextDecoder, a stand-in "chrome"), as the
// extension's unit tests ran them in Node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const MARGINS_KEPT = 50000;

const VENDOR = path.resolve(__dirname, '..', '..', 'vendor', 'spruce');

let engine = null;

function load() {
    if (engine) return engine;
    const ctx = {
        console, URL, URLSearchParams, TextDecoder, TextEncoder, atob, btoa, setTimeout, clearTimeout, Intl, BigInt,
        // shared.js asks chrome.runtime.getURL for its own files; nothing else of "chrome" is used here.
        chrome: { runtime: { id: 'spruce-service', getURL: (p) => p, lastError: null } },
        // decoders.js may look at the network only through functions the service never calls.
        fetch: async () => { throw new Error('the engine does not use the network'); }
    };
    vm.createContext(ctx);
    for (const f of ['shared.js', 'decoders.js', 'ai.js']) {
        vm.runInContext(fs.readFileSync(path.join(VENDOR, f), 'utf8'), ctx, { filename: `vendor/spruce/${f}` });
    }
    const get = (name) => vm.runInContext(name, ctx);
    const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, 'models', 'phish-tiny', 'model.json'), 'utf8'));
    const bin = fs.readFileSync(path.join(VENDOR, 'models', 'phish-tiny', 'model.bin'));
    const vocab = fs.readFileSync(path.join(VENDOR, 'models', 'phish-tiny', 'vocab.txt'), 'utf8');
    const PhishModel = get('PhishModel');
    const model = new PhishModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length), vocab);
    // Each pass's answer, remembered per instance by a hash of its input: the copies of a campaign, and the
    // sentences many emails share (greetings, footers), cost one pass. Only the hash and the number are
    // kept, in memory (the most recent MARGINS_KEPT).
    const margins = new Map(), pass = model.margin.bind(model);
    model.margin = (text) => {
        const k = crypto.createHash('sha256').update(String(text)).digest('base64');
        const hit = margins.get(k);
        if (hit !== undefined) { margins.delete(k); margins.set(k, hit); return hit; }
        const m = pass(text);
        if (margins.size >= MARGINS_KEPT) margins.delete(margins.keys().next().value);
        margins.set(k, m);
        return m;
    };
    let vendorInfo = {};
    try { vendorInfo = JSON.parse(fs.readFileSync(path.join(VENDOR, 'VENDOR.json'), 'utf8')); } catch (e) { /* not synced by the tool */ }
    const fn = (n) => { const f = get(n); if (typeof f !== 'function') throw new Error(`vendor/spruce has no ${n}()`); return f; };
    engine = {
        model,
        modelInfo: { name: manifest.name, version: manifest.version, metrics: manifest.metrics || {} },
        vendor: vendorInfo,
        // Checks (all pure: no network, no browser page).
        headerAnomalies: fn('headerAnomalies'),
        parseRawHeaders: fn('parseRawHeaders'),
        displayNameAnomalies: fn('displayNameAnomalies'),
        nameAddressSigns: fn('nameAddressSigns'),
        ownNameSigns: fn('ownNameSigns'),
        subjectScamSigns: fn('subjectScamSigns'),
        bodyScamSigns: fn('bodyScamSigns'),
        selfVouchingSigns: fn('selfVouchingSigns'),
        layoutSigns: fn('layoutSigns'),
        highRiskRequestSigns: fn('highRiskRequestSigns'),
        highRiskRequestKinds: fn('highRiskRequestKinds'),
        senderContextSigns: fn('senderContextSigns'),
        applyEmailSignals: fn('applyEmailSignals'),
        detectLinkProblem: fn('detectLinkProblem'),
        linkProblemSeverity: fn('linkProblemSeverity'),
        unwrapNestedUrl: fn('unwrapNestedUrl'),
        cloudStoragePage: fn('cloudStoragePage'),
        lookalikeOf: fn('lookalikeOf'),
        registrableDomain: fn('registrableDomain'),
        isPersonalMailDomain: fn('isPersonalMailDomain'),
        isOwnDomain: fn('isOwnDomain'),
        aiAdvice: fn('aiAdvice'),
        // For the network checks (src/intel): the extension's own lists and rules.
        isSingleUseToken: fn('isSingleUseToken'),
        normalizeFeedUrl: fn('normalizeFeedUrl'),
        normalizeSenderEntry: fn('normalizeSenderEntry'),
        linkAgeSigns: fn('linkAgeSigns'),
        PHISH_FEEDS: get('PHISH_FEEDS'),
        PHISH_FEED_MAX_BYTES: get('PHISH_FEED_MAX_BYTES'),
        PHISH_FEED_MAX_ENTRIES: get('PHISH_FEED_MAX_ENTRIES'),
        PHISH_FEED_MIN_ENTRIES: get('PHISH_FEED_MIN_ENTRIES'),
        PROTECTED_DOMAINS: get('PROTECTED_DOMAINS'),
        SENDER_DOMAIN_RE: get('SENDER_DOMAIN_RE'),
        SIGNIN_INTENT_RE: get('SIGNIN_INTENT_RE'),
        modelInputText: fn('modelInputText'),
        // For the retraining export (src/training.js): the model's own redaction, as in training.
        redactForAi: fn('redactForAi'),
        maskRecipient: fn('maskRecipient'),
        isSharedMailbox: fn('isSharedMailbox'),
        gmailReceiver: get(`(WEBMAIL_SITES.find(w => w.id === 'gmail') || { mail: { headers: {} } }).mail.headers.receiver || {}`),
        builtinTrackers: get('typeof BUILTIN_TRACKER_SET !== "undefined" ? BUILTIN_TRACKER_SET : new Set()'),
        SIGNAL_CAUTION_SCORE: get('SIGNAL_CAUTION_SCORE'),
        SIGNAL_FLAG_SCORE: get('SIGNAL_FLAG_SCORE')
    };
    return engine;
}

module.exports = { load };
