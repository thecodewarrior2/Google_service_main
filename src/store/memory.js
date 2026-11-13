'use strict';
const { movesForward } = require('./history');
// Records kept in memory: demo mode and tests. Same interface as the Firestore store.
//
// A record (one analyzed email the policy acted on or found suspicious; clean mail is only counted):
//   { key, user, messageId, threadId, receivedAt, processedAt, sender: { name, address, domain },
//     subject, campaign, campaignLabel, status, score, signals: [...], links: [...],
//     ai: { probability, reasons, model }, action: 'move'|'would-move'|'flag', trigger, why,
//     state: 'moved'|'inbox'|'released', releasedBy, releasedAt, falseAlarm, markedBy }
class MemoryStore {
    constructor() {
        this.users = new Map(); this.seenIds = new Map(); this.records = new Map(); this.stats = new Map();
        this.senders = new Map(); this.state = new Map(); this.events = [];
        this.moveCounts = new Map(); this.campaignState = new Map();
    }
    async getUser(email) { return this.users.get(email) || null; }
    async putUser(email, patch) { this.users.set(email, Object.assign({}, this.users.get(email) || { email }, patch)); }
    async mailboxSummary(untilMs = Date.now() + 24 * 3600 * 1000) {
        const us = [...this.users.values()];
        const last = Math.max(0, ...us.map(u => Number(u.lastNotification) || 0));
        return { watched: us.filter(u => u.watched).length, lastNotification: last || null, ending: us.filter(u => typeof u.watchExpiration === 'number' && u.watchExpiration < untilMs).length };
    }
    async listWatched(limit = 500) { return (await this.listUsers()).filter(u => u.watched).sort((a, b) => String(a.email).localeCompare(String(b.email))).slice(0, limit); }
    async listUsers() { return [...this.users.values()]; }
    // The mailbox's sync position, only ever moved forward. Returns the position kept.
    async raiseHistoryId(email, historyId, extra = {}) {
        const u = this.users.get(email);
        if (u && !movesForward(historyId, u.historyId)) return u.historyId;
        await this.putUser(email, Object.assign({}, extra, { historyId: String(historyId) }));
        return String(historyId);
    }
    // Messages: claimed by one instance while it judges them ({ tries }), or { done } / { busy } (another
    // instance has had it for less than leaseMs). See store/firestore.js.
    async seen(user, id) { const v = this.seenIds.get(`${user}|${id}`); return !!v && v.state === 'done'; }
    async claim(user, id, now, leaseMs) {
        const k = `${user}|${id}`, v = this.seenIds.get(k);
        if (v && v.state === 'done') return { done: true };
        if (v && v.state === 'working' && now - v.at < leaseMs) return { busy: true };
        const tries = ((v && v.tries) || 0) + 1;
        this.setSeen(k, { at: now, state: 'working', tries });
        return { tries };
    }
    async unclaim(user, id) { const v = this.seenIds.get(`${user}|${id}`); if (v) v.state = 'retry'; }
    async markSeen(user, id, extra = {}) {
        const k = `${user}|${id}`, v = this.seenIds.get(k);
        this.setSeen(k, Object.assign({ at: Date.now(), state: 'done' }, v && v.tries ? { tries: v.tries } : {}, extra));
    }
    setSeen(k, v) {
        if (!this.seenIds.has(k) && this.seenIds.size > 200000) this.seenIds.delete(this.seenIds.keys().next().value);
        this.seenIds.set(k, v);
    }
    // The emails whose re-check hashes include any of these (see store/firestore.js).
    async findIndexed(hashes, sinceMs = 0, limit = 5000) {
        const want = new Set(hashes), out = [];
        for (const [k, v] of this.seenIds) {
            if (!Array.isArray(v.ix) || !v.ix.some(x => want.has(x))) continue;
            const rx = Number(v.rx) || Number(v.at) || 0;
            if (rx < sinceMs) continue;
            const i = k.lastIndexOf('|');
            out.push({ user: k.slice(0, i), id: k.slice(i + 1), receivedAt: rx, ix: v.ix.slice() });
            if (out.length >= limit) break;
        }
        return out;
    }
    async saveRecord(rec) { this.records.set(rec.key, JSON.parse(JSON.stringify(Object.assign({}, rec, { updatedAt: Date.now() })))); }
    // Records saved or changed after a time (the dashboard's cache: src/dashboard/cache.js).
    async listRecordsChangedSince(ms, limit = 5000) {
        return [...this.records.values()].filter(r => (r.updatedAt || r.processedAt) > ms).sort((a, b) => (a.updatedAt || a.processedAt) - (b.updatedAt || b.processedAt))
            .slice(0, limit).map(r => JSON.parse(JSON.stringify(r)));
    }
    async getRecord(key) { const r = this.records.get(key); return r ? JSON.parse(JSON.stringify(r)) : null; }
    async updateRecord(key, patch) {
        const r = this.records.get(key);
        if (!r) return null;
        Object.assign(r, patch, { updatedAt: Math.max(Date.now(), (r.updatedAt || 0) + 1) });
        return JSON.parse(JSON.stringify(r));
    }
    async listCampaignRecords(key, sinceMs = 0) { return (await this.listRecords({ sinceMs, limit: Infinity })).filter(r => r.campaign === key); }
    async listRecords({ sinceMs = 0, untilMs = Infinity, limit = 5000 } = {}) {
        return [...this.records.values()].filter(r => r.processedAt >= sinceMs && r.processedAt < untilMs)
            .sort((a, b) => b.processedAt - a.processedAt).slice(0, limit).map(r => JSON.parse(JSON.stringify(r)));
    }
    async incStats(day, counts) { for (const [k, n] of Object.entries(counts)) await this.incStat(day, k, n); }
    async incStat(day, field, n = 1) {
        const s = this.stats.get(day) || { day };
        s[field] = (s[field] || 0) + n;
        this.stats.set(day, s);
    }
    async getStats(fromDay, toDay) {
        return [...this.stats.values()].filter(s => s.day >= fromDay && s.day <= toDay).sort((a, b) => (a.day < b.day ? -1 : 1));
    }
    async senderFirstSeen(hash, now) {
        if (!this.senders.has(hash)) this.senders.set(hash, now);
        return this.senders.get(hash);
    }
    // How many people the same outside account shared with this hour (see store/firestore.js).
    async shareReach(key, userKey, now, threshold) {
        this.shares = this.shares || new Map();
        const id = `${key}~${Math.floor(now / 3600000)}`;
        const s = this.shares.get(id) || { users: new Set(), alerted: false, at: now };
        s.users.add(userKey);
        const crossed = !s.alerted && s.users.size >= threshold;
        if (crossed) s.alerted = true;
        this.shares.set(id, s);
        if (this.shares.size > 10000) this.shares.delete(this.shares.keys().next().value);
        return { count: s.users.size, crossed };
    }
    // The brakes' counters (see store/firestore.js; here each call is atomic by itself).
    async reserveMove(bucket, limit, now = Date.now()) {
        const c = this.moveCounts.get(bucket) || { count: 0, at: now };
        if (c.count >= limit) return { ok: false, count: c.count };
        c.count++; c.at = now; this.moveCounts.set(bucket, c);
        return { ok: true, count: c.count };
    }
    async campaignHold(key, holdAfter, now = Date.now(), label = '') {
        const c = Object.assign({ key, label, weakMoves: 0, heldAt: null, decision: null }, this.campaignState.get(key));
        if (c.decision) return { decision: c.decision, held: false };
        if (c.weakMoves >= holdAfter) { const first = !c.heldAt; if (first) c.heldAt = now; c.at = now; this.campaignState.set(key, c); return { held: true, first }; }
        c.weakMoves++; c.at = now; this.campaignState.set(key, c);
        return { held: false, count: c.weakMoves };
    }
    async campaignMoved(key, alertAt, now = Date.now(), alerted = () => {}) {
        const c = Object.assign({ key, weakMoves: 0, moves: 0, alertedAt: null }, this.campaignState.get(key));
        if (c.alertedAt) { alerted(); return false; }
        c.moves = (c.moves || 0) + 1; c.at = now;
        const alert = c.moves >= alertAt;
        if (alert) { c.alertedAt = now; alerted(); }
        this.campaignState.set(key, c);
        return alert;
    }
    async getCampaign(key) { const c = this.campaignState.get(key); return c ? JSON.parse(JSON.stringify(c)) : null; }
    async setCampaign(key, patch) { this.campaignState.set(key, Object.assign({ key }, this.campaignState.get(key) || {}, patch, { at: Date.now() })); }
    async listCampaignStates() { return [...this.campaignState.values()].map(c => JSON.parse(JSON.stringify(c))); }
    async listHeldCampaigns() { return (await this.listCampaignStates()).filter(c => c.heldAt); }
    // Sets a state only when it isn't set yet (the brake: one alert when instances trip it together).
    async setStateIfUnset(name, value) {
        if (this.state.get(name)) return false;
        this.state.set(name, JSON.parse(JSON.stringify(value)));
        return true;
    }
    async getState(name) { return this.state.has(name) ? JSON.parse(JSON.stringify(this.state.get(name))) : null; }
    async setState(name, value) { this.state.set(name, value === null ? null : JSON.parse(JSON.stringify(value))); }
    async addEvent(ev) { const e = Object.assign({ at: Date.now() }, ev); this.events.push(e); if (this.events.length > 5000) this.events.shift(); if (this.onEvent) this.onEvent(e); }
    async listEvents(sinceMs = 0, { limit = 500 } = {}) { return this.events.filter(e => e.at >= sinceMs).sort((a, b) => b.at - a.at).slice(0, limit); }
    // Files shared by every instance (the phishing lists): bytes plus a little information.
    async putBlob(name, bytes, info) { this.blobs = this.blobs || new Map(); this.blobs.set(name, { bytes: Buffer.from(bytes), info: Object.assign({}, info) }); }
    async getBlob(name) { const b = this.blobs && this.blobs.get(name); return b ? { bytes: Buffer.from(b.bytes), info: Object.assign({}, b.info) } : null; }
    async blobInfo(name) { const b = this.blobs && this.blobs.get(name); return b ? Object.assign({}, b.info) : null; }
    // Remembered answers shared by every instance (registry dates of domains).
    async getCached(kind, key) { const m = this.cached && this.cached.get(`${kind}|${key}`); return m && m.exp > Date.now() ? m.value : null; }
    async setCached(kind, key, value, ttlMs) { this.cached = this.cached || new Map(); this.cached.set(`${kind}|${key}`, { value, exp: Date.now() + ttlMs }); }
    async countActions(sinceMs, action) { let n = 0; for (const r of this.records.values()) if (r.processedAt >= sinceMs && r.action === action) n++; return n; }
    async purge(beforeMs, { eventsBeforeMs = beforeMs } = {}) {
        let n = 0;
        for (const [k, r] of this.records) if (r.processedAt < beforeMs) { this.records.delete(k); n++; }
        this.events = this.events.filter(e => e.at >= eventsBeforeMs);
        return n;
    }
}

module.exports = { MemoryStore };
