'use strict';
// The dashboard's copy of the records (one per dashboard instance). The first use reads the records of
// the last startDays (32: the 30 days the Overview and the other pages show first, from the midnight
// before, with a day to spare); a page that shows
// more (Last 90 days) has the older ones read then, up to the retention period, and they are forgotten
// again after OLDER_KEPT_MS without such a page. After that, only records saved or changed since (each
// one has updatedAt), at most every refreshMs (from a minute before the newest change seen, so a record
// saved in the same millisecond, or by an instance whose clock is a little behind, isn't missed; seen
// twice is harmless). Without it, every page of every open dashboard (they update themselves every 30 s)
// read up to 20,000 records from Firestore, which a district's dashboard left open would pay for.
const DAY = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 60 * 1000;
const PAGE = 10000;                       // records read at a time when the cache starts
const OLDER_KEPT_MS = 60 * 60 * 1000;     // records older than startDays, kept this long after a page last used them
const INTERNED = 200000;                  // distinct strings shared between records (then started again)

// What the dashboard's pages use of a record (src/dashboard/aggregate.js, the lists, the CSV, the review
// queues), and nothing else: an email's own page reads the whole record from the store. The signs kept are
// those that count for "top reasons" (weight 2 or more). Strings that repeat (a campaign's sender, subject
// and signs) are shared, not copied. About a fifth of a full record's memory: a district's 60 days
// (180,000 records) fit in the dashboard's memory.
function slimmer() {
    const pool = new Map();
    const I = (v) => {
        if (typeof v !== 'string') return v;
        const hit = pool.get(v);
        if (hit !== undefined) return hit;
        if (pool.size >= INTERNED) pool.clear();
        pool.set(v, v);
        return v;
    };
    return (r) => Object.freeze({
        key: r.key, user: I(r.user), messageId: r.messageId, rfc822MessageId: r.rfc822MessageId, threadId: r.threadId,
        processedAt: r.processedAt, receivedAt: r.receivedAt, updatedAt: r.updatedAt,
        sender: r.sender ? Object.freeze({ name: I(r.sender.name), address: I(r.sender.address), domain: I(r.sender.domain) }) : r.sender,
        subject: I(r.subject), campaign: I(r.campaign), campaignLabel: I(r.campaignLabel),
        status: I(r.status), score: r.score, evidence: I(r.evidence), action: I(r.action), trigger: I(r.trigger), why: I(r.why), mode: I(r.mode),
        ai: r.ai ? Object.freeze({ probability: r.ai.probability, model: I(r.ai.model) }) : r.ai,
        signals: Object.freeze((r.signals || []).filter(x => x && x.weight >= 2).map(x => Object.freeze({ kind: I(x.kind), text: I(x.text), weight: x.weight }))),
        state: I(r.state), held: I(r.held), braked: r.braked, userPlaced: r.userPlaced, ownAddressUnverified: r.ownAddressUnverified,
        releasedBy: I(r.releasedBy), releasedAt: r.releasedAt, releasedByUser: r.releasedByUser, falseAlarm: r.falseAlarm, markedBy: I(r.markedBy),
        heldMovedBy: I(r.heldMovedBy)
    });
}

class RecordCache {
    // keepDays: how far back records are kept (a number, or a function for a setting that can change:
    // Settings → Policy, how long records are kept). startDays: what the first use reads.
    constructor(store, { keepDays = 90, startDays = 32, refreshMs = 15000, now = () => Date.now() } = {}) {
        this.store = store; this.keepDays = keepDays; this.startMs = startDays * DAY; this.refreshMs = refreshMs; this.now = now;
        this.byKey = new Map(); this.cursor = 0; this.loadedAt = 0; this.loading = null; this.slim = slimmer();
        this.from = Infinity;     // every record processed since this is held (Infinity: none read yet)
        this.olderUsedAt = 0; this.extending = null;
    }
    get keepMs() { return (typeof this.keepDays === 'function' ? this.keepDays() : this.keepDays) * DAY; }
    // Every record processed from sinceMs to before untilMs, PAGE at a time (newest first).
    async readAll(sinceMs, untilMs = Number.MAX_SAFE_INTEGER) {
        const rows = [];
        let until = untilMs;
        for (;;) {
            const page = await this.store.listRecords({ sinceMs, untilMs: until, limit: PAGE });
            rows.push(...page);
            if (page.length < PAGE) return rows;
            const last = page[page.length - 1].processedAt;
            if (!(last < until)) return rows;        // (more than PAGE in one millisecond: never in practice)
            until = last + 1;                        // (the last millisecond is read again; kept once, by key)
        }
    }
    async refresh(force = false) {
        if (this.loading) return this.loading;
        if (!force && this.loadedAt && this.now() - this.loadedAt < this.refreshMs) return;
        this.loading = (async () => {
            const first = !this.loadedAt;
            const at = this.now(), keepMs = this.keepMs;
            const from = at - Math.min(this.startMs, keepMs);
            const rows = first ? await this.readAll(from)
                : await this.store.listRecordsChangedSince(this.cursor - OVERLAP_MS, 5000);
            if (first) this.from = from;
            for (const r of rows) {
                if (r.processedAt >= this.from) this.byKey.set(r.key, this.slim(r));   // (an older one changed: read when a page needs it)
                this.cursor = Math.max(this.cursor, r.updatedAt || r.processedAt || 0);
            }
            if (first && !rows.length) this.cursor = at - 1;
            // Past the retention period (it may have been shortened); and the older part, when no page has
            // needed it for OLDER_KEPT_MS.
            let floor = at - keepMs;
            if (this.from < at - this.startMs && at - this.olderUsedAt > OLDER_KEPT_MS) floor = Math.max(floor, at - this.startMs);
            if (this.from < floor) {
                for (const [k, r] of this.byKey) if (r.processedAt < floor) this.byKey.delete(k);
                this.from = floor;
            }
            this.loadedAt = at;
        })().finally(() => { this.loading = null; });
        return this.loading;
    }
    // The records from sinceMs to the oldest held, read when a page first shows a longer period.
    async extend(sinceMs) {
        while (this.extending) await this.extending;
        if (sinceMs >= this.from) return;
        this.extending = (async () => {
            const until = this.from;
            const rows = await this.readAll(sinceMs, until);
            for (const r of rows) if (!this.byKey.has(r.key)) this.byKey.set(r.key, this.slim(r));
            this.from = Math.min(this.from, sinceMs);
        })().finally(() => { this.extending = null; });
        return this.extending;
    }
    // Records processed since sinceMs (within the retention period), newest first (as store.listRecords):
    // the cache's own (frozen) slim records, not copies: the pages only read them.
    async list(sinceMs = 0, limit = Infinity) {
        await this.refresh();
        const at = this.now(), s = Math.max(sinceMs, at - this.keepMs);
        if (s < at - this.startMs) this.olderUsedAt = at;
        if (s < this.from) await this.extend(s);
        const out = [];
        for (const r of this.byKey.values()) if (r.processedAt >= s) out.push(r);
        out.sort((a, b) => b.processedAt - a.processedAt);
        return out.length > limit ? out.slice(0, limit) : out;
    }
    // After the dashboard itself changed records (a release, a mark): seen at the next look, not 15 s later.
    stale() { this.loadedAt = Math.min(this.loadedAt, 1); }
}

module.exports = { RecordCache, slimmer, OLDER_KEPT_MS };
