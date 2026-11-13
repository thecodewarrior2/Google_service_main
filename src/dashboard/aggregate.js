// The dashboard's numbers, from the records and daily counters. Plain functions with no Node or browser
// specifics: the server's API uses them, and so does the clickable mockup (tools/build-mockup.js), so
// the mockup shows exactly what the real dashboard would.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SpruceAggregate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DAY = 24 * 60 * 60 * 1000;
    // Days are the organization's (0.5.27): the calendar day in its time zone (Settings → Policy, TIME_ZONE),
    // not UTC's. In New York an email at 10 PM on the 12th is the 12th's, not the 13th's.
    const fmts = new Map();
    function dayIn(ms, timeZone) {
        const z = timeZone || 'UTC';
        if (z === 'UTC' || z === 'Etc/UTC') return new Date(ms).toISOString().slice(0, 10);
        if (!fmts.has(z)) { let f = null; try { f = new Intl.DateTimeFormat('en-US', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) { /* unknown: UTC */ } fmts.set(z, f); }
        const f = fmts.get(z);
        if (!f) return new Date(ms).toISOString().slice(0, 10);
        const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
        return `${p.year}-${p.month}-${p.day}`;
    }
    let zone = 'UTC';
    // The time zone the dashboard's days are in (the server sets it from the configuration at each request).
    function setTimeZone(timeZone) { zone = timeZone || 'UTC'; }
    const dayOf = (ms) => dayIn(ms, zone);
    // The calendar day k days after day ('YYYY-MM-DD'): calendar arithmetic, the same in any time zone (a day
    // isn't always 24 hours where clocks change).
    function addDays(day, k) { const [y, m, d] = String(day).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10); }
    const days = (now, n) => { const today = dayOf(now); return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1))); };
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
            byTrigger: Object.fromEntries(Object.keys(TRIGGERS).map(k => [k, rs.filter(r => (r.action === 'move' || r.action === 'would-move') && r.trigger === k).length])),
            // (0.5.45) what would move them, apart: monitor mode's answer to "how much do rules + AI add?"
            wouldMoveBy: Object.fromEntries(Object.keys(TRIGGERS).map(k => [k, rs.filter(r => r.action === 'would-move' && (r.trigger || 'rules') === k).length])),
            movedBy: Object.fromEntries(Object.keys(TRIGGERS).map(k => [k, moved.filter(r => (r.trigger || 'rules') === k).length]))
        };
    }

    function trend(records, stats, now, n) {
        const ds = days(now, n);
        // Each day: moved by trigger (rules, ai, rules+ai), would move (monitor mode, or held) by trigger
        // ('wm:rules'…), and both together by trigger ('by:rules'…: the chart's columns, 0.5.45).
        const blank = (d) => Object.assign({ day: d, scanned: 0, wouldMove: 0, flagged: 0, released: 0 },
            ...Object.keys(TRIGGERS).map(t => ({ [t]: 0, [`wm:${t}`]: 0, [`by:${t}`]: 0 })));
        const byDay = Object.fromEntries(ds.map(d => [d, blank(d)]));
        for (const s of stats) if (byDay[s.day]) byDay[s.day].scanned = s.scanned || 0;
        for (const r of records) {
            const d = byDay[dayOf(r.processedAt)];
            if (!d) continue;
            const t = TRIGGERS[r.trigger] ? r.trigger : 'rules';
            if (isMove(r)) { d[t]++; d[`by:${t}`]++; }
            else if (r.action === 'would-move') { d.wouldMove++; d[`wm:${t}`]++; d[`by:${t}`]++; }
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
            if (r.ai && r.ai.probability >= 0.65) cats.add('AI: reads like phishing');   // (policy.js AI_SUSPICIOUS)
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

    // Re-checked mail (0.5.35): emails found to be phishing (or suspicious) after they were delivered, one
    // group per campaign (the same email to many people), newest re-check first. Each group lists every copy
    // the records have: the re-checked ones, and those moved or recorded on arrival.
    const RECHECK_BAD = ['moved', 'would-move', 'held', 'not-in-inbox'];
    function rechecked(records, now, n) {
        const since = now - n * DAY;
        const hit = records.filter(r => r.recheck && r.recheck.at >= since);
        const keys = new Set(hit.map(r => r.campaign));
        const groups = new Map();
        for (const r of records) {
            if (!keys.has(r.campaign)) continue;
            const g = groups.get(r.campaign) || { campaign: r.campaign, label: r.campaignLabel, subject: r.subject, sender: r.sender, copies: [], reasons: new Set(), lastRecheck: 0, firstReceived: Infinity };
            const rc = r.recheck || null, cl = rc && rc.clicks;
            g.copies.push({ key: r.key, user: r.user, receivedAt: r.receivedAt || r.processedAt, rechecked: !!rc, recheckAt: rc ? rc.at : null,
                outcome: rc ? rc.outcome : null, where: rc ? rc.where : null, action: r.action, state: r.state, before: rc ? rc.before : null,
                opened: cl && cl.opened ? true : rc ? !!rc.opened : null, openedAt: cl && cl.openedAt ? cl.openedAt : null,
                clicked: cl ? !!cl.clicked : null, clickedAt: cl && cl.clickedAt ? cl.clickedAt : null, clicksCheckedAt: cl ? cl.checkedAt : null,
                movedAt: rc && rc.movedAt ? rc.movedAt : r.state === 'moved' ? (r.heldMovedAt || r.processedAt) : null, released: r.state === 'released' });
            if (rc) {
                g.reasons.add(rc.source === 'lists' ? `${rc.list || 'A phishing list'} listed ${rc.site || 'one of its sites'}` : 'A second look after it arrived');
                g.lastRecheck = Math.max(g.lastRecheck, rc.at);
            }
            g.firstReceived = Math.min(g.firstReceived, r.receivedAt || r.processedAt);
            groups.set(r.campaign, g);
        }
        return [...groups.values()].map(g => {
            const re = g.copies.filter(c => c.rechecked);
            const count = (f) => g.copies.filter(f).length;
            return { campaign: g.campaign, label: g.label, subject: g.subject, sender: g.sender, reasons: [...g.reasons], lastRecheck: g.lastRecheck, firstReceived: g.firstReceived,
                phishing: re.some(c => RECHECK_BAD.includes(c.outcome)), people: new Set(g.copies.map(c => c.user)).size, rechecked: re.length,
                moved: count(c => c.movedAt), opened: count(c => c.opened), clicked: count(c => c.clicked), clicksChecked: count(c => c.clicksCheckedAt),
                copies: g.copies.sort((a, b) => (b.clicked === true) - (a.clicked === true) || (b.opened === true) - (a.opened === true) || String(a.user).localeCompare(String(b.user))) };
        }).sort((a, b) => b.lastRecheck - a.lastRecheck);
    }
    // The Overview's and Messages' banner: phishing found by a re-check since an admin last marked them seen
    // (at most 7 days back).
    function recheckAlert(records, now, seenAt = 0) {
        const from = Math.max(now - 7 * DAY, Number(seenAt) || 0);
        const rs = records.filter(r => r.recheck && r.recheck.at > from && RECHECK_BAD.includes(r.recheck.outcome));
        if (!rs.length) return null;
        return { emails: rs.length, campaigns: new Set(rs.map(r => r.campaign)).size, people: new Set(rs.map(r => r.user)).size,
            moved: rs.filter(r => r.recheck.outcome === 'moved').length, opened: rs.filter(r => r.recheck.opened || (r.recheck.clicks && r.recheck.clicks.opened)).length,
            clicked: rs.filter(r => r.recheck.clicks && r.recheck.clicks.clicked).length, latest: Math.max(...rs.map(r => r.recheck.at)) };
    }

    // How the AI and the rules are doing: scores of recorded emails, and how often each kind of move
    // was undone (released) — the false-alarm rate that should decide the AI threshold.
    // opts: the settings in force (orgDomains, aiSuspicious, aiThreshold), for "rules and AI together".
    function modelHealth(records, now, n, opts = {}) {
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
        // Which models scored the period's emails, most first (after an upgrade, the old and the new); model:
        // the newest email's (the page shows the model in use, from the server).
        const counts = new Map();
        for (const r of rs) { const m = r.ai.model || 'unknown'; counts.set(m, (counts.get(m) || 0) + 1); }
        const models = [...counts].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
        // Rules and AI together (measured only; nothing is moved for it): emails from outside senders that
        // both scored in between, a rules score from 3 to under 5 and an AI score from the suspicious line to
        // under the move threshold, so neither alone moves them. What admins marked them says whether moving
        // such emails would be worth trying. Inside senders are left out (the AI never moves those): from the
        // record's own verdict, or, for records from before 0.5.7, any address in your domains.
        const own = (d) => (opts.orgDomains || []).some(o => d === o || d.endsWith(`.${o}`));
        const isInside = (r) => (typeof r.inside === 'boolean' ? r.inside : own(String((r.sender && r.sender.domain) || '').toLowerCase()));
        const lo = typeof opts.aiSuspicious === 'number' ? opts.aiSuspicious : 0.65, hi = typeof opts.aiThreshold === 'number' ? opts.aiThreshold : 0.9;
        const zone = rs.filter(r => !isInside(r) && typeof r.score === 'number' && r.score >= 3 && r.score < 5 && r.ai.probability >= lo && r.ai.probability < hi);
        const together = { count: zone.length, phishing: zone.filter(r => r.falseAlarm === false).length, falseAlarms: zone.filter(r => r.falseAlarm === true).length,
                           unreviewed: zone.filter(r => r.falseAlarm !== true && r.falseAlarm !== false).length, ai: [lo, hi], rules: [3, 5] };
        return { buckets, byTrigger, userReleased, reviewed: reviewed.length, confirmed: reviewed.filter(r => r.falseAlarm === false).length, falseAlarms: reviewed.filter(r => r.falseAlarm === true).length,
                 model: (rs[0] && rs[0].ai.model) || '', models, together };
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
            { id: 'falseAlarms', ok: rate !== null && rate <= 0.05, text: rate === null ? 'No reviewed emails yet, so no false-alarm rate.' : `${falseAlarms.length} false alarms among the reviewed (${Math.round(rate * 1000) / 10}%). At most 5% is a good start; Status → Model health shows which kind of move they were.` },
            { id: 'staff', ok: staffUnverified.length === 0, text: staffUnverified.length ? `${staffUnverified.length} emails from a staff address didn't pass DMARC and weren't confirmed as phishing: check they are forged, not your own staff's mail.` : 'No staff address failed DMARC (or each one was confirmed as phishing).' },
            { id: 'brake', ok: peak < ctx.brakeLimit, text: `At most ${peak} emails would have been moved in one hour; the brake stops at ${ctx.brakeLimit}.` },
            { id: 'notifications', ok: quietFor !== null && quietFor < ctx.quietHours * 3600 * 1000, text: quietFor === null ? 'No notification from Gmail yet.' : `Gmail's last notification: ${Math.round(quietFor / 60000)} minutes ago, for ${ctx.watched} watched mailboxes.` },
            { id: 'renew', ok: !!(ctx.renew && ctx.renew.at && !ctx.renew.code), text: ctx.renew && ctx.renew.at ? (ctx.renew.code ? 'The last re-read of the group didn\'t reach the service (Settings → Mailboxes).' : 'The last re-read of the group reached the service.') : 'The group hasn\'t been re-read from the dashboard\'s job yet.' }
        ];
        return { mode: ctx.mode, days: ctx.days, monitorDays, wouldMove: would.length, reviewed: reviewed.length, falseAlarms: falseAlarms.length, falseAlarmRate: rate,
                 strongShare: would.length ? strong / would.length : null, staffUnverified: staffUnverified.length, peakHour: peak, brakeLimit: ctx.brakeLimit,
                 holdAfter: ctx.holdAfter, campaignsOverHold: overHold.slice(0, 5), checks, ready: checks.every(c => c.ok) };
    }

    // Records as CSV, for reports. A cell a spreadsheet would run as a formula is written as text.
    // A spreadsheet cell: never read as a formula (=, +, -, @ first), quoted when needed.
    const csvCell = (v) => {
        let t = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
        return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    // Status → Activity as CSV, for audits (0.5.29): when (UTC), kind, alert, an admin's own action, mailbox, text.
    function activityCsv(events) {
        const cols = ['at_utc', 'kind', 'alert', 'admin_action', 'mailbox', 'text'];
        const rows = events.map(e => [e.at ? new Date(e.at).toISOString() : '', e.kind || '', e.alert && !isAdminAction(e) ? 'yes' : '', isAdminAction(e) ? 'yes' : '', e.user || '', e.text || ''].map(csvCell).join(','));
        return [cols.join(','), ...rows].join('\r\n') + '\r\n';
    }
    function toCsv(records) {
        const cell = csvCell;
        const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
        const cols = [['checked', r => iso(r.processedAt)], ['received', r => iso(r.receivedAt)], ['recipient', r => r.user], ['sender', r => r.sender && r.sender.address],
            ['sender_name', r => r.sender && r.sender.name], ['subject', r => r.subject], ['campaign', r => r.campaignLabel], ['status', r => r.status], ['score', r => r.score],
            ['ai', r => (r.ai && typeof r.ai.probability === 'number' ? Math.round(r.ai.probability * 1000) / 1000 : '')], ['action', r => r.action], ['trigger', r => r.trigger],
            ['evidence', r => r.evidence], ['where', r => r.state], ['released_by', r => r.releasedBy], ['false_alarm', r => (r.falseAlarm === null || r.falseAlarm === undefined ? '' : r.falseAlarm)],
            ['marked_by', r => r.markedBy], ['why', r => r.why], ['message_id', r => r.rfc822MessageId], ['gmail_id', r => r.messageId]];
        return [cols.map(c => c[0]).join(','), ...records.map(r => cols.map(c => cell(c[1](r))).join(','))].join('\r\n') + '\r\n';
    }

    // An admin's own action (0.5.28): a policy change, an update started, a Safe Browsing key saved or removed.
    // Listed under "What admins did", never "Alerts": an alert is a problem the admins are emailed about.
    // (Before 0.5.28 these were also emailed and marked as alerts: told apart by their kind, and an update's by
    // its text.)
    function isAdminAction(e) {
        return !!e && (e.admin === true || e.kind === 'settings' || (e.kind === 'update' && !!e.alert && / started an update from /.test(String(e.text || ''))));
    }
    // Recent activity, by kind: alerts (what needs looking at), what admins did, errors, and the watching of
    // mailboxes. An automatic alert of an admin-related kind (a large campaign, an update that failed) is an
    // alert, not something an admin did.
    const ADMIN_KINDS = ['release', 'resume', 'campaign', 'watch-asked', 'mark', 'check', 'settings', 'digest', 'training', 'clear', 'update'];
    const ACTIVITY = { alert: (e) => !!e.alert && !isAdminAction(e), admin: (e) => isAdminAction(e) || (ADMIN_KINDS.includes(e.kind) && !e.alert),
        error: (e) => e.kind === 'error' || e.kind === 'gap', watch: (e) => ['watch', 'watch-asked', 'mode'].includes(e.kind) };
    function activity(events, kind) { return ACTIVITY[kind] ? events.filter(ACTIVITY[kind]) : events; }

    return { DAY, dayOf, dayIn, addDays, setTimeZone, TRIGGERS, signalCategory, summary, trend, topReasons, campaigns, users, filterRecords, modelHealth, readiness, toCsv, activity, isAdminAction, activityCsv, rechecked, recheckAlert };
});
