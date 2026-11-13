'use strict';
// 0.5.16: email a platform sends for a person (Google Classroom, a Drive share, DocuSign…) is judged by the
// person's own address, never by the platform's: a colleague's own share or Classroom post is no longer
// "a colleague's name on an outside address"; an outside account under a colleague's name is flagged; an
// outside share whose text names a colleague, asks to sign in, or reaches many people at once adds up.
// Every address, name and text here is made up (maple-schools.example; lakeside-isd.example is another).
const test = require('node:test');
const assert = require('node:assert');
const { readMessage } = require('../src/engine/mime');
const { analyze, platformNotification } = require('../src/engine/analyze');
const N = require('../src/engine/notifications');
const { decide } = require('../src/policy');
const { loadConfig } = require('../src/config');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const spruce = require('../src/engine/spruce');

const ORG = 'maple-schools.example', USER = `sam.okafor@${ORG}`, OTHER = 'lakeside-isd.example';
const E = spruce.load();
const colleagues = new Set(['Dana Morales', 'Sam Okafor', 'Jordan Rivera'].map(n => E.colleagueNameHash(n)));
const GOOGLE = 'Authentication-Results: mx.google.com; dkim=pass header.i=@google.com; spf=pass; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=google.com; dara=neutral header.i=@maple-schools.example';
const DOCUSIGN = 'Authentication-Results: mx.google.com; dkim=pass header.i=@docusign.net; spf=pass; dmarc=pass (p=REJECT) header.from=docusign.net';
const mail = (head, html) => Buffer.from([...head, 'Content-Type: text/html; charset=utf-8', '', html].join('\r\n'));
const driveShare = ({ name, replyTo, note, title = 'Field trip permission slips' }) => mail([
    `From: "${name} (via Google Docs)" <drive-shares-dm-noreply@google.com>`, ...(replyTo ? [`Reply-To: "${name}" <${replyTo}>`] : []), `To: ${USER}`,
    `Subject: Document shared with you: "${title}"`, 'Message-ID: <s1@docs-share.google.com>', GOOGLE],
    `<p>${name} shared a document</p><p>${name} (${replyTo || 'someone'}) has invited you to view the following document:</p>${note ? `<blockquote>${note}</blockquote>` : ''}<p><a href="https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit">Open</a></p>`);
const judge = async (raw, ctx = {}) => analyze(await readMessage(raw), Object.assign({ mailbox: USER, orgDomains: [ORG], colleagues }, ctx));
const kinds = (r) => r.signals.map(s => [s.kind || s.text.slice(0, 30), s.weight]);
const enforce = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER, MODE: 'enforce' });

test('a colleague\'s own Classroom post or Drive share (inside): no colleague-name or outside mark, never moved', async () => {
    // Shaped like a real Classroom notification: the teacher's name, Google's address, no Reply-To, "[EXTERNAL]".
    const classroom = await judge(mail(['From: "Jordan Rivera (Classroom)" <no-reply@classroom.google.com>', `To: ${USER}`, 'Subject: [EXTERNAL] New assignment: "Unit 3 Review"',
        'Message-ID: <c1@notifications.google.com>', 'X-Notifications: NEW_ASSIGNMENT:1:2-3', GOOGLE],
        '<p>Jordan Rivera posted a new assignment in Biology 1</p><p><a href="https://classroom.google.com/c/MTIz/a/NDU2/details">Open</a></p>'), { firstTime: true });
    assert.deepEqual(kinds(classroom), [], 'the teacher is unknown from the email: nothing from the name, no "outside", no "first email"');
    assert.equal(classroom.status, 'clean');
    const relay = platformNotification(await readMessage(driveShare({ name: 'Dana Morales', replyTo: `dana.morales@${ORG}` })), [ORG]);
    assert.deepEqual([relay.platform, relay.via, relay.name, relay.address, relay.inside], ['Google', 'Google Docs', 'Dana Morales', `dana.morales@${ORG}`, true]);
    const share = await judge(driveShare({ name: 'Dana Morales', replyTo: `dana.morales@${ORG}`, note: 'Here are the permission slips for Friday.' }), { firstTime: true });
    assert.deepEqual(kinds(share), []);
    assert.equal(decide(share, enforce, {}).action, 'none');
});

