'use strict';
// A fake reply chain (0.5.33): an email whose subject says it is a reply ("RE: Invoice 4471"), from outside
// the organization or from a sender never seen before, that isn't a reply to anything this mailbox has. A
// common invoice and payroll trick: the "RE:" makes it look like an ongoing conversation. Counted in the
// rules' score (2: with a first-time outside sender it is amber; with anything more, flagged).
//
// Two ways to tell, the headers first (no Gmail call): a real reply names the email it answers
// (In-Reply-To, References). One that names nothing is made up. One that names an earlier email is checked
// against the mailbox: Gmail puts a reply in the same conversation (thread) as the email it answers, so a
// thread holding only this email means the mailbox never had the earlier one (threadSize, from the pipeline;
// null when unknown, as for "Check an email").

// "RE:", and the same in other languages ("AW:", "SV:", "Antw:", "RIF:", "RES:"), possibly after "[EXTERNAL]".
const REPLY_RE = /^\s*(?:\[[^\]]{1,30}\]\s*)?(?:re|aw|sv|antw|rif|res|odp|vs)\s*(?:\[\d+\])?\s*:/i;

function looksLikeReply(subject) { return REPLY_RE.test(String(subject || '')); }

// facts: mime.readMessage's (subject, inReplyTo, references); ctx: { threadSize, outside, firstTime }.
function fakeReplySigns(facts, { threadSize = null, outside = true, firstTime = false } = {}) {
    if (!looksLikeReply(facts && facts.subject) || !(outside || firstTime)) return [];
    const names = [].concat(facts.inReplyTo || [], facts.references || []).map(x => String(x || '').trim()).filter(Boolean);
    if (!names.length) {
        return [{ weight: 2, kind: 'fake-reply', text: 'Its subject says it is a reply ("RE:"), but it doesn\'t answer any email: none is named in its headers. A made-up conversation is a common invoice and payroll trick.' }];
    }
    if (threadSize === 1) {
        return [{ weight: 2, kind: 'fake-reply', text: 'Its subject says it is a reply ("RE:"), but this mailbox has no earlier email in that conversation. A made-up conversation is a common invoice and payroll trick.' }];
    }
    return [];
}

module.exports = { fakeReplySigns, looksLikeReply, REPLY_RE };
