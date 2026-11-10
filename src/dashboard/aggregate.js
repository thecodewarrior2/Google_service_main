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
    const TRIGGERS = { rules: 'Rules', ai: 'AI score', 'rules+ai': 'Rules + AI', admin: 'An admin (campaign)' };

    // What a signal is about, for "top reasons" (the extension's sign texts, grouped).
    function signalCategory(s) {
        const k = s.kind || '', t = String(s.text || '');
        if (k === 'dangerous-links' || /links? (is|are) flagged as dangerous/.test(t)) return 'Dangerous links';
        if (k === 'scam-sender-list' || k === 'sender-domain-blocked' || k === 'sender-domain-listed') return 'Sender on a threat list';
        if (k === 'young-sender-domain' || k === 'young-link-domain' || k === 'young-lookalike-sender') return 'Brand-new site or domain';
        if (k === 'sender-domain-missing') return 'Made-up sender domain';
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
        const userReleased = released.filter(r => r.releasedByUser);
        const users = new Set(rs.filter(r => r.action !== 'flag').map(r => r.user));
        const camps = new Set(moved.map(r => r.campaign));
        return {
            days: n, scanned: sum('scanned'), moved: moved.length, wouldMove: rs.filter(r => r.action === 'would-move').length,
            flagged: rs.filter(r => r.action === 'flag').length, released: released.length, userReleased: userReleased.length,
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
            && (!text || `${r.user} ${r.sender.address} ${r.sender.name} ${r.subject} ${r.rfc822MessageId || ''} ${r.messageId || ''}`.toLowerCase().includes(text)));
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
            const byUser = mv.filter(r => r.state === 'released' && r.releasedByUser).length;
            return { trigger: k, label: TRIGGERS[k], moved: mv.length, released: rel, byUser, rate: mv.length ? rel / mv.length : 0 };
        });
        const reviewed = records.filter(r => r.processedAt >= since && r.falseAlarm !== null && r.falseAlarm !== undefined);
        const userReleased = records.filter(r => r.processedAt >= since && r.releasedByUser).length;
        return { buckets, byTrigger, userReleased, reviewed: reviewed.length, confirmed: reviewed.filter(r => r.falseAlarm === false).length, falseAlarms: reviewed.filter(r => r.falseAlarm === true).length,
                 model: (rs[0] && rs[0].ai.model) || '' };
    }

    // "Ready for enforce mode?": what monitor mode has shown, as checks. ctx: { now, days, mode,
    // installedAt, brakeLimit, holdAfter, watched, lastNotification, quietHours, renew: { at, code } }.
    function readiness(records, ctx) {
        const since = ctx.now - ctx.days * DAY;
        const rs = records.filter(r => r.processedAt >= since && r.trigger !== 'admin');
        const would = rs.filter(r => r.action === 'would-move' || r.action === 'move');
        const reviewed = would.filter(r => r.markedBy && r.falseAlarm !== null && r.falseAlarm !== undefined);
        const falseAlarms = reviewed.filter(r => r.falseAlarm === true);
        const staffUnverified = rs.filter(r => r.ownAddressUnverified && r.falseAlarm !== false);
        const perHour = {};
        for (const r of would) { const h = new Date(r.processedAt).toISOString().slice(0, 13); perHour[h] = (perHour[h] || 0) + 1; }
        const peak = Math.max(0, ...Object.values(perHour));
        const weakByCampaign = {};
        for (const r of would) if (r.evidence !== 'strong') { const c = weakByCampaign[r.campaign] || (weakByCampaign[r.campaign] = { campaign: r.campaign, label: r.campaignLabel, count: 0 }); c.count++; }
        const overHold = Object.values(weakByCampaign).filter(c => c.count > ctx.holdAfter).sort((a, b) => b.count - a.count);
        const strong = would.filter(r => r.evidence === 'strong').length;
        const monitorDays = ctx.installedAt ? Math.floor((ctx.now - ctx.installedAt) / DAY) : 0;
        const rate = reviewed.length ? falseAlarms.length / reviewed.length : null;
        const quietFor = ctx.lastNotification ? ctx.now - ctx.lastNotification : null;
        const checks = [
            { id: 'time', ok: monitorDays >= 14, text: `${monitorDays} days since the install (two weeks or more is enough to see a range of mail).` },
            { id: 'reviewed', ok: would.length > 0 && reviewed.length >= Math.min(50, Math.ceil(would.length * 0.8)),
              text: would.length ? `${reviewed.length} of ${would.length} "would move" emails reviewed (Mark false alarm or Confirm phishing). Review at least 80% of them, or 50.` : 'No email would have been moved yet: wait for more mail, or send the test email (docs/INSTALL.md, step 6).' },
            { id: 'falseAlarms', ok: rate !== null && rate <= 0.05, text: rate === null ? 'No reviewed emails yet, so no false-alarm rate.' : `${falseAlarms.length} false alarms among the reviewed (${Math.round(rate * 1000) / 10}%). At most 5% is a good start; Model health shows which kind of move they were.` },
            { id: 'staff', ok: staffUnverified.length === 0, text: staffUnverified.length ? `${staffUnverified.length} emails from a staff address didn't pass DMARC and weren't confirmed as phishing: check they are forged, not your own staff's mail.` : 'No staff address failed DMARC (or each one was confirmed as phishing).' },
            { id: 'brake', ok: peak < ctx.brakeLimit, text: `At most ${peak} emails would have been moved in one hour; the brake stops at ${ctx.brakeLimit}.` },
            { id: 'notifications', ok: quietFor !== null && quietFor < ctx.quietHours * 3600 * 1000, text: quietFor === null ? 'No notification from Gmail yet.' : `Gmail's last notification: ${Math.round(quietFor / 60000)} minutes ago, for ${ctx.watched} watched mailboxes.` },
            { id: 'renew', ok: !!(ctx.renew && ctx.renew.at && !ctx.renew.code), text: ctx.renew && ctx.renew.at ? (ctx.renew.code ? 'The last re-read of the group didn\'t reach the service (Settings → Mailboxes watched).' : 'The last re-read of the group reached the service.') : 'The group hasn\'t been re-read from the dashboard\'s job yet.' }
        ];
        return { mode: ctx.mode, days: ctx.days, monitorDays, wouldMove: would.length, reviewed: reviewed.length, falseAlarms: falseAlarms.length, falseAlarmRate: rate,
                 strongShare: would.length ? strong / would.length : null, staffUnverified: staffUnverified.length, peakHour: peak, brakeLimit: ctx.brakeLimit,
                 holdAfter: ctx.holdAfter, campaignsOverHold: overHold.slice(0, 5), checks, ready: checks.every(c => c.ok) };
    }

    // Records as CSV, for reports. A cell a spreadsheet would run as a formula is written as text.
    function toCsv(records) {
        const cell = (v) => {
            let t = v === null || v === undefined ? '' : String(v);
            if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
            return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
        };
        const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
        const cols = [['checked', r => iso(r.processedAt)], ['received', r => iso(r.receivedAt)], ['recipient', r => r.user], ['sender', r => r.sender && r.sender.address],
            ['sender_name', r => r.sender && r.sender.name], ['subject', r => r.subject], ['campaign', r => r.campaignLabel], ['status', r => r.status], ['score', r => r.score],
            ['ai', r => (r.ai && typeof r.ai.probability === 'number' ? Math.round(r.ai.probability * 1000) / 1000 : '')], ['action', r => r.action], ['trigger', r => r.trigger],
            ['evidence', r => r.evidence], ['where', r => r.state], ['released_by', r => r.releasedBy], ['false_alarm', r => (r.falseAlarm === null || r.falseAlarm === undefined ? '' : r.falseAlarm)],
            ['marked_by', r => r.markedBy], ['why', r => r.why], ['message_id', r => r.rfc822MessageId], ['gmail_id', r => r.messageId]];
        return [cols.map(c => c[0]).join(','), ...records.map(r => cols.map(c => cell(c[1](r))).join(','))].join('\r\n') + '\r\n';
    }

    // Recent activity, by kind: alerts, what admins did, errors, and the watching of mailboxes.
    const ACTIVITY = { alert: (e) => !!e.alert, admin: (e) => ['release', 'resume', 'campaign', 'watch-asked', 'mark', 'check', 'settings', 'digest', 'training', 'clear'].includes(e.kind), error: (e) => e.kind === 'error' || e.kind === 'gap', watch: (e) => ['watch', 'watch-asked', 'mode'].includes(e.kind) };
    function activity(events, kind) { return ACTIVITY[kind] ? events.filter(ACTIVITY[kind]) : events; }

    return { DAY, dayOf, TRIGGERS, signalCategory, summary, trend, topReasons, campaigns, users, filterRecords, modelHealth, readiness, toCsv, activity };
});