test('an outside account under a colleague\'s name: at another organization flagged and moved; at a personal provider amber', async () => {
    const r = await judge(driveShare({ name: 'Dana Morales', replyTo: `dana.morales.office@${OTHER}`, title: 'Staff Bonus Schedule' }), { firstTime: true });
    assert.deepEqual(kinds(r).filter(([k]) => /relay|outside-org|first-time/.test(k)), [['relay-colleague-outside', 5], ['outside-org', 1], ['first-time', 1.5]]);
    assert.match(r.signals[0].text, /^Google Docs sent it for someone using the name of a person in your organization, but from an account at another organization \(dana\.morales\.office@lakeside-isd\.example\)\.$/);
    assert.match(r.signals.find(s => s.kind === 'first-time').text, /dana\.morales\.office@lakeside-isd\.example/, 'first seen by the person, not by Google\'s address');
    assert.equal(r.status, 'flagged');
    assert.equal(decide(r, enforce, {}).action, 'move');
    const personal = await judge(driveShare({ name: 'Dana Morales', replyTo: 'dana.morales.1985@gmail.com' }));
    assert.deepEqual(kinds(personal).filter(([k]) => /relay/.test(k)), [['relay-colleague-personal', 3]]);
    // DocuSign: "Name via Docusign", the sender's address in the Reply-To.
    const ds = (replyTo) => mail([`From: "Dana Morales via Docusign" <dse_na4@docusign.net>`, `Reply-To: "Dana Morales" <${replyTo}>`, `To: ${USER}`,
        'Subject: Complete with Docusign: Salary_Agreement_2026.pdf', 'Message-ID: <d1@docusign.net>', DOCUSIGN],
        '<p>Dana Morales sent you a document to review and sign.</p><p><a href="https://na4.docusign.net/Signing/EmailStart.aspx?a=0a1b2c3d">REVIEW DOCUMENT</a></p>');
    assert.equal((await judge(ds(`dana.morales@${OTHER}`))).signals.find(s => s.kind === 'relay-colleague-outside').weight, 5);
    assert.deepEqual(kinds(await judge(ds(`dana.morales@${ORG}`), { firstTime: true })), [], 'a colleague\'s own envelope, from inside: nothing');
    assert.equal(E.colleagueNameHash('Dana Morales via Docusign'), E.colleagueNameHash('Dana Morales'));
    assert.equal(E.colleagueNameHash('Dana Morales (via Google Docs)'), E.colleagueNameHash('Dana Morales'));
});

