'use strict';
// 0.5.18/0.5.19: a newsletter's link whose text shows a well-known site (open.spotify.com) but which goes
// through the click tracker of the mail service that sent it (link.mail.beehiiv.com/v2/c/…) gets a
// reputation check before it is called dangerous. The sending service is the third party whose DKIM
// signature Gmail verified (no list); when the lookups find nothing against its domain and it isn't new,
// the link is a warning (1), never enough to move the email alone. Anything else stays dangerous.
// Every sender, address and text here is made up.
const test = require('node:test');
const assert = require('node:assert');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const { decide } = require('../src/policy');
const { loadConfig } = require('../src/config');
const { sendingService, mismatchHost } = require('../src/engine/mailers');
const spruce = require('../src/engine/spruce');

const ORG = 'maple-schools.example', USER = `sam.okafor@${ORG}`;
const E = spruce.load();
const TRACKED = 'https://link.mail.beehiiv.com/v2/c/8fc57a42b025b2bb544dbdbdd47c18a0e2f4829e1f61c342ee37686df9c2a4e0063e3b3143eb1aae2688e3fc757bc6928c8fe2c855edc5';
const BEEHIIV = 'Authentication-Results: mx.google.com; dkim=pass header.i=@mail.beehiiv.com header.s=s1; spf=pass; dmarc=pass (p=NONE) header.from=mail.techleaders-podcast.example';
const newsletter = ({ href = TRACKED, text = 'open.spotify.com', body = 'This week\'s episode is out.', extra = '', from = 'podcast@mail.techleaders-podcast.example', auth = BEEHIIV } = {}) => Buffer.from([`From: "Tech Leaders Podcast" <${from}>`,
    `To: ${USER}`, 'Subject: New episode: zero trust in K-12', 'Message-ID: <b1@mail.beehiiv.com>', auth,
    'Content-Type: text/html; charset=utf-8', '', `<p>${body}</p><p>Listen on <a href="${href}">${text}</a></p>${extra}`].join('\r\n'));
// The lookups, made up: Cloudflare's verdict per host, the phishing lists, the registry's age.
const intelOf = ({ blocked = [], down = false, listed = [], ages = { 'beehiiv.com': 2200 } } = {}) => ({
    threats: { enabled: { safeBrowsing: false },
        checkHosts: async (hosts) => new Map(hosts.map(h => [h, down ? { verdict: 'unknown', by: 'Cloudflare Security' }
            : blocked.some(b => h === b || h.endsWith(`.${b}`)) ? { verdict: 'unsafe', by: 'Cloudflare Security', reason: 'Cloudflare Security blocks it as malware or phishing' } : { verdict: 'clean', by: 'Cloudflare Security' }])),
        checkUrls: async () => new Map() },
    feeds: { urlHit: async (u) => (listed.some(l => u.includes(l)) ? 'OpenPhish community feed' : null), addressHit: async () => null, domainHit: async () => null },
    rdap: { ageDays: async (d) => (d in ages ? ages[d] : null) }
});
const judge = async (raw, intel) => analyze(await readMessage(raw), { mailbox: USER, orgDomains: [ORG], intel });
const enforce = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER, MODE: 'enforce' });

test('the sending service: the third party whose signature Gmail verified, by the link\'s domain', () => {
    const facts = (dkimDomains, sender = 'podcast@mail.techleaders-podcast.example') => ({ senderAddress: sender, auth: { dmarc: 'pass', dkimDomains } });
    assert.deepEqual(sendingService('link.mail.beehiiv.com', facts(['mail.beehiiv.com']), E.registrableDomain), { domain: 'beehiiv.com' });
    assert.equal(sendingService('link.mail.beehiiv.com', facts(['techleaders-podcast.example']), E.registrableDomain), null, 'not signed by it');
    assert.equal(sendingService('link.mail.beehiiv.com', facts([]), E.registrableDomain), null);
    assert.equal(sendingService('beehiiv.com.evil.example', facts(['mail.beehiiv.com']), E.registrableDomain), null, 'only the signer\'s own domain');
    assert.equal(sendingService('login.paypa1-secure.example', facts(['paypa1-secure.example'], 'service@paypa1-secure.example'), E.registrableDomain), null, 'the sender\'s own domain is no third party');
    assert.equal(mismatchHost('link text shows open.spotify.com (a well-known brand) but the link goes to link.mail.beehiiv.com'), 'link.mail.beehiiv.com');
    assert.equal(mismatchHost('look-alike domain: paypa1.example imitates paypal.com'), null);
});

