'use strict';
const { MemoryStore } = require('./memory');

function createStore(cfg) {
    if (cfg.store === 'memory') return new MemoryStore();
    if (cfg.store === 'firestore') { const { FirestoreStore } = require('./firestore'); return new FirestoreStore(cfg); }
    throw new Error(`Unknown STORE "${cfg.store}" (memory or firestore).`);
}

module.exports = { createStore };
