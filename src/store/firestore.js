'use strict';
// Records in Firestore (native mode), in the organization's own Google Cloud project. Same interface
// as MemoryStore. Collections:
//   users/{email}           historyId, watchExpiration, lastNotification
//   seen/{user|messageId}   messages being or already analyzed: state working (claimed by one instance),
//                           retry (a try failed) or done (also an older document with no state)
//   records/{key}           see store/memory.js
//   stats/{yyyy-mm-dd}~{i}  counters: scanned, moved, wouldMove, flagged, released, falseAlarms, errors, in
//                           STAT_SHARDS documents a day (each document takes about one write a second; a
//                           district's mail is more), summed when read. stats/{yyyy-mm-dd} (before 0.3.0) too.
//   senders/{hash}          firstSeen (sender addresses as a 64-bit hash only, as in the extension)
//   state/{name}            brake, installedAt, watchedCount, …
//   moveCounts/{hour|resume}~{i} moves in a clock hour (the domain-wide brake; a slot reserved before each
//                           move), in up to 32 shards whose limits add up to the brake's limit exactly
//   campaigns/{key}         the campaign brake: weak moves, held, an admin's decision; moves (alerts)
//   events/{auto}           alerts and errors for the dashboard
//   blobs/{name}, ~{i}      the phishing lists (gzip, in chunks), shared by every instance
//   cache/{kind|key}        remembered answers shared by every instance (registry dates)
// Queries use only single-field indexes (processedAt), which Firestore creates by itself; filtering
// by user, action or campaign is done on the (bounded) result. That is enough for a pilot and a
// mid-sized district; a large one would add composite indexes (docs/ROADMAP.md).
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { movesForward } = require('./history');