test('a real outside account shares; the note names a colleague and asks to sign in: flagged; a partner\'s ordinary share isn\'t', async () => {
    const note = 'Dana Morales from the Maple Schools business office asked me to share the updated payroll adjustments. Please review and sign in to confirm your direct deposit before Friday.';
    const r = await judge(driveShare({ name: 'Pat Kim', replyTo: `pat.kim@${OTHER}`, note, title: '2026 Payroll Adjustments' }), { firstTime: true });
    assert.deepEqual(kinds(r).filter(([k]) => /colleague|share-lure|outside-org|first-time/.test(k)).sort(),
        [['colleague-named-outside', 2], ['first-time', 1.5], ['outside-org', 1], ['share-lure', 1]]);
    assert.equal(r.status, 'flagged');
    assert.equal(decide(r, enforce, {}).action, 'move');
    // A partner they know, sharing a document that mentions a colleague, nothing asked: suspicious at most.
    const partner = await judge(driveShare({ name: 'Pat Kim', replyTo: `pat.kim@${OTHER}`, note: 'As we discussed with Dana Morales, here is the draft agenda for the regional meeting.' }));
    assert.equal(partner.score, 3);
    assert.notEqual(decide(partner, enforce, {}).action, 'move');
    // The same from the sender's own account (not a notification), linking a Google Form.
    const direct = await judge(mail([`From: "Pat Kim" <pat.kim@${OTHER}>`, `To: ${USER}`, 'Subject: Shared: Q3 Budget Review from Dana Morales', 'Message-ID: <p1@lakeside-isd.example>',
        `Authentication-Results: mx.google.com; dkim=pass header.i=@${OTHER}; spf=pass; dmarc=pass (p=NONE) header.from=${OTHER}`],
        '<p>Hello,</p><p>Dana Morales has shared "Q3 Budget Review" with you. Please verify your account to view the document.</p><p><a href="https://forms.gle/AbCdEfGh12345678">View document</a></p>'), { firstTime: true });
    assert.ok(direct.signals.some(s => s.kind === 'colleague-named-outside') && direct.signals.some(s => s.kind === 'share-lure'), JSON.stringify(kinds(direct)));
    assert.equal(direct.status, 'flagged');
});

test('a colleague\'s name doesn\'t count as a greeting, the reader\'s own name, a quotation of their email, or outside a share', () => {
    const named = (text, extra = {}) => N.colleagueMentionSigns(E, Object.assign({ subject: '', text, colleagues, orgDomains: [ORG] }, extra)).length;
    assert.equal(named('Dana Morales asked me to share this with you.'), 1);
    assert.equal(named('Thanks,\nDana Morales'), 1, 'a signature in the colleague\'s name counts');
    assert.equal(named('Hi Dana Morales, here is the file.'), 0, 'a greeting');
    assert.equal(named('Good morning Dana Morales!'), 0);
    assert.equal(named('Sam Okafor, please review the file.', { selfHash: E.colleagueNameHash('Sam Okafor') }), 0, 'the reader\'s own name');
    assert.equal(named(`On Monday, Dana Morales <dana.morales@${ORG}> wrote: here are the notes.`), 0, 'a quotation of the colleague\'s own email');
    assert.equal(named('From: Dana Morales <dana.morales@maple-schools.example>\nSubject: notes'), 0);
    assert.equal(named('From: Dana Morales <dana.morales.payroll@gmail.com>\nPlease sign in.'), 1, 'her name on someone else\'s address is no quotation');
    assert.equal(named('Dana Morales asked me to share this.', { exclude: ['Dana Morales'] }), 0, 'the sender\'s own name: judged by the From checks');
    assert.equal(N.colleagueMentionSigns(E, { text: 'Dana Morales asked me', colleagues: null }).length, 0, 'no directory, no check');
});

test('only a notification the receiver verified is the platform\'s; a forged one is judged like any email', async () => {
    const forged = await readMessage(mail(['From: "Dana Morales (via Google Docs)" <drive-shares-dm-noreply@google.com>', `To: ${USER}`, 'Subject: Document shared with you',
        'Message-ID: <f1@x.example>', 'Authentication-Results: mx.google.com; spf=fail; dmarc=fail (p=REJECT) header.from=google.com'], '<p>Open</p>'));
    assert.equal(platformNotification(forged, [ORG]), null);
    const r = await analyze(forged, { mailbox: USER, orgDomains: [ORG], colleagues });
    assert.ok(r.signals.some(s => /uses the name of someone in your organization/.test(s.text)), 'the colleague-name check applies as before');
    // An employee's own address at the platform is no notification.
    const person = await readMessage(mail(['From: "Dana Morales" <dana@google.com>', `To: ${USER}`, 'Subject: hi', 'Message-ID: <g1@google.com>', GOOGLE], '<p>hello</p>'));
    assert.equal(platformNotification(person, [ORG]), null);
});

