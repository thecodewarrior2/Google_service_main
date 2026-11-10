'use strict';
// The weekly summary email (Settings in the dashboard; off by default). It is put straight into each
// admin's Inbox with the Gmail API (messages.insert, allowed by the gmail.modify scope the service
// already has): no mailbox sends it, nothing leaves Google, and no new permission is needed. The service
// never judges its own summaries (isSummary). Times are in TIME_ZONE.
const A = require('./dashboard/aggregate');

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// The local date and hour in a time zone, and its ISO week ("2026-W46"): the summary goes out once a
// week, on Monday from 7 AM.
function localParts(ms, timeZone = 'UTC') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
        .formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day), weekday = WEEKDAYS[parts.weekday];
    // ISO week: the week with the year's first Thursday is week 1.
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + 4 - weekday);
    const isoYear = d.getUTCFullYear();
    const week = Math.ceil(((d - Date.UTC(isoYear, 0, 1)) / DAY + 1) / 7);
    return { year, month, day, hour: Number(parts.hour) % 24, weekday, week: `${isoYear}-W${String(week).padStart(2, '0')}` };
}
const dateIn = (ms, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(ms));
const n = (x) => new Intl.NumberFormat('en-US').format(Math.round(x || 0));
const plural = (k, one, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

// The summary of the last 7 days: { subject, text }. ctx: { now, mode, timeZone, dashboardUrl, watched,
// held (campaigns waiting), brake (bool), readiness (A.readiness, monitor mode) }.
function buildDigest(records, stats, events, ctx) {
    const now = ctx.now, from = now - 7 * DAY;
    const s = A.summary(records, stats, now, 7);
    const week = records.filter(r => r.processedAt >= from && r.trigger !== 'admin');
    const unreviewed = week.filter(r => (r.action === 'move' || r.action === 'would-move') && !r.markedBy).length;
    const strong = week.filter(r => (r.action === 'move' || r.action === 'would-move') && r.evidence === 'strong').length;
    const top = A.campaigns(records, now, 7).slice(0, 5);
    const alerts = events.filter(e => e.alert && e.at >= from).length;
    const period = `${dateIn(from, ctx.timeZone)} to ${dateIn(now, ctx.timeZone)}`;
    const enforce = ctx.mode === 'enforce';
    const subject = `S.P.R.U.C.E+ weekly summary: ${enforce ? `${n(s.moved)} moved to Spam` : `${n(s.wouldMove)} would be moved`}, ${period}`;
    const waiting = [ctx.brake ? 'the domain-wide brake is ON (moving is paused)' : '', ctx.held ? plural(ctx.held, 'campaign') + ' held for your decision' : '',
        unreviewed ? `${n(unreviewed)} emails not reviewed yet (Review in the dashboard)` : ''].filter(Boolean);
    const lines = [
        `S.P.R.U.C.E+ Mail Protection: ${period} (${enforce ? 'enforce mode' : 'monitor mode: nothing is moved'})`,
        '',
        `Checked: ${plural(s.scanned, 'email')}, in ${plural(ctx.watched, 'watched mailbox', 'watched mailboxes')}.`,
        `Moved to Spam: ${n(s.moved)}. Recorded as "would move" (monitor mode, or held by a brake): ${n(s.wouldMove)}. On strong evidence: ${n(strong)} of these ${n(s.moved + s.wouldMove)}.`,
        `Suspicious only (not moved): ${n(s.flagged)}.`,
        enforce ? `Moved back to the Inbox: ${n(s.released)} (${n(s.userReleased || 0)} by users themselves).` : null,
        `Marked as false alarms: ${n(s.falseAlarms)}.`,
        `Alerts: ${n(alerts)} (Activity in the dashboard).`,
        '',
        waiting.length ? `Waiting for you: ${waiting.join('; ')}.` : 'Nothing is waiting for you.',
        top.length ? ['', 'Largest campaigns:', ...top.map(c => `  - ${c.label} (${plural(c.messages, 'copy', 'copies')}, ${n(c.moved)} moved)`)] : null,
        !enforce && ctx.readiness ? ['', `Ready for enforce mode? ${ctx.readiness.checks.filter(c => c.ok).length} of ${ctx.readiness.checks.length} checks are green${ctx.readiness.ready ? ': ready.' : '.'}`] : null,
        '',
        ctx.dashboardUrl ? `The dashboard: ${ctx.dashboardUrl}` : null,
        'You get this because the weekly summary is on (Settings in the dashboard), for its admins. Turn it off there.'
    ].flat().filter(x => x !== null);
    return { subject, text: lines.join('\n') + '\n' };
}

// An RFC 822 message for messages.insert: plain text, UTF-8. X-SPRUCE-Summary marks it as the service's.
function mime({ from, to, subject, text, date, messageId }) {
    const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
    const head = [`From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, `Date: ${date.toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${messageId}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'X-SPRUCE-Summary: weekly'];
    const body = Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
    return Buffer.from(`${head.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8');
}

// The service's own summary: it carries X-SPRUCE-Summary and has no Received header (it was inserted,
// not delivered). Mail from outside always has Received headers, so the header alone can't let any
// through unchecked.
function isSummary(raw) {
    const text = Buffer.isBuffer(raw) ? raw.subarray(0, 64 * 1024).toString('utf8') : String(raw || '').slice(0, 64 * 1024);
    const end = text.search(/\r?\n\r?\n/);
    const head = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, ' ');
    return /^x-spruce-summary:/im.test(head) && !/^received:/im.test(head);
}

module.exports = { buildDigest, mime, isSummary, localParts };
