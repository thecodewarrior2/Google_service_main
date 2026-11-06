'use strict';
// Records kept in memory: demo mode and tests. Same interface as the Firestore store.
//
// A record (one analyzed email the policy acted on or found suspicious; clean mail is only counted):
//   { key, user, messageId, threadId, receivedAt, processedAt, sender: { name, address, domain },
//     subject, campaign, campaignLabel, status, score, signals: [...], links: [...],
//     ai: { probability, reasons, model }, action: 'move'|'would-move'|'flag', trigger, why,
//     state: 'moved'|'inbox'|'released', releasedBy, releasedAt, falseAlarm, markedBy }
class MemoryStore {
    constructor() {
        this.users = new Map(); this.seenIds = new Set(); this.records = new Map(); this.stats = new Map();
        this.senders = new Map(); this.state = new Map(); this.events = [];
    }
    async getUser(email) { return this.users.get(email) || null; }
    async putUser(email, patch) { this.users.set(email, Object.assign({}, this.users.get(email) || { email }, patch)); }
    async listUsers() { return [...this.users.values()]; }
    async seen(user, id) { return this.seenIds.has(`${user}|${id}`); }
    async markSeen(user, id) {
        if (this.seenIds.size > 200000) this.seenIds.delete(this.seenIds.values().next().value);
        this.seenIds.add(`${user}|${id}`);
    }
    async saveRecord(rec) { this.records.set(rec.key, JSON.parse(JSON.stringify(rec))); }
    async getRecord(key) { const r = this.records.get(key); return r ? JSON.parse(JSON.stringify(r)) : null; }
    async updateRecord(key, patch) {
        const r = this.records.get(key);
        if (!r) return null;
        Object.assign(r, patch);
        return JSON.parse(JSON.stringify(r));
    }
    async listRecords({ sinceMs = 0, untilMs = Infinity, limit = 5000 } = {}) {
        return [...this.records.values()].filter(r => r.processedAt >= sinceMs && r.processedAt < untilMs)
            .sort((a, b) => b.processedAt - a.processedAt).slice(0, limit).map(r => JSON.parse(JSON.stringify(r)));
    }
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
    async getState(name) { return this.state.has(name) ? JSON.parse(JSON.stringify(this.state.get(name))) : null; }
    async setState(name, value) { this.state.set(name, value === null ? null : JSON.parse(JSON.stringify(value))); }
    async addEvent(ev) { this.events.push(Object.assign({ at: Date.now() }, ev)); if (this.events.length > 2000) this.events.shift(); }
    async listEvents(sinceMs = 0) { return this.events.filter(e => e.at >= sinceMs).sort((a, b) => b.at - a.at); }
    // Files shared by every instance (the phishing lists): bytes plus a little information.
    async putBlob(name, bytes, info) { this.blobs = this.blobs || new Map(); this.blobs.set(name, { bytes: Buffer.from(bytes), info: Object.assign({}, info) }); }
    async getBlob(name) { const b = this.blobs && this.blobs.get(name); return b ? { bytes: Buffer.from(b.bytes), info: Object.assign({}, b.info) } : null; }
    async blobInfo(name) { const b = this.blobs && this.blobs.get(name); return b ? Object.assign({}, b.info) : null; }
    // Remembered answers shared by every instance (registry dates of domains).
    async getCached(kind, key) { const m = this.cached && this.cached.get(`${kind}|${key}`); return m && m.exp > Date.now() ? m.value : null; }
    async setCached(kind, key, value, ttlMs) { this.cached = this.cached || new Map(); this.cached.set(`${kind}|${key}`, { value, exp: Date.now() + ttlMs }); }
    async countActions(sinceMs, action) { let n = 0; for (const r of this.records.values()) if (r.processedAt >= sinceMs && r.action === action) n++; return n; }
    async purge(beforeMs) {
        let n = 0;
        for (const [k, r] of this.records) if (r.processedAt < beforeMs) { this.records.delete(k); n++; }
        this.events = this.events.filter(e => e.at >= beforeMs);
        return n;
    }
}

module.exports = { MemoryStore };
