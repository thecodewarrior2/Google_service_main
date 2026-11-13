'use strict';
// The checks and the AI model, run on the server.
//
// vendor/spruce/ holds shared.js, decoders.js, ai.js and the model (models/phish-tiny). They began as the
// S.P.R.U.C.E+ browser extension's files (VENDOR.json says from which commit); since 0.4.0 they are this
// project's own code, changed here. They are plain JavaScript; they run here in a separate context with the
// language's own objects (URL, TextDecoder…). What only the extension used (its pages, settings, storage,
// webmail layouts, sender pictures) was removed in 0.5.20.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadModel } = require('./model');

const VENDOR = path.resolve(__dirname, '..', '..', 'vendor', 'spruce');

let engine = null;

function load() {
    if (engine) return engine;
    // Only the language's own objects: the extension's browser-only code (pages, storage, its own network
    // calls, webmail layouts) was removed from vendor/spruce in 0.5.20, so nothing of "chrome" or "fetch" is used.
    const ctx = { console, URL, URLSearchParams, TextDecoder, TextEncoder, atob, btoa, setTimeout, clearTimeout, Intl, BigInt };
    vm.createContext(ctx);
    for (const f of ['shared.js', 'decoders.js', 'ai.js']) {
        vm.runInContext(fs.readFileSync(path.join(VENDOR, f), 'utf8'), ctx, { filename: `vendor/spruce/${f}` });
    }
    const get = (name) => vm.runInContext(name, ctx);
    // The model: its input and tokens from ai.js, the network in the native engine (src/engine/model.js).
    const MODEL_DIR = path.join(VENDOR, 'models', 'phish-tiny');
    const manifest = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'model.json'), 'utf8'));
    const vocab = fs.readFileSync(path.join(MODEL_DIR, 'vocab.txt'), 'utf8');
    const WordPiece = get('WordPiece');
    const model = loadModel({ dir: MODEL_DIR, manifest, tokenizer: new WordPiece(vocab), modelInputParts: get('modelInputParts') });
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
        colleagueNameHash: fn('colleagueNameHash'),
        colleagueLineSigns: fn('colleagueLineSigns'),
        ownDomainLookalike: fn('ownDomainLookalike'),
        isPersonalMailDomain: fn('isPersonalMailDomain'),
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
        // Gmail's receiving mail system, whose own Authentication-Results and delivery records can be trusted
        // (the only thing the service needed from the extension's table of webmail page layouts).
        gmailReceiver: Object.freeze({ host: 'mx.google.com', name: 'Gmail' }),
        builtinTrackers: get('BUILTIN_TRACKER_SET'),
        SIGNAL_CAUTION_SCORE: get('SIGNAL_CAUTION_SCORE'),
        SIGNAL_FLAG_SCORE: get('SIGNAL_FLAG_SCORE')
    };
    return engine;
}

module.exports = { load };