const safeId = (s) => String(s).replace(/[/\s]/g, '_').slice(0, 1400);
const STAT_SHARDS = 10;
const shuffled = (n) => { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

class FirestoreStore {
    constructor(cfg) { this.db = new Firestore({ databaseId: cfg.firestoreDatabase, ignoreUndefinedProperties: true }); }
    col(n) { return this.db.collection(n); }
    async getUser(email) { const d = await this.col('users').doc(safeId(email)).get(); return d.exists ? d.data() : null; }
    async putUser(email, patch) { await this.col('users').doc(safeId(email)).set(Object.assign({ email }, patch), { merge: true }); }
    async listUsers() { return (await this.col('users').get()).docs.map(d => d.data()); }
    // The mailbox's sync position, only ever moved forward (two notifications can finish in any order).
    async raiseHistoryId(email, historyId) {
        const ref = this.col('users').doc(safeId(email));
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            const cur = d.exists ? d.data().historyId : null;
            if (!movesForward(historyId, cur)) return cur;
            t.set(ref, { email, historyId: String(historyId) }, { merge: true });
            return String(historyId);
        });
    }
    seenRef(user, id) { return this.col('seen').doc(safeId(`${user}|${id}`)); }
    async seen(user, id) { const d = await this.seenRef(user, id).get(); return d.exists && (d.data().state || 'done') === 'done'; }
    // One instance at a time judges a message: { tries } when this one has it, { done } when it was
    // judged, { busy } when another instance took it less than leaseMs ago (a claim older than that was
    // left by an instance that stopped, and is taken over).
    async claim(user, id, now, leaseMs) {
        const ref = this.seenRef(user, id);
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            const v = d.exists ? d.data() : null;
            if (v && (v.state || 'done') === 'done') return { done: true };
            if (v && v.state === 'working' && now - v.at < leaseMs) return { busy: true };
            const tries = ((v && v.tries) || 0) + 1;
            t.set(ref, { at: now, state: 'working', tries });
            return { tries };
        });
    }
    async unclaim(user, id) { await this.seenRef(user, id).set({ state: 'retry' }, { merge: true }); }
    async markSeen(user, id, extra = {}) { await this.seenRef(user, id).set(Object.assign({ at: Date.now(), state: 'done' }, extra), { merge: true }); }
    async saveRecord(rec) { await this.col('records').doc(safeId(rec.key)).set(rec); }
    async getRecord(key) { const d = await this.col('records').doc(safeId(key)).get(); return d.exists ? d.data() : null; }
    async updateRecord(key, patch) {
        const ref = this.col('records').doc(safeId(key));
        const d = await ref.get();
        if (!d.exists) return null;
        await ref.set(patch, { merge: true });
        return Object.assign(d.data(), patch);
    }
    async listRecords({ sinceMs = 0, untilMs = Number.MAX_SAFE_INTEGER, limit = 5000 } = {}) {
        const q = await this.col('records').where('processedAt', '>=', sinceMs).where('processedAt', '<', untilMs).orderBy('processedAt', 'desc').limit(limit).get();
        return q.docs.map(d => d.data());
    }
    async incStat(day, field, n = 1) {
        await this.col('stats').doc(`${day}~${Math.floor(Math.random() * STAT_SHARDS)}`).set({ day, [field]: FieldValue.increment(n) }, { merge: true });
    }
    async getStats(fromDay, toDay) {
        const q = await this.col('stats').where('day', '>=', fromDay).where('day', '<=', toDay).orderBy('day').get();
        const byDay = new Map();
        for (const d of q.docs) {
            const v = d.data(), s = byDay.get(v.day) || { day: v.day };
            for (const [k, x] of Object.entries(v)) if (k !== 'day' && typeof x === 'number') s[k] = (s[k] || 0) + x;
            byDay.set(v.day, s);
        }
        return [...byDay.values()];
    }
    async senderFirstSeen(hash, now) {
        const ref = this.col('senders').doc(hash);
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            if (d.exists) return d.data().firstSeen;
            t.set(ref, { firstSeen: now });
            return now;
        });
    }
    // The domain-wide brake: a slot is reserved before each move, in one transaction on one of up to 32
    // shards (tried in random order), each with its share of the limit, so the shares add up to the limit
    // exactly and instances moving at the same moment rarely wait for each other.
    async reserveMove(bucket, limit, now = Date.now()) {
        const n = Math.max(1, Math.min(32, limit));
        const cap = (i) => Math.floor(limit / n) + (i < limit % n ? 1 : 0);
        for (const i of shuffled(n)) {
            const ref = this.col('moveCounts').doc(safeId(`${bucket}~${i}`));
            const got = await this.db.runTransaction(async (t) => {
                const d = await t.get(ref);
                const count = d.exists ? d.data().count || 0 : 0;
                if (count >= cap(i)) return false;
                t.set(ref, { count: count + 1, at: now }, { merge: true });
                return true;
            });
            if (got) return { ok: true };
        }
        return { ok: false, count: limit };
    }
    // The campaign hold: a transaction only while the campaign is under its limit (at most holdAfter of
    // them, plus the one that marks it held); copies after that only read it.
    async campaignHold(key, holdAfter, now = Date.now(), label = '') {
        const ref = this.col('campaigns').doc(safeId(key));
        const seen = await ref.get();
        const v = seen.exists ? seen.data() : {};
        if (v.decision) return { decision: v.decision, held: false };
        if ((v.weakMoves || 0) >= holdAfter && v.heldAt) return { held: true, first: false };
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            const c = Object.assign({ key, label, weakMoves: 0, heldAt: null, decision: null }, d.exists ? d.data() : {});
            if (c.decision) return { decision: c.decision, held: false };
            if (c.weakMoves >= holdAfter) {
                const first = !c.heldAt;
                if (first) t.set(ref, { key, label, heldAt: now, at: now }, { merge: true });
                return { held: true, first };
            }
            t.set(ref, { key, label, weakMoves: c.weakMoves + 1, at: now }, { merge: true });
            return { held: false, count: c.weakMoves + 1 };
        });
    }
    // Counts a campaign's moves (an increment, no transaction); true once, for the move that reached
    // alertAt first (the "large campaign" alert).
    async campaignMoved(key, alertAt, now = Date.now()) {
        const ref = this.col('campaigns').doc(safeId(key));
        await ref.set({ key, moves: FieldValue.increment(1), at: now }, { merge: true });
        const v = (await ref.get()).data() || {};
        if ((v.moves || 0) < alertAt || v.alertedAt) return false;
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            if (d.data().alertedAt) return false;
            t.set(ref, { alertedAt: now }, { merge: true });
            return true;
        });
    }
    async getCampaign(key) { const d = await this.col('campaigns').doc(safeId(key)).get(); return d.exists ? d.data() : null; }
    async setCampaign(key, patch) { await this.col('campaigns').doc(safeId(key)).set(Object.assign({ key }, patch, { at: Date.now() }), { merge: true }); }
    async listCampaignStates() { return (await this.col('campaigns').where('at', '>=', Date.now() - 90 * 24 * 3600 * 1000).limit(2000).get()).docs.map(d => d.data()); }
    // Sets a state only when it isn't set yet (the brake: one alert when instances trip it together).
    async setStateIfUnset(name, value) {
        const ref = this.col('state').doc(name);
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            if (d.exists && d.data().value) return false;
            t.set(ref, { value });
            return true;
        });
    }
    async getState(name) { const d = await this.col('state').doc(name).get(); return d.exists ? (d.data().value ?? null) : null; }
    async setState(name, value) { await this.col('state').doc(name).set({ value }); }
    async addEvent(ev) { await this.col('events').add(Object.assign({ at: Date.now() }, ev)); }
    async listEvents(sinceMs = 0) {
        const q = await this.col('events').where('at', '>=', sinceMs).orderBy('at', 'desc').limit(500).get();
        return q.docs.map(d => d.data());
    }
    // Files shared by every instance (the phishing lists), split into chunks under Firestore's 1 MiB
    // document limit: blobs/{name} holds the information, blobs/{name}~{i} the chunks.
    async putBlob(name, bytes, info) {
        const buf = Buffer.from(bytes), size = 900 * 1024, n = Math.ceil(buf.length / size) || 1;
        const old = await this.blobInfo(name);
        for (let i = 0; i < n; i++) await this.col('blobs').doc(`${safeId(name)}~${i}`).set({ data: buf.subarray(i * size, (i + 1) * size) });
        await this.col('blobs').doc(safeId(name)).set({ info: Object.assign({}, info, { chunks: n, bytes: buf.length }) });
        for (let i = n; old && i < (old.chunks || 0); i++) await this.col('blobs').doc(`${safeId(name)}~${i}`).delete();
    }
    async blobInfo(name) { const d = await this.col('blobs').doc(safeId(name)).get(); return d.exists ? d.data().info : null; }
    async getBlob(name) {
        const info = await this.blobInfo(name);
        if (!info) return null;
        const parts = [];
        for (let i = 0; i < info.chunks; i++) { const d = await this.col('blobs').doc(`${safeId(name)}~${i}`).get(); if (!d.exists) return null; parts.push(Buffer.from(d.data().data)); }
        return { bytes: Buffer.concat(parts), info };
    }
    // Remembered answers shared by every instance (registry dates of domains): cache/{kind|key}.
    async getCached(kind, key) { const d = await this.col('cache').doc(safeId(`${kind}|${key}`)).get(); const v = d.exists ? d.data() : null; return v && v.exp > Date.now() ? v.value : null; }
    async setCached(kind, key, value, ttlMs) { await this.col('cache').doc(safeId(`${kind}|${key}`)).set({ value, exp: Date.now() + ttlMs }); }
    async countActions(sinceMs, action) {
        const q = await this.col('records').where('processedAt', '>=', sinceMs).orderBy('processedAt', 'desc').limit(5000).get();
        return q.docs.filter(d => d.data().action === action).length;
    }
    async purge(beforeMs) {
        let n = 0;
        for (const name of ['records', 'seen', 'events', 'moveCounts', 'campaigns']) {
            const field = name === 'records' ? 'processedAt' : 'at';
            for (;;) {
                const q = await this.col(name).where(field, '<', beforeMs).limit(400).get();
                if (q.empty) break;
                const batch = this.db.batch();
                q.docs.forEach(d => batch.delete(d.ref));
                await batch.commit();
                n += q.size;
            }
        }
        return n;
    }
}

module.exports = { FirestoreStore };
