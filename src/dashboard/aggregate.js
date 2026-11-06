// The dashboard's numbers, from the records and daily counters. Plain functions with no Node or browser
// specifics: the server's API uses them, and so does the clickable mockup (tools/build-mockup.js), so
// the mockup shows exactly what the real dashboard would.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SpruceAggregate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DAY = 24 * 60 * 60 * 1000;
    const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
    const days = (now, n) => Array.from({ length: n }, (_, i) => dayOf(now - (n - 1 - i) * DAY));
    const isMove = (r) => r.action === 'move';
    const TRIGGERS = { rules: 'Rules', ai: 'AI score', 'rules+ai': 'Rules + AI' };

    // What a signal is about, for "top reasons" (the extension's sign texts, grouped).
    function signalCategory(s) {
        const k = s.kind || '', t = String(s.text || '');
        if (k === 'dangerous-links' || /links? (is|are) flagged as dangerous/.test(t)) return 'Dangerous links';
        if (/DMARC|sender's verification|signature/.test(t)) return 'Failed sender check';
        if (k === 'hidden-filler' || /unrelated text far below/.test(t)) return 'Hidden filler text';
        if (k === 'high-risk-request') return 'Asks for password, codes, money';
        if (k === 'safety-claim' || k === 'ai-directed') return 'Claims to be safe / talks to AI';
        if (/your own mailbox name|your own email address/.test(t)) return 'Sender named after recipient';
        if (/sender's name says|look-alike|imitat|mixes letters/.test(t)) return 'Brand or look-alike sender';
        if (k === 'spam-flag' || k === 'local-tool' || k === 'placeholders' || k === 'broken-to' || k === 'forged-received' || k === 'duplicate-headers' || k === 'markup') return 'Forged or spam headers';
        if (/call|phone number/.test(t)) return 'Call-this-number scam';
        if (k === 'outside-org' || k === 'first-time') return 'New outside sender';
        return 'Other signs';
    }

    function summary(records, stats, now, n) {
        const since = now - n * DAY;
        const rs = records.filter(r => r.processedAt >= since);
        const from = dayOf(since + DAY);
        const st = stats.filter(s => s.day >= from);
        const sum = (f) => st.reduce((a, s) => a + (s[f] || 0), 0);
        const moved = rs.filter(isMove);
        const released = moved.filter(r => r.state === 'released');
        const users = new Set(rs.filter(r => r.action !== 'flag').map(r => r.user));
        const camps = new Set(moved.map(r => r.campaign));
        return {
            days: n, scanned: sum('scanned'), moved: moved.length, wouldMove: rs.filter(r => r.action === 'would-move').length,
            flagged: rs.filter(r => r.action === 'flag').length, released: released.length,
            falseAlarms: rs.filter(r => r.falseAlarm === true).length, usersAffected: users.size, campaigns: camps.size,
            releaseRate: moved.length ? released.length / moved.length : 0, errors: sum('errors'),
            byTrigger: Object.fromEntries(Object.keys(TRIGGERS).map(k => [k, rs.filter(r => (r.action === 'move' || r.action === 'would-move') && r.trigger === k).length]))
        };
    }

    function trend(records, stats, now, n) {
        const ds = days(now, n);
        const byDay = Object.fromEntries(ds.map(d => [d, { day: d, scanned: 0, rules: 0, ai: 0, 'rules+ai': 0, wouldMove: 0, flagged: 0, released: 0 }]));
        for (const s of stats) if (byDay[s.day]) byDay[s.day].scanned = s.scanned || 0;
        for (const r of records) {
            const d = byDay[dayOf(r.processedAt)];
            if (!d) continue;
            if (isMove(r)) d[r.trigger || 'rules']++;
            else if (r.action === 'would-move') d.wouldMove++;
            else d.flagged++;
            if (r.state === 'released' && r.releasedAt && byDay[dayOf(r.releasedAt)]) byDay[dayOf(r.releasedAt)].released++;
        }
        return ds.map(d => byDay[d]);
    }

    function topReasons(records, now, n) {
        const since = now - n * DAY;
        const counts = {};
        for (const r of records) {
            if (r.processedAt < since || (r.action !== 'move' && r.action !== 'would-move')) continue;
            const cats = new Set((r.signals || []).filter(s => s.weight >= 2).map(signalCategory));
            if (r.ai && r.ai.probability >= 0.85) cats.add('AI: reads like phishing');
            for (const c of cats) counts[c] = (counts[c] || 0) + 1;
        }
        return Object.entries(counts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    }

    function campaigns(records, now, n) {
        const since = now - n * DAY;
        const m = new Map();
        for (const r of records) {
            if (r.processedAt < since) continue;
            let c = m.get(r.campaign);
            if (!c) { c = { campaign: r.campaign, label: r.campaignLabel, senderDomain: r.sender.domain, subject: r.subject, recipients: new Set(), messages: 0, moved: 0, wouldMove: 0, released: 0, firstAt: r.processedAt, lastAt: r.processedAt, maxAi: 0, reasons: {} }; m.set(r.campaign, c); }
            c.recipients.add(r.user); c.messages++;
            if (isMove(r)) c.moved++; else if (r.action === 'would-move') c.wouldMove++;
            if (r.state === 'released') c.released++;
            c.firstAt = Math.min(c.firstAt, r.processedAt); c.lastAt = Math.max(c.lastAt, r.processedAt);
            if (r.ai && r.ai.probability > c.maxAi) c.maxAi = r.ai.probability;
            for (const s of r.signals || []) if (s.weight >= 2) { const k = signalCategory(s); c.reasons[k] = (c.reasons[k] || 0) + 1; }
        }
        return [...m.values()].map(c => Object.assign(c, { recipients: c.recipients.size, topReason: (Object.entries(c.reasons).sort((a, b) => b[1] - a[1])[0] || ['AI score'])[0] }))
            .map(({ reasons, ...rest }) => rest)
            .sort((a, b) => b.recipients - a.recipients || b.lastAt - a.lastAt);
    }

    function users(records, now, n) {
        const since = now - n * DAY;
        const m = new Map();
        for (const r of records) {
            if (r.processedAt < since) continue;
            let u = m.get(r.user);
            if (!u) { u = { user: r.user, moved: 0, wouldMove: 0, flagged: 0, released: 0, last: 0 }; m.set(r.user, u); }
            if (isMove(r)) u.moved++; else if (r.action === 'would-move') u.wouldMove++; else u.flagged++;
            if (r.state === 'released') u.released++;
            u.last = Math.max(u.last, r.processedAt);
        }
        return [...m.values()].sort((a, b) => (b.moved + b.wouldMove) - (a.moved + a.wouldMove) || b.last - a.last);
    }

    function filterRecords(records, q = {}) {
        const text = String(q.q || '').toLowerCase();
        return records.filter(r => (!q.user || r.user === q.user) && (!q.campaign || r.campaign === q.campaign)
            && (!q.action || r.action === q.action) && (!q.state || r.state === q.state)
            && (!q.since || r.processedAt >= q.since)
            && (!text || `${r.user} ${r.sender.address} ${r.sender.name} ${r.subject}`.toLowerCase().includes(text)));
    }

    // How the AI and the rules are doing: scores of recorded emails, and how often each kind of move
    // was undone (released) — the false-alarm rate that should decide the AI threshold.
    function modelHealth(records, now, n) {
        const since = now - n * DAY;
        const rs = records.filter(r => r.processedAt >= since && r.ai && typeof r.ai.probability === 'number');
        const buckets = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, count: 0, released: 0, falseAlarms: 0 }));
        for (const r of rs) {
            const b = buckets[Math.min(9, Math.floor(r.ai.probability * 10))];
            b.count++; if (r.state === 'released') b.released++; if (r.falseAlarm === true) b.falseAlarms++;
        }
        const byTrigger = Object.keys(TRIGGERS).map(k => {
            const mv = records.filter(r => r.processedAt >= since && isMove(r) && r.trigger === k);
            const rel = mv.filter(r => r.state === 'released').length;
            return { trigger: k, label: TRIGGERS[k], moved: mv.length, released: rel, rate: mv.length ? rel / mv.length : 0 };
        });
        const reviewed = records.filter(r => r.processedAt >= since && r.falseAlarm !== null && r.falseAlarm !== undefined);
        return { buckets, byTrigger, reviewed: reviewed.length, confirmed: reviewed.filter(r => r.falseAlarm === false).length, falseAlarms: reviewed.filter(r => r.falseAlarm === true).length,
                 model: (rs[0] && rs[0].ai.model) || '' };
    }

    return { DAY, dayOf, TRIGGERS, signalCategory, summary, trend, topReasons, campaigns, users, filterRecords, modelHealth };
});
