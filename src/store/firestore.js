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
// Documents that expire carry expireAt (a Timestamp): Firestore's TTL policies (deploy/install.sh) delete
// them by themselves, typically within a day after it, at no request's cost. purge() removes what has no
// expireAt (written before 0.4.0) and what a shorter RETENTION_DAYS has made old. Reads leave it out.
// Queries use only single-field indexes (processedAt), which Firestore creates by itself; filtering
// by user, action or campaign is done on the (bounded) result. That is enough for a pilot and a
// mid-sized district; a large one would add composite indexes (docs/ROADMAP.md).
const { Firestore, FieldValue, Timestamp } = require('@google-cloud/firestore');
const { movesForward } = require('./history');

const safeId = (s) => String(s).replace(/[/\s]/g, '_').slice(0, 1400);
// Shards of each day's counters (each email adds to one at random): a campaign to every mailbox writes
// about 2 a second to each, not 7. getStats reads them all, and the dashboard keeps past days.
const STAT_SHARDS = 30;
const DAY = 24 * 60 * 60 * 1000;
const ALREADY_EXISTS = 6;   // (gRPC status: create() on a document that exists)
// A document's fields without expireAt (only Firestore's TTL policies use it).
const clean = (v) => { if (!v || !('expireAt' in v)) return v; const { expireAt, ...rest } = v; return rest; };
const shuffled = (n) => { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

class FirestoreStore {
    constructor(cfg) {
        this.db = new Firestore({ databaseId: cfg.firestoreDatabase, ignoreUndefinedProperties: true });
        this.cfg = cfg;
    }
    // How long records are kept: RETENTION_DAYS, or what Settings → Policy says (cfg reads the setting in
    // force when the record is written).
    get keepMs() { return (Number(this.cfg.retentionDays) || 35) * DAY; }
    // When a document written at ms expires (TTL), after keepMs by default: each on its own date.
    expiry(ms, keepMs = this.keepMs) { return Timestamp.fromMillis(ms + keepMs); }
    col(n) { return this.db.collection(n); }
    async getUser(email) { const d = await this.col('users').doc(safeId(email)).get(); return d.exists ? d.data() : null; }
    async putUser(email, patch) { await this.col('users').doc(safeId(email)).set(Object.assign({ email }, patch), { merge: true }); }
    async listUsers() { return (await this.col('users').get()).docs.map(d => d.data()); }
    // What the dashboard and the hourly health check need about the mailboxes, without reading them all
    // (a district has 10,000): how many are watched (a count: one read per 1,000), the latest notification
    // (one read), how many watches end before untilMs (a count). Stopped mailboxes have no watchExpiration.
    async mailboxSummary(untilMs = Date.now() + 24 * 3600 * 1000) {
        const users = this.col('users');
        const [watched, latest, ending] = await Promise.all([
            users.where('watched', '==', true).count().get(),
            users.orderBy('lastNotification', 'desc').limit(1).get(),
            users.where('watchExpiration', '<', untilMs).count().get()
        ]);
        return { watched: watched.data().count, lastNotification: latest.empty ? null : (Number(latest.docs[0].data().lastNotification) || null), ending: ending.data().count };
    }
    // Watched mailboxes for Settings → Mailboxes, at most limit (by address).
    async listWatched(limit = 500) {
        return (await this.col('users').where('watched', '==', true).limit(limit).get()).docs.map(d => d.data()).sort((a, b) => String(a.email).localeCompare(String(b.email)));
    }
    // The mailbox's sync position, only ever moved forward (two notifications can finish in any order).
    // extra: fields written with it (the time of the notification), so a notification costs one write.
    async raiseHistoryId(email, historyId, extra = {}) {
        const ref = this.col('users').doc(safeId(email));
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            const cur = d.exists ? d.data().historyId : null;
            if (!movesForward(historyId, cur)) return cur;
            t.set(ref, Object.assign({}, extra, { email, historyId: String(historyId) }), { merge: true });
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
        // The usual case, a message no instance has had: created, with no read and no lock.
        try { await ref.create({ at: now, state: 'working', tries: 1, expireAt: this.expiry(now) }); return { tries: 1 }; }
        catch (e) { if (e.code !== ALREADY_EXISTS) throw e; }
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            const v = d.exists ? d.data() : null;
            if (v && (v.state || 'done') === 'done') return { done: true };
            if (v && v.state === 'working' && now - v.at < leaseMs) return { busy: true };
            const tries = ((v && v.tries) || 0) + 1;
            t.set(ref, { at: now, state: 'working', tries, expireAt: this.expiry(now) });
            return { tries };
        });
    }
    async unclaim(user, id) { await this.seenRef(user, id).set({ state: 'retry' }, { merge: true }); }
    async markSeen(user, id, extra = {}) { const at = Date.now(); await this.seenRef(user, id).set(Object.assign({ at, state: 'done', expireAt: this.expiry(at) }, extra), { merge: true }); }
    async saveRecord(rec) { await this.col('records').doc(safeId(rec.key)).set(Object.assign({}, rec, { updatedAt: Date.now(), expireAt: this.expiry(Number(rec.processedAt) || Date.now()) })); }
    // Records saved or changed after a time, oldest change first (the dashboard's cache).
    async listRecordsChangedSince(ms, limit = 5000) {
        const q = await this.col('records').where('updatedAt', '>', ms).orderBy('updatedAt').limit(limit).get();
        return q.docs.map(d => clean(d.data()));
    }
    // A campaign's records since sinceMs (Firestore's own single-field index on campaign).
    async listCampaignRecords(key, sinceMs = 0, limit = 50000) {
        const q = await this.col('records').where('campaign', '==', key).limit(limit).get();
        return q.docs.map(d => clean(d.data())).filter(r => r.processedAt >= sinceMs).sort((a, b) => b.processedAt - a.processedAt);
    }
    async getRecord(key) { const d = await this.col('records').doc(safeId(key)).get(); return d.exists ? clean(d.data()) : null; }
    async updateRecord(key, patch) {
        const ref = this.col('records').doc(safeId(key));
        const d = await ref.get();
        if (!d.exists) return null;
        const p = Object.assign({}, patch, { updatedAt: Date.now() });
        await ref.set(p, { merge: true });
        return Object.assign(d.data(), p);
    }
    async listRecords({ sinceMs = 0, untilMs = Number.MAX_SAFE_INTEGER, limit = 5000 } = {}) {
        const q = await this.col('records').where('processedAt', '>=', sinceMs).where('processedAt', '<', untilMs).orderBy('processedAt', 'desc').limit(limit).get();
        return q.docs.map(d => clean(d.data()));
    }
    async incStat(day, field, n = 1) { await this.incStats(day, { [field]: n }); }
    // Several counters of a day in one write ({ scanned: 40, moved: 2 }).
    async incStats(day, counts) {
        const v = { day };
        for (const [k, n] of Object.entries(counts)) v[k] = FieldValue.increment(n);
        await this.col('stats').doc(`${day}~${Math.floor(Math.random() * STAT_SHARDS)}`).set(v, { merge: true });
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
    // Created if new (no read, no lock); the first one's time if it exists (two instances racing: one
    // creates it, the other reads it).
    async senderFirstSeen(hash, now) {
        const ref = this.col('senders').doc(hash);
        try { await ref.create({ firstSeen: now }); return now; }
        catch (e) { if (e.code !== ALREADY_EXISTS) throw e; }
        const d = await ref.get();
        return d.exists ? d.data().firstSeen : now;
    }
    // How many of the organization's people the same outside account shared with this hour (0.5.16): one
    // document per account and hour, in moveCounts (which expire after 2 days, as the brake's counters: no
    // new collection to set up), with the recipients as hashes; crossed: the threshold reached now, once.
    async shareReach(key, userKey, now, threshold) {
        const ref = this.col('moveCounts').doc(safeId(`share~${key}~${Math.floor(now / 3600000)}`));
        return this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            const v = d.exists ? d.data() : {};
            const users = Array.isArray(v.users) ? v.users : [];
            if (!users.includes(userKey) && users.length < 5000) users.push(userKey);
            const crossed = !v.alerted && users.length >= threshold;
            t.set(ref, { users, alerted: !!v.alerted || crossed, at: now, expireAt: this.expiry(now, 2 * DAY) }, { merge: true });
            return { count: users.length, crossed };
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
                t.set(ref, { count: count + 1, at: now, expireAt: this.expiry(now, 2 * DAY) }, { merge: true });
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
                if (first) t.set(ref, { key, label, heldAt: now, at: now, expireAt: this.expiry(now) }, { merge: true });
                return { held: true, first };
            }
            t.set(ref, { key, label, weakMoves: c.weakMoves + 1, at: now, expireAt: this.expiry(now) }, { merge: true });
            return { held: false, count: c.weakMoves + 1 };
        });
    }
    // Counts a campaign's moves (an increment, no transaction); true once, for the move that reached
    // alertAt first (the "large campaign" alert).
    // A moved copy of a campaign, counted until its alert is sent (alertAt moves). alerted() is called once
    // it has been: the caller then stops counting (a campaign to 10,000 mailboxes writes ~50 times, not
    // 10,000 times, to its one document).
    async campaignMoved(key, alertAt, now = Date.now(), alerted = () => {}) {
        const ref = this.col('campaigns').doc(safeId(key));
        await ref.set({ key, moves: FieldValue.increment(1), at: now, expireAt: this.expiry(now) }, { merge: true });
        const v = (await ref.get()).data() || {};
        if (v.alertedAt) { alerted(); return false; }
        if ((v.moves || 0) < alertAt) return false;
        const sent = await this.db.runTransaction(async (t) => {
            const d = await t.get(ref);
            if (d.data().alertedAt) return false;
            t.set(ref, { alertedAt: now }, { merge: true });
            return true;
        });
        alerted();
        return sent;
    }
    async getCampaign(key) { const d = await this.col('campaigns').doc(safeId(key)).get(); return d.exists ? clean(d.data()) : null; }
    async setCampaign(key, patch) { const at = Date.now(); await this.col('campaigns').doc(safeId(key)).set(Object.assign({ key }, patch, { at, expireAt: this.expiry(at) }), { merge: true }); }
    // Only the campaigns ever held (the dashboard asks every 30 s: a few documents, not every campaign).
    async listHeldCampaigns() { return (await this.col('campaigns').where('heldAt', '>', 0).limit(500).get()).docs.map(d => clean(d.data())); }
    async listCampaignStates() { return (await this.col('campaigns').where('at', '>=', Date.now() - 90 * 24 * 3600 * 1000).limit(2000).get()).docs.map(d => clean(d.data())); }
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
    async addEvent(ev) { const e = Object.assign({ at: Date.now() }, ev); await this.col('events').add(Object.assign(e, { expireAt: this.expiry(Number(e.at) || Date.now()) })); }
    async listEvents(sinceMs = 0) {
        const q = await this.col('events').where('at', '>=', sinceMs).orderBy('at', 'desc').limit(500).get();
        return q.docs.map(d => clean(d.data()));
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
    async setCached(kind, key, value, ttlMs) { await this.col('cache').doc(safeId(`${kind}|${key}`)).set({ value, exp: Date.now() + ttlMs, expireAt: this.expiry(Date.now(), ttlMs) }); }
    async countActions(sinceMs, action) {
        const q = await this.col('records').where('processedAt', '>=', sinceMs).orderBy('processedAt', 'desc').limit(5000).get();
        return q.docs.filter(d => d.data().action === action).length;
    }
    // What is older than beforeMs, 400 at a time, until budgetMs is spent (the rest at the next run): with
    // TTL policies on, only documents written before 0.4.0, or made old by a shorter RETENTION_DAYS.
    async purge(beforeMs, { budgetMs = 90 * 1000 } = {}) {
        let n = 0;
        const started = Date.now();
        for (const name of ['records', 'seen', 'events', 'moveCounts', 'campaigns']) {
            const field = name === 'records' ? 'processedAt' : 'at';
            for (;;) {
                if (Date.now() - started > budgetMs) return n;
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
