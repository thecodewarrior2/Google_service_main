'use strict';
// Records in Firestore (native mode), in the organization's own Google Cloud project. Same interface
// as MemoryStore. Collections:
//   users/{email}           historyId, watchExpiration, lastNotification
//   seen/{user|messageId}   messages already analyzed (so a repeated notification does nothing)
//   records/{key}           see store/memory.js
//   stats/{yyyy-mm-dd}      counters: scanned, moved, wouldMove, flagged, released, falseAlarms, errors
//   senders/{hash}          firstSeen (sender addresses as a 64-bit hash only, as in the extension)
//   state/{name}            brake, installedAt
//   events/{auto}           alerts and errors for the dashboard
// Queries use only single-field indexes (processedAt), which Firestore creates by itself; filtering
// by user, action or campaign is done on the (bounded) result. That is enough for a pilot and a
// mid-sized district; a large one would add composite indexes (docs/ROADMAP.md).
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const safeId = (s) => String(s).replace(/[/\s]/g, '_').slice(0, 1400);

class FirestoreStore {
    constructor(cfg) { this.db = new Firestore({ databaseId: cfg.firestoreDatabase, ignoreUndefinedProperties: true }); }
    col(n) { return this.db.collection(n); }
    async getUser(email) { const d = await this.col('users').doc(safeId(email)).get(); return d.exists ? d.data() : null; }
    async putUser(email, patch) { await this.col('users').doc(safeId(email)).set(Object.assign({ email }, patch), { merge: true }); }
    async listUsers() { return (await this.col('users').get()).docs.map(d => d.data()); }
    async seen(user, id) { return (await this.col('seen').doc(safeId(`${user}|${id}`)).get()).exists; }
    async markSeen(user, id) { await this.col('seen').doc(safeId(`${user}|${id}`)).set({ at: Date.now() }); }
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
    async incStat(day, field, n = 1) { await this.col('stats').doc(day).set({ day, [field]: FieldValue.increment(n) }, { merge: true }); }
    async getStats(fromDay, toDay) {
        const q = await this.col('stats').where('day', '>=', fromDay).where('day', '<=', toDay).orderBy('day').get();
        return q.docs.map(d => d.data());
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
    async getState(name) { const d = await this.col('state').doc(name).get(); return d.exists ? (d.data().value ?? null) : null; }
    async setState(name, value) { await this.col('state').doc(name).set({ value }); }
    async addEvent(ev) { await this.col('events').add(Object.assign({ at: Date.now() }, ev)); }
    async listEvents(sinceMs = 0) {
        const q = await this.col('events').where('at', '>=', sinceMs).orderBy('at', 'desc').limit(500).get();
        return q.docs.map(d => d.data());
    }
    async countActions(sinceMs, action) {
        const q = await this.col('records').where('processedAt', '>=', sinceMs).orderBy('processedAt', 'desc').limit(5000).get();
        return q.docs.filter(d => d.data().action === action).length;
    }
    async purge(beforeMs) {
        let n = 0;
        for (const name of ['records', 'seen', 'events']) {
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
