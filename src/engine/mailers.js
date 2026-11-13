'use strict';
// Marketing mail services' own click-tracking domains (0.5.18): a newsletter's link whose text shows a brand's
// site (open.spotify.com) goes through the service that sent it (link.mail.beehiiv.com/v2/c/…), which records
// the click and then sends the reader on. Where it ends isn't in the link: following it would click it as the
// reader. These domains are the services' own, registered for years; the engine's built-in click trackers
// (vendor/spruce/shared.js espTrackers: Mailchimp, SendGrid, Klaviyo…) are never even counted as mismatched,
// so this list holds the others. A link through one of them is only a warning, and only when the reputation
// lookups find nothing against the domain and it isn't new (network.js); otherwise it is judged as before.
// Kept to the services' click and redirect domains (a registrable domain each), with the service's name.
const MARKETING_MAILERS = new Map(Object.entries({
    'beehiiv.com': 'beehiiv',
    'substack.com': 'Substack',
    'mailerlite.com': 'MailerLite', 'mlsend.com': 'MailerLite', 'mlsend2.com': 'MailerLite',
    'hubspotlinks.com': 'HubSpot',
    'mjt.lu': 'Mailjet',
    'createsend.com': 'Campaign Monitor', 'createsend1.com': 'Campaign Monitor', 'cmail19.com': 'Campaign Monitor', 'cmail20.com': 'Campaign Monitor',
    'gr8.com': 'GetResponse',
    'eomail1.com': 'EmailOctopus', 'eomail4.com': 'EmailOctopus',
    'customeriomail.com': 'Customer.io',
    'e2ma.net': 'Emma',
    'bmetrack.com': 'Benchmark Email',
    'maillist-manage.com': 'Zoho Campaigns', 'maillist-manage.net': 'Zoho Campaigns'
}));
// (Not here: platforms where anyone can publish pages, such as site builders: a mail service's click
// tracker only forwards to the sender's link.)

// The mail service whose click tracker a host is ('beehiiv'), or null. registrableDomain: the engine's.
function mailerOf(host, registrableDomain) {
    const h = String(host || '').toLowerCase();
    const reg = registrableDomain ? registrableDomain(h) : h;
    return MARKETING_MAILERS.get(reg) || null;
}

// A "link text shows another site" finding: the link's host, or null.
const MISMATCH_RE = /^link text shows \S+(?: \(a well-known brand\))? but the link goes to ([^\s;,)]+)$/;
function mismatchHost(reason) { const m = MISMATCH_RE.exec(String(reason || '')); return m ? m[1].toLowerCase() : null; }

// Not new: a mail service's domain registered at least this long ago (a new look-alike of one is not it).
const MAILER_MIN_AGE_DAYS = 180;

module.exports = { MARKETING_MAILERS, mailerOf, mismatchHost, MAILER_MIN_AGE_DAYS };
