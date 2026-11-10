'use strict';
// The dashboard's copy of the records (one per dashboard instance). The first use reads the records of
// the retention period; after that, only records saved or changed since (each one has updatedAt), at most
// every refreshMs (from a minute before the newest change seen, so a record saved in the same millisecond,
// or by an instance whose clock is a little behind, isn't missed; seen twice is harmless). Without it, every page of every open dashboard (they update themselves every 30 s)
// read up to 20,000 records from Firestore, which a district's dashboard left open would pay for.
const DAY = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 60 * 1000;

class RecordCache {
    constructor(store, { keepDays = 90, refreshMs = 15000, now = () => Date.now() } = {}) {
        this.store = store; this.keepMs = keepDays * DAY; this.refreshMs = refreshMs; this.now = now;
        this.byKey = new Map(); this.cursor = 0; this.loadedAt = 0; this.loading = null;
    }
    async refresh(force = false) {
        if (this.loading) return this.loading;
        if (!force && this.loadedAt && this.now() - this.loadedAt < this.refreshMs) return;
        this.loading = (async () => {
            const first = !this.loadedAt;
            const at = this.now();
            const rows = first ? await this.store.listRecords({ sinceMs: at - this.keepMs, limit: 50000 })
                : await this.store.listRecordsChangedSince(this.cursor - OVERLAP_MS, 5000);
            for (const r of rows) {
                this.byKey.set(r.key, r);
                this.cursor = Math.max(this.cursor, r.updatedAt || r.processedAt || 0);
            }
            if (first && !rows.length) this.cursor = at - 1;
            for (const [k, r] of this.byKey) if (r.processedAt < at - this.keepMs) this.byKey.delete(k);
            this.loadedAt = at;
        })().finally(() => { this.loading = null; });
        return this.loading;
    }
    // Records processed since sinceMs, newest first (as store.listRecords), copies.
    async list(sinceMs = 0, limit = 20000) {
        await this.refresh();
        return [...this.byKey.values()].filter(r => r.processedAt >= sinceMs).sort((a, b) => b.processedAt - a.processedAt).slice(0, limit)
            .map(r => JSON.parse(JSON.stringify(r)));
    }
    // After the dashboard itself changed records (a release, a mark): seen at the next look, not 15 s later.
    stale() { this.loadedAt = Math.min(this.loadedAt, 1); }
}

module.exports = { RecordCache };