test('mass share: the same outside account reaching 10 of the organization\'s people within the hour adds a sign, and one alert', async () => {
    const store = new MemoryStore();
    const svc = new Service({ cfg: loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER }), store, gmail: { labelId: async () => 'L', modify: async () => ({}) }, log: { error() {}, warn() {} } });
    const raw = driveShare({ name: 'Pat Kim', replyTo: `pat.kim@${OTHER}`, title: 'Updated handbook' });
    const recs = [];
    for (let i = 0; i < 12; i++) recs.push(await svc.judge(`staff${i}@${ORG}`, { id: `m${i}`, threadId: 't', internalDate: Date.now() }, await readMessage(raw)));
    const signs = await Promise.all(recs.map(async (r, i) => ((await store.getRecord(`staff${i}@${ORG}|m${i}`)) || {}).signals || []));
    assert.ok(!signs[8].some(s => s.kind === 'mass-share'), 'not before the tenth');
    assert.ok(signs[9].some(s => s.kind === 'mass-share' && /to 10 of your people within the hour/.test(s.text)), JSON.stringify(signs[9]));
    const alerts = (await store.listEvents()).filter(e => e.kind === 'mass-share');
    assert.equal(alerts.length, 1, 'one alert');
    assert.match(alerts[0].text, /^pat\.kim@lakeside-isd\.example \(outside your organization\) sent the same Google Docs share to 10 of your people within the hour\./);
    // The directory's names with their addresses: each person's own name is known (as a hash), for their mail.
    const dir = new Service({ cfg: loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: USER, DIRECTORY_ADMIN: `admin@${ORG}` }), store: new MemoryStore(), log: { error() {}, warn() {} },
        gmail: { userNames: async () => [{ name: 'Sam Okafor', email: USER }, { name: 'Dana Morales', email: `dana.morales@${ORG}` }, 'Jordan Rivera'] } });
    const hashes = await dir.colleagueNames();
    assert.equal(hashes.size, 3);
    assert.equal(dir.selfNameHash(USER), E.colleagueNameHash('Sam Okafor'));
    assert.equal(dir.selfNameHash(`nobody@${ORG}`), '');
});

test('0.5.17: Google Classroom from a personal account (gmail.com…) is flagged; a school\'s class, or one whose account isn\'t shown, isn\'t', async () => {
    const classroom = ({ name = 'Coach Pat', subject = 'Class invitation: "SEO Masters"', kind = 'CLASS_INVITATION', body }) => mail([
        `From: "${name} (Classroom)" <no-reply@classroom.google.com>`, `To: ${USER}`, `Subject: [EXTERNAL] ${subject}`, 'Message-ID: <ci@notifications.google.com>',
        `X-Notifications: ${kind}:1:2-3`, GOOGLE], body);
    const join = '<p><a href="https://classroom.google.com/c/MTIzNDU2?cjc=abc123">Join</a></p>';
    // The inviting account shown next to its name: a personal one.
    let r = await judge(classroom({ body: `<p>Coach Pat (coach.pat.seo@gmail.com) invited you to the class SEO Masters.</p>${join}` }));
    assert.deepEqual(kinds(r).filter(([k]) => k === 'classroom-personal'), [['classroom-personal', 5]]);
    assert.equal(r.signals.find(s => s.kind === 'classroom-personal').text, 'A Google Classroom invitation from a personal account (coach.pat.seo@gmail.com), not a school\'s: classes run from personal accounts are a known way to send scams through Classroom.');
    assert.equal(r.status, 'flagged');
    assert.equal(decide(r, enforce, {}).action, 'move');
    // Shown elsewhere in an invitation's text.
    r = await judge(classroom({ subject: 'You were invited to a class', kind: 'OTHER', body: `<p>Coach Pat invited you to the class SEO Masters.</p>${join}<p>This invitation was sent by coach.pat.seo@outlook.com.</p>` }));
    assert.ok(r.signals.some(s => s.kind === 'classroom-personal'), JSON.stringify(kinds(r)));
    // A personal address the platform writes next to the name, in a post (not an invitation): flagged too.
    r = await judge(classroom({ name: 'Coach Pat', subject: 'New assignment: "Week 1"', kind: 'NEW_ASSIGNMENT', body: `<p>Coach Pat (coach.pat.seo@yahoo.com) posted a new assignment.</p>${join}` }));
    assert.ok(r.signals.some(s => s.kind === 'classroom-personal'));
    // Not flagged: another school's class; a post whose text only quotes someone's personal address; an
    // invitation that shows no account at all (unknown: the links and the AI still judge it).
    r = await judge(classroom({ body: `<p>Coach Pat (coach.pat@${OTHER}) invited you to the class Regional Robotics.</p>${join}` }));
    assert.ok(!r.signals.some(s => s.kind === 'classroom-personal'));
    r = await judge(classroom({ name: 'Jordan Rivera', subject: 'New comment on "Lab report"', kind: 'NEW_COMMENT', body: `<p>Jordan Rivera replied: email me at jr.lab.help@gmail.com if the form doesn't work.</p>${join}` }));
    assert.ok(!r.signals.some(s => s.kind === 'classroom-personal'), 'a post, and the address isn\'t the poster\'s');
    r = await judge(classroom({ body: `<p>Coach Pat invited you to the class SEO Masters.</p>${join}` }));
    assert.ok(!r.signals.some(s => s.kind === 'classroom-personal'));
    assert.equal(platformNotification(await readMessage(classroom({ body: '<p>x</p>' })), [ORG]).invitation, true);
});

