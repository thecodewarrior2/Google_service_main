'use strict';
// A newsletter's link through the mail service that sent it (0.5.19; 0.5.18 used a hand-kept list of
// services, which this replaces). A link whose text shows a brand's site (open.spotify.com) can go through
// the sending service's click tracker (link.mail.beehiiv.com/v2/c/…), which records the click and sends the
// reader on; where it ends isn't in the link, and following it would click it as the reader. The sending
// service is known without any list: the receiver (Gmail) verified its DKIM signature on the email, and it is
// a third party, not the sender's own domain. A link through it is a warning, and only when the reputation
// lookups find nothing against that domain and it isn't new (network.js); otherwise it is judged as before.

// The service that sent the email, if the link's host is one: { domain } or null.
//   facts.auth.dkimDomains: the domains whose DKIM signature the receiver verified (mime.receiverAuth);
//   registrableDomain: the engine's.
function sendingService(host, facts, registrableDomain) {
    const reg = registrableDomain(String(host || '').toLowerCase());
    const auth = (facts && facts.auth) || {};
    const from = registrableDomain(String((facts && facts.senderAddress) || '').toLowerCase().split('@')[1] || '');
    if (!reg || !from || reg === from) return null;                   // the sender's own domain: no third party
    const signers = (auth.dkimDomains || []).map(d => registrableDomain(d)).filter(Boolean);
    return signers.includes(reg) ? { domain: reg } : null;
}

// A "link text shows another site" finding: the link's host, or null.
const MISMATCH_RE = /^link text shows \S+(?: \(a well-known brand\))? but the link goes to ([^\s;,)]+)$/;
function mismatchHost(reason) { const m = MISMATCH_RE.exec(String(reason || '')); return m ? m[1].toLowerCase() : null; }

// Not new: the service's domain registered at least this long ago (a brand-new sender's own setup is not one).
const MAILER_MIN_AGE_DAYS = 180;

module.exports = { sendingService, mismatchHost, MAILER_MIN_AGE_DAYS };