test('a reputable mail service\'s click tracker behind a brand\'s text: a warning, not moved', async () => {
    const r = await judge(newsletter(), intelOf());
    const link = r.links.find(l => /beehiiv/.test(l.url));
    assert.equal(link.severity, 'caution');
    assert.match(link.reason, /^link text shows open\.spotify\.com \(a well-known brand\) but the link goes to link\.mail\.beehiiv\.com, the click tracker of beehiiv\.com, the mail service that sent this email \(its signature checked by Gmail; not blocked or listed as phishing, registered 6 years ago\); where it leads isn't known until it's clicked$/);
    const sign = r.signals.find(s => s.kind === 'mailer-link');
    assert.equal(sign.weight, 1);
    assert.match(sign.text, /^A link shows open\.spotify\.com but goes through the click tracker of beehiiv\.com \(link\.mail\.beehiiv\.com\), the mail service that sent this email, with a clean reputation/);
    assert.ok(!r.signals.some(s => s.kind === 'dangerous-links'));
    assert.notEqual(decide(r, enforce, {}).action, 'move');
    assert.ok(r.score < 3, `${r.score}: not even suspicious on its own`);
});

test('low reputation or unknown reputation: still dangerous; other signs still add up', async () => {
    const dangerous = async (intel, raw = newsletter()) => (await judge(raw, intel)).links.find(l => /beehiiv|example/.test(l.url)).severity;
    assert.equal(await dangerous(intelOf({ blocked: ['beehiiv.com'] })), 'danger', 'blocked by Cloudflare');
    assert.equal(await dangerous(intelOf({ listed: ['beehiiv.com/v2/c/8fc57a42'] })), 'danger', 'on a phishing list');
    assert.equal(await dangerous(intelOf({ down: true })), 'danger', 'the lookup didn\'t answer: not checked, so not softened');
    assert.equal(await dangerous(intelOf({ ages: { 'beehiiv.com': 40 } })), 'danger', 'a domain registered recently is no established mail service');
    assert.equal(await dangerous(null), 'danger', 'no lookups at all');
    // Not the service that sent it: an unknown site behind a brand's text stays dangerous, however clean;
    // so does a link to beehiiv in an email beehiiv didn't sign, and a scammer's own domain signing its own mail.
    assert.equal(await dangerous(intelOf(), newsletter({ href: 'https://redirect.unknown-site.example/x?id=1' })), 'danger');
    assert.equal(await dangerous(intelOf(), newsletter({ auth: 'Authentication-Results: mx.google.com; dkim=pass header.i=@mail.techleaders-podcast.example; spf=pass; dmarc=pass header.from=mail.techleaders-podcast.example' })), 'danger');
    assert.equal(await dangerous(intelOf({ ages: { 'paypa1-secure.example': 3000 } }), newsletter({ from: 'service@paypa1-secure.example', href: 'https://login.paypa1-secure.example/x', text: 'www.paypal.com',
        auth: 'Authentication-Results: mx.google.com; dkim=pass header.i=@paypa1-secure.example; spf=pass; dmarc=pass header.from=paypa1-secure.example' })), 'danger');
    // A warning plus more: a sign-in lure and a hidden form, and it adds up as before.
    const more = await judge(newsletter({ text: 'open.spotify.com', body: 'Your subscription is on hold. Enter your password to keep listening, and update your direct deposit information for payroll today.' }), intelOf());
    assert.ok(more.signals.some(s => s.kind === 'mailer-link'));
    assert.ok(more.score > (await judge(newsletter(), intelOf())).score, 'other signs still count on top of the warning');
});