test('0.5.22: a colleague\'s Drive share as Google sends it (text, AMP and HTML versions): nothing found, and the AMP version is no attachment', async () => {
    // The shape of the 0.5.14 false alarm: "Name (via Google Docs)" <drive-shares-dm-noreply@google.com>, judged
    // since 0.5.16 by the Reply-To Google sets from the sharer's account (a colleague's, here). Made-up people.
    const b = 'b1_share';
    const raw = Buffer.from([`From: "Dana Morales (via Google Docs)" <drive-shares-dm-noreply@google.com>`, `Reply-To: "Dana Morales" <dana.morales@${ORG}>`, `To: ${USER}`,
        'Subject: Document shared with you: "Board deliverables for the Friday meeting"', 'Message-ID: <autogen-java-0000@google.com>', GOOGLE,
        'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '',
        `--${b}`, 'Content-Type: text/plain; charset="UTF-8"', '', `Dana Morales shared a document. Dana Morales (dana.morales@${ORG}) has invited you to view the following document: Board deliverables for the Friday meeting`, '',
        `--${b}`, 'Content-Type: text/x-amp-html; charset="UTF-8"', '', '<!doctype html><html amp4email><head><meta charset="utf-8"><script async src="https://cdn.ampproject.org/v0.js"></script></head><body><p>Dana Morales shared a document</p></body></html>', '',
        `--${b}`, 'Content-Type: text/html; charset="UTF-8"', '', `<p>Dana Morales shared a document</p><p>Dana Morales (dana.morales@${ORG}) has invited you to view the following document:</p><p><a href="https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit">Open</a></p>`, '',
        `--${b}--`, ''].join('\r\n'));
    const facts = await readMessage(raw);
    assert.deepEqual(facts.attachments, [], 'the AMP version is the email, not a file');
    const r = await judge(raw, { firstTime: true });
    assert.deepEqual(kinds(r), [], 'no "colleague\'s name on an outside address", no "outside your organization"');
    assert.equal(decide(r, enforce, {}).action, 'none');
    // A real file is still one.
    const withFile = Buffer.from(raw.toString().replace(`--${b}--`, `--${b}\r\nContent-Type: text/x-amp-html; name="page.html"\r\nContent-Disposition: attachment; filename="page.html"\r\n\r\n<p>x</p>\r\n--${b}--`));
    assert.equal((await readMessage(withFile)).attachments.length, 1);
});
