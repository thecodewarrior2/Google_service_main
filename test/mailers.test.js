'use strict';
// 0.5.18: a newsletter's link whose text shows a well-known site (open.spotify.com) but which goes through
// its mail service's click tracker (link.mail.beehiiv.com/v2/c/…) gets a reputation check before it is
// called dangerous: a known marketing mail service that the lookups find nothing against, and whose domain
// isn't new, makes it a warning (1), never enough to move the email alone. Anything else stays dangerous.
// Every sender, address and text here is made up.
const test = require('node:test');
const assert = require('node:assert');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const { decide } = require('../src/policy');
const { loadConfig } = require('../src/config');
const { mailerOf, mismatchHost } = require('../src/engine/mailers');
const spruce = require('../src/engine/spruce');

const ORG = 'maple-schools.example', USER = `sam.okafor@${ORG}`;
const E = spruce.load();
const TRACKED = 'https://link.mail.beehiiv.com/v2/c/8fc57a42b025b2bb544dbdbdd47c18a0e2f4829e1f61c342ee37686df9c2a4e0063e3b3143eb1aae2688e3fc757bc6928c8fe2c855edc5';
const newsletter = ({ href = TRACKED, text = 'open.spotify.com', body = 'This week\'s episode is out.', extra = '' } = {}) => Buffer.from(['From: "Tech Leaders Podcast" <podcast@mail.techleaders-podcast.example>',
    `To: ${USER}`, 'Subject: New episode: zero trust in K-12', 'Message-ID: <b1@mail.beehiiv.com>',
    'Authentication-Results: mx.google.com; dkim=pass header.i=@mail.beehiiv.com; spf=pass; dmarc=pass (p=NONE) header.from=mail.techleaders-podcast.example',
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

test('the mail services and the finding they apply to', () => {
    assert.equal(mailerOf('link.mail.beehiiv.com', E.registrableDomain), 'beehiiv');
    assert.equal(mailerOf('substack.com', E.registrableDomain), 'Substack');
    assert.equal(mailerOf('beehiiv.com.evil.example', E.registrableDomain), null, 'only the service\'s own domain');
    assert.equal(mailerOf('beehiiv-login.example', E.registrableDomain), null);
    assert.equal(mismatchHost('link text shows open.spotify.com (a well-known brand) but the link goes to link.mail.beehiiv.com'), 'link.mail.beehiiv.com');
    assert.equal(mismatchHost('look-alike domain: paypa1.example imitates paypal.com'), null);
});

test('a reputable mail service\'s click tracker behind a brand\'s text: a warning, not moved', async () => {
    const r = await judge(newsletter(), intelOf());
    const link = r.links.find(l => /beehiiv/.test(l.url));
    assert.equal(link.severity, 'caution');
    assert.match(link.reason, /^link text shows open\.spotify\.com \(a well-known brand\) but the link goes to link\.mail\.beehiiv\.com, beehiiv's click tracker \(a marketing mail service: not blocked or listed as phishing, registered 6 years ago\); where it leads isn't known until it's clicked$/);
    const sign = r.signals.find(s => s.kind === 'mailer-link');
    assert.equal(sign.weight, 1);
    assert.match(sign.text, /^A link shows open\.spotify\.com but goes through beehiiv's click tracker \(link\.mail\.beehiiv\.com\), a marketing mail service with a clean reputation/);
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
    // Not a mail service: an unknown site behind a brand's text stays dangerous, however clean.
    assert.equal(await dangerous(intelOf(), newsletter({ href: 'https://redirect.unknown-site.example/x?id=1' })), 'danger');
    // A warning plus more: a sign-in lure and a hidden form, and it adds up as before.
    const more = await judge(newsletter({ text: 'open.spotify.com', body: 'Your subscription is on hold. Enter your password to keep listening, and update your direct deposit information for payroll today.' }), intelOf());
    assert.ok(more.signals.some(s => s.kind === 'mailer-link'));
    assert.ok(more.score > (await judge(newsletter(), intelOf())).score, 'other signs still count on top of the warning');
});
