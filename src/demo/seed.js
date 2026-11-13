'use strict';
// Made-up data for demo mode and the clickable mockup. EVERYTHING HERE IS INVENTED: the district
// (maple-schools.example), its people, the senders and the emails. No real email or person is used.
//
// The records are not typed in by hand: each made-up email below is judged by the real engine and
// policy (Service.judge), once per campaign, and the result is copied to the campaign's other
// recipients with their own times. So the dashboard shows the reasons and scores the service would
// actually produce. The story: monitor mode until 10 days ago, then enforce mode; one genuine store
// newsletter moved by mistake (its wording reads like a prize scam) and released by IT; a new vendor
// asking to update bank details recorded as suspicious but not moved.
const { Service } = require('../pipeline');
const { readMessage } = require('../engine/mime');
const { MemoryStore } = require('../store/memory');
const { createFakeIntel } = require('./fake-intel');
const { createSafeBrowsingKey, memorySecrets } = require('../intel/sbkey');

const DAY = 24 * 60 * 60 * 1000;
const ORG = 'maple-schools.example';
const FIRST = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Drew', 'Sam', 'Robin', 'Dana', 'Reese', 'Skyler', 'Emerson', 'Rowan', 'Harper', 'Logan', 'Kendall', 'Parker', 'Sage', 'Blake', 'Cameron'];
const LAST = ['Rivera', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Novak', 'Haddad', 'Castillo', 'Brennan', 'Sato', 'Fischer', 'Adeyemi', 'Kowalski', 'Duarte', 'Whitlock', 'Ibarra'];

function rng(seed) {
    let a = seed >>> 0;
    const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    r.pick = (a) => a[Math.floor(r() * a.length)];
    return r;
}

function people(r, n) {
    const out = new Set();
    while (out.size < n) out.add(`${r.pick(FIRST).toLowerCase()}.${r.pick(LAST).toLowerCase()}@${ORG}`);
    return [...out];
}

const auth = (dom, dmarc, spf = dmarc === 'pass' ? 'pass' : 'softfail') => `Authentication-Results: mx.google.com; dkim=${dmarc === 'pass' ? 'pass' : 'none'}; spf=${spf} smtp.mailfrom=bounce@${dom}; dmarc=${dmarc} header.from=${dom}`;
// attachment: { name, type, base64 } (0.5.34: the demo's QR code).
function eml({ fromName, from, to, subject, dmarc, html, extraHeaders = '', attachment = null }) {
    const dom = from.split('@')[1];
    const head = [`Delivered-To: ${to}`, `Received: from mail.${dom} (mail.${dom}. [203.0.113.${(dom.length * 7) % 250}]) by mx.google.com with ESMTPS id d1; Mon, 02 Nov 2026 11:46:40 -0800 (PST)`,
        auth(dom, dmarc), `From: "${fromName}" <${from}>`, `To: ${to}`, `Subject: ${subject}`, 'Date: Mon, 02 Nov 2026 19:46:39 +0000',
        `Message-ID: <${Math.abs(subject.length * 7919)}@${dom}>`, 'MIME-Version: 1.0', ...extraHeaders.split('\r\n')];
    if (!attachment) return [...head, 'Content-Type: text/html; charset=utf-8'].filter(Boolean).join('\r\n') + '\r\n\r\n' + html;
    const b = 'demo_part';
    return [...head, `Content-Type: multipart/mixed; boundary="${b}"`].filter(Boolean).join('\r\n') + '\r\n\r\n'
        + [`--${b}`, 'Content-Type: text/html; charset=utf-8', '', html, `--${b}`, `Content-Type: ${attachment.type}; name="${attachment.name}"`, `Content-Disposition: attachment; filename="${attachment.name}"`,
            'Content-Transfer-Encoding: base64', '', attachment.base64.replace(/.{76}/g, '$&\r\n'), `--${b}--`, ''].join('\r\n');
}

// The made-up campaigns: who sent them, to how many people, when (days ago), and the email itself.
function campaignTemplates() {
    return [
        { id: 'storage', recipients: 34, daysAgo: 2, spread: 0.2, make: (to) => eml({ fromName: to.split('@')[0].split('.')[0], from: 'noreply@brt.greenpath-mail.example', to, dmarc: 'fail',
            subject: "We've blocked your account! Your photos and videos will be deleted. Renew your subscription for free now!",
            html: '<a href="https://storage.googleapis.com/bucket-77/renew.html#x1"><h1>Cloud</h1></a><p>Your payment method has expired. Please update your payment information.</p><p>Your photos and videos will be deleted!</p><a href="https://storage.googleapis.com/bucket-77/renew.html#x2">Update my payment information</a><div style="height:5000px"></div><p>Please remember to drop your regalia back to the regalia room. This is an archived section of the community. Thank you again, it has been a pleasure doing business with you. This change was done to make the forum easier to use and to keep only the most helpful content.</p>' }) },
        { id: 'payroll', recipients: 12, daysAgo: 5, spread: 0.1, make: (to) => eml({ fromName: 'Human Resources', from: 'hr@maple-schools-payroll.example', to, dmarc: 'none',
            subject: 'Action required: confirm your direct deposit before Friday',
            html: '<p>Dear Employee,</p><p>Payroll requires all staff to update their direct deposit information before the next pay cycle.</p><p>Please confirm your password at the secure portal below to continue.</p><p><a href="https://maple-schools-payroll.example/login">Sign in to the HR portal</a></p><p>Human Resources</p>' }) },
        { id: 'docusign', recipients: 9, daysAgo: 8, spread: 0.3, make: (to) => eml({ fromName: 'DocuSign via Signature', from: 'notify@docs-review-center.example', to, dmarc: 'fail',
            subject: 'Please review and sign: Updated salary agreement',
            html: '<p>Hello,</p><p>You have a new document to review and sign: Updated salary agreement.</p><p><a href="https://docs-review-center.example/view?d=7781">Review document</a></p><p>This link expires in 24 hours. This email has been verified safe by Microsoft Security.</p>' }) },
        { id: 'microsoft', recipients: 16, daysAgo: 13, spread: 0.2, make: (to) => eml({ fromName: 'Microsoft 365 Security', from: 'security@micros0ft-support.example', to, dmarc: 'fail',
            subject: 'Your password expires today',
            html: '<p>Dear User,</p><p>Your Microsoft 365 password will expire in 2 hours.</p><p>Click the button below to keep your current password.</p><p><a href="https://micros0ft-support.example/keep">Keep my password</a></p><p>Microsoft Security Team</p>' }) },
        { id: 'iptv', recipients: 21, daysAgo: 4, spread: 0.6, make: (to) => eml({ fromName: 'IPTV PREMIUM', from: 'lena__a81f22c4e9@freemail.example', to, dmarc: 'pass',
            subject: 'GET NOW BEST IPTV SUBSCRIPTION 1 YEAR LOW PRICE', extraHeaders: 'X-Spam-Flag: YES\r\nList-Unsubscribe: <http://127.0.0.1:3000/unsubscribe?s=4>',
            html: '<p>📺 Unlimited Entertainment with IPTV</p><p>✨ 21,000+ Live TV Channels</p><p>📱 Compatible with Smart TV, Android, iPhone, PC &amp; Fire Stick</p><p>💳 Flexible Subscription Plans</p><p>💬 WhatsApp: wa.me/000555012345</p><p><a href="http://127.0.0.1:3000/unsubscribe?s=4">Unsubscribe</a></p>' }) },
        { id: 'credit', recipients: 18, daysAgo: 11, spread: 0.5, make: (to) => eml({ fromName: 'Platinum | Credit Card', from: 'app.app.alter@pw-offers-mailer.example', to, dmarc: 'pass',
            subject: `${to.split('@')[0].split('.')[0].toUpperCase()}! Apply for a $1000 credit limit card`,
            html: '<span style="display:none">This $1000 credit limit card could be yours. Apply today!</span><a href="https://pw-offers-mailer.example/r/1"><img src="https://pw-offers-mailer.example/a.jpg" width="600"></a><div style="height:1200px"></div><p>Daily news digest: the city council met on Tuesday to discuss the new park, the library extended its hours, and the weather will stay mild through the weekend according to local forecasters, who expect sunshine and light winds.</p>' }) },
        { id: 'giftcard', recipients: 5, daysAgo: 6, spread: 0.05, make: (to) => eml({ fromName: 'Dr. Morgan Hale', from: 'morgan.hale.office@freemail.example', to, dmarc: 'pass',
            subject: 'Quick favor',
            html: '<p>Are you at your desk? I am in a meeting and can\'t talk on the phone.</p><p>I need you to buy 6 Apple gift cards worth $100 each for staff appreciation. Scratch the cards and send me photos of the codes.</p><p>Please keep this confidential.</p><p>Dr. Morgan Hale, Superintendent</p>' }) },
        { id: 'invoice', recipients: 4, daysAgo: 16, spread: 0.3, make: (to) => eml({ fromName: 'Accounts Receivable', from: 'billing@harbor-supply-invoices.example', to, dmarc: 'none',
            subject: 'Final notice: outstanding balance $2,450.00',
            html: '<p>Dear Customer,</p><p>Our records show an unpaid balance of $2,450.00.</p><p>Our bank details have changed; please update the account number on file and pay today to avoid collection.</p><p><a href="https://harbor-supply-invoices.example/pay">Pay now</a></p>' }) },
        // A QR code attached ("quishing", 0.5.34): its link is on a phishing list.
        { id: 'qr', recipients: 7, daysAgo: 1, spread: 0.2, make: (to) => eml({ fromName: 'Benefits Enrollment', from: 'enroll@benefit-renewal.example', to, dmarc: 'none',
            subject: 'Open enrollment: scan to keep your benefits',
            html: '<p>Hello,</p><p>Your benefits will end unless you confirm your enrollment this week.</p><p>Scan the QR code in the attached form with your phone to continue.</p><p>Benefits Office</p>',
            attachment: { name: 'Benefits_Form.png', type: 'image/png', base64: require('./qr-sample').QR_PNG_BASE64 } }) },
        // A genuine newsletter the AI scored high: moved by mistake, released by IT (a false alarm).
        { id: 'deals', recipients: 3, daysAgo: 3, spread: 0.1, falseAlarm: true, make: (to) => eml({ fromName: 'Gadget Deals', from: 'deals@e.gadgetdeals-shop.example', to, dmarc: 'pass',
            subject: 'Last chance! 90% off ends tonight — claim your reward',
            html: '<p>Congratulations! You have been selected for our biggest reward of the year.</p><p>Claim your $500 gift card today. Offer expires in 24 hours.</p><p>Confirm your account details to receive your reward.</p><p><a href="https://e.gadgetdeals-shop.example/claim">Claim now</a></p>' }) },
        // A new vendor asking to update bank details: the rules see little, the AI scores it high.
        { id: 'newvendor', recipients: 6, daysAgo: 9, spread: 0.4, make: (to) => eml({ fromName: 'Pat Delgado', from: 'pat@brightpath-learning.example', to, dmarc: 'pass',
            subject: 'Quote for the reading program',
            html: '<p>Hi,</p><p>Following up on the conference. Could you send me the purchase order number and update our bank details on file for the invoice?</p><p>Thanks, Pat Delgado, Account Executive</p>' }) },
        // Suspicious but below the move rules (a young sender or link domain, a rules score of 4.5, a low AI score):
        // recorded only, left in the Inbox, for Review's "Suspicious, not moved".
        { id: 'survey', recipients: 7, daysAgo: 3, spread: 0.3, make: (to) => eml({ fromName: 'Staff Benefits Team', from: 'benefits@staff-perks-portal.example', to, dmarc: 'pass',
            subject: 'Complete the benefits survey and receive a $25 gift card',
            html: '<p>Dear Staff Member,</p><p>Tell us about your benefits this year. Everyone who completes the survey receives a $25 gift card.</p><p><a href="https://forms.survey-host.example/s/benefits-2026">Start the survey</a></p>' }) },
        { id: 'webinar', recipients: 5, daysAgo: 1, spread: 0.4, make: (to) => eml({ fromName: 'EdTech Summit', from: 'events@edtech-summit.example', to, dmarc: 'pass',
            subject: 'Last seats: free webinar on classroom AI tools',
            html: '<p>Join 2,000 educators for a free webinar on AI tools in the classroom.</p><p>Thursday, 4 PM. Seats are limited.</p><p><a href="https://summit-registration.example/edtech/register">Register now</a></p><p><a href="https://edtech-summit.example/unsubscribe">Unsubscribe</a></p>' }) },
        // Someone outside using the name of a person in the district (the made-up principal, in the demo
        // directory below): the colleague-name check's sign.
        { id: 'colleague', recipients: 4, daysAgo: 2, spread: 0.1, make: (to) => eml({ fromName: PRINCIPAL, from: 'jordan.whitfield.office@freemail.example', to, dmarc: 'pass',
            subject: 'Are you available?',
            html: '<p>Hi,</p><p>Are you available? I am in a meeting and need a quick favor before the end of the day.</p><p>Reply with your cell number and I will text you the details.</p><p>Jordan Whitfield</p>' }) },
        // An email in Spanish: the rules check it as any other, the AI model (English only) gives no score.
        { id: 'spanish', recipients: 6, daysAgo: 5, spread: 0.3, make: (to) => eml({ fromName: 'Servicio de Correo', from: 'soporte@correo-seguro-cuenta.example', to, dmarc: 'fail',
            subject: 'Su cuenta de correo será suspendida hoy',
            html: '<p>Estimado usuario,</p><p>Su cuenta de correo ha sido suspendida temporalmente por actividad inusual. Para restablecer el acceso, haga clic en el enlace y confirme su información antes de las 24 horas.</p><p><a href="https://correo-seguro-cuenta.example/verificar">Verificar mi cuenta</a></p><p>Gracias por su atención,</p><p>Equipo de soporte</p>' }) },
    ];
}

// The made-up principal whose name the 'colleague' campaign borrows: one of the demo directory's names.
const PRINCIPAL = 'Jordan Whitfield';
// The demo directory's full names (the colleague-name check reads them as one-way hashes).
// The demo directory, as the Admin SDK gives it (gmail/client.js userNames): each person's name and address.
const directoryNames = (staff) => [{ name: PRINCIPAL, email: '' }, ...staff.map(u => ({ name: u.split('@')[0].split('.').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), email: u }))];
const fakeGmail = { labelId: async (u, n) => `Label_${n}`, modify: async () => ({}) };

async function buildDemo({ now = Date.now(), cfg }) {
    const r = rng(20261106);
    const store = new MemoryStore();
    const staff = people(r, 60);
    // Watched mailboxes, each with a recent notification (no random draws here: the data below stays the same).
    for (const [i, u] of staff.entries()) await store.putUser(u, { watched: true, historyId: '1000', lastNotification: now - (3 + (i * 37) % 180) * 60 * 1000, watchExpiration: now + 6 * DAY });
    await store.addEvent({ kind: 'watch', at: now - 15 * 60 * 60 * 1000, text: `Watching ${staff.length} mailboxes. spruce-pilot@${ORG}: ${staff.length + 2} entries (1 group inside it, whose members are listed too), ${staff.length} people to watch; left out: 1 not active (suspended or archived).` });
    await store.setState('installedAt', now - 60 * DAY);
    const monitorUntil = now - 10 * DAY;              // monitor mode before, enforce after
    const templates = campaignTemplates();
    const intel = createFakeIntel();                   // made-up lookup answers (no network in demo mode)
    const raws = new Map();                            // each made-up email, by its Gmail id (the retraining export reads them)
    const demoGmail = Object.assign({}, fakeGmail, { userNames: async () => directoryNames(staff) });   // (the colleague-name check's directory)
    for (const t of templates) {
        const when0 = now - t.daysAgo * DAY + r.int(8, 15) * 3600 * 1000 - DAY / 2;
        const mode = when0 < monitorUntil ? 'monitor' : 'enforce';
        const svc = new Service({ cfg: Object.assign({}, cfg, { mode, orgDomains: [ORG], storeSubjects: true, storeAiQuotes: true, firstSeenLearningDays: 14, directoryAdmin: `spruce-directory@${ORG}`, colleagueNames: true }), store, gmail: demoGmail, intel, now: () => when0, log: { error() {} } });
        const recips = r.int(0, 1) ? staff.slice(0, t.recipients) : staff.slice(-t.recipients);
        recips.forEach((u, i) => raws.set(`demo-${t.id}-${i}`, Buffer.from(t.make(u))));
        const facts = await readMessage(raws.get(`demo-${t.id}-0`));
        const first = await svc.judge(recips[0], { id: `demo-${t.id}-0`, threadId: `t-${t.id}-0`, internalDate: when0 }, facts);
        if (!first || first.action === 'none') continue;
        for (let i = 1; i < recips.length; i++) {
            const at = when0 + Math.round(r() * t.spread * DAY);
            const rec = Object.assign(JSON.parse(JSON.stringify(first)), { key: `${recips[i]}|demo-${t.id}-${i}`, user: recips[i], messageId: `demo-${t.id}-${i}`, threadId: `t-${t.id}-${i}`, receivedAt: at, processedAt: at });
            // A sender named after the recipient (the fake storage notice) is named after each one.
            const firstName = (u) => u.split('@')[0].split('.')[0];
            if (rec.sender.name === firstName(recips[0])) rec.sender.name = firstName(recips[i]);
            await store.saveRecord(rec);
        }
        if (t.falseAlarm) {
            const rs = (await store.listRecords({ sinceMs: 0 })).filter(x => x.campaign === first.campaign);
            for (const x of rs) await store.updateRecord(x.key, { state: x.action === 'move' ? 'released' : x.state, releasedBy: 'it.helpdesk@maple-schools.example', releasedAt: x.processedAt + 3 * 3600 * 1000, falseAlarm: true, markedBy: 'it.helpdesk@maple-schools.example' });
        }
    }
    // Users who moved a moved email back to the Inbox themselves.
    const all = await store.listRecords({ sinceMs: 0 });
    const storageMoved = all.filter(x => /greenpath/.test(x.sender.domain) && x.state === 'moved');
    for (const x of storageMoved.slice(0, 1)) {
        await store.updateRecord(x.key, { state: 'released', releasedBy: x.user, releasedByUser: true, releasedAt: x.processedAt + 50 * 60 * 1000, falseAlarm: true });
        store.events.push({ at: x.processedAt + 50 * 60 * 1000, kind: 'user-release', user: x.user, key: x.key, text: `${x.user} moved an email from ${x.sender.address} back to the Inbox, though the checks flagged it (score ${x.score}). Make sure it's safe, or mark it phishing and warn them.` });
    }
    // Some confirmed right by an admin (phishing indeed).
    for (const x of (await store.listRecords({ sinceMs: 0 })).filter(x => /storage|micros0ft/.test(x.sender.domain) && !x.releasedByUser).slice(0, 20)) await store.updateRecord(x.key, { falseAlarm: false, markedBy: 'it.helpdesk@maple-schools.example' });
    // Daily counters: about 40 emails a day per person, fewer on weekends; the move counts come from the records.
    store.stats.clear();
    const dayIn = (ms) => require('../dashboard/aggregate').dayIn(ms, cfg.timeZone);   // (the organization's days, 0.5.27)
    for (let d = 30; d >= 0; d--) {
        const t = now - d * DAY, day = dayIn(t), wd = new Date(`${day}T12:00:00Z`).getUTCDay();
        await store.incStat(day, 'scanned', Math.round(staff.length * (wd === 0 || wd === 6 ? 6 : 38) * (0.85 + r() * 0.3)));
    }
    for (const x of await store.listRecords({ sinceMs: 0 })) {
        const day = dayIn(x.processedAt);
        await store.incStat(day, x.action === 'move' ? 'moved' : x.action === 'would-move' ? 'wouldMove' : 'flagged');
        if (x.state === 'released') await store.incStat(dayIn(x.releasedAt), 'released');
    }
    store.events = [...store.events,
        { at: now - 3 * DAY + 5 * 3600e3, kind: 'release', text: 'it.helpdesk@maple-schools.example moved 3 emails from deals@e.gadgetdeals-shop.example back to the Inbox (marked as false alarms).' },
        { at: now - 10 * DAY, kind: 'mode', admin: true, text: 'Mode changed from monitor to enforce by it.director@maple-schools.example.' },
        { at: now - 2 * DAY + 9 * 3600e3, kind: 'campaign', alert: true, text: '34 staff received the same fake cloud-storage notice within 5 hours; all were moved to Spam.' }
    ];
    // Re-checked mail (0.5.35): a payroll lure delivered yesterday, clean then; this morning Phishing Army
    // listed its site, and the re-check moved every copy still in an Inbox. Some had been opened, one link
    // clicked (Gmail's logs, Settings → Link clicks on); one copy its reader had archived.
    await seedRechecked({ store, staff, intel, raws, cfg, now, r });
    // The look-alike watch (0.5.36): four made-up look-alikes found, one new (the payroll lure's domain).
    const H = 3600e3, lv = require('../lookalike').variantsOf(require('../engine/spruce').load(), [ORG]);
    await store.setState('lookalikeWatch', { cursor: 240, candidates: lv.length, passes: 9, baselineDone: true, passStartedAt: now - 3 * H, lastPassAt: now - 27 * H, found: {
        'maple-schools-payroll.example': { domain: 'maple-schools-payroll.example', first: now - 6 * DAY + 4 * H, last: now - 3 * H, mx: true, web: true, ageDays: 1, status: 'new', gone: null },
        'maple-schools.org': { domain: 'maple-schools.org', first: now - 20 * DAY, last: now - 3 * H, mx: true, web: true, ageDays: 2900, status: 'ours', firstStatus: 'baseline', by: `it.director@${ORG}`, at: now - 19 * DAY, gone: null },
        'maple-school.com': { domain: 'maple-school.com', first: now - 20 * DAY, last: now - 3 * H, mx: false, web: true, ageDays: 1400, status: 'baseline', gone: null },
        'mapleschools.net': { domain: 'mapleschools.net', first: now - 20 * DAY, last: now - 3 * H, mx: true, web: true, ageDays: 3650, status: 'harmless', firstStatus: 'baseline', by: `it.director@${ORG}`, at: now - 19 * DAY, gone: null } } });
    store.events.push({ at: now - 6 * DAY + 4 * H, kind: 'lookalike', alert: true, text: 'A domain that imitates yours was registered: maple-schools-payroll.example (mail servers: yes; a website: yes; registered 1 day ago). Mail from it, replies to it and links to it now count as strong signs of phishing. If the district registered it itself, mark it so: dashboard, Status → Look-alikes. More: docs/ALERTS.md, "A look-alike of your domain".' });
    // (the colleague-name check read the demo directory while the made-up mail was judged: as of now)
    const cn = await store.getState('colleagueNames');
    if (cn) await store.setState('colleagueNames', Object.assign({}, cn, { at: now - 20 * 60 * 1000 }));
    // Settings → Safe Browsing in the demo (0.5.23): a key is only checked for its form, never sent anywhere,
    // and kept in this process; turned on, "Check an email" gets the made-up Safe Browsing answers.
    intel.sbKey = createSafeBrowsingKey({ cfg, store, secrets: memorySecrets(), offline: true });
    // Settings → Spamhaus and abuse.ch in the demo (0.5.37): keys checked for their form only, kept in this
    // process; nothing is looked up or downloaded.
    const { createApiKey } = require('../intel/apikey');
    intel.keys = {
        spamhaus: createApiKey({ id: 'spamhaus', label: 'Spamhaus', store, secrets: memorySecrets(), keyRe: require('../intel/spamhaus').KEY_RE, test: async () => ({ ok: true }), offline: true }),
        abusech: createApiKey({ id: 'abusech', label: 'abuse.ch', store, secrets: memorySecrets(), keyRe: require('../intel/abusech').KEY_RE, test: async () => ({ ok: true }), offline: true })
    };
    intel.spamhaus = { checkDomains: async () => new Map(), quota: async () => ({ today: 0, max: cfg.spamhausDailyMax, stopped: false }), setKey() {} };
    intel.threats.enabled = { cloudflare: true, get safeBrowsing() { return !!cfg.safeBrowsing; } };
    return { store, staff, intel, raws };
}

async function seedRechecked({ store, staff, intel, raws, cfg, now, r }) {
    const at = now - 5 * 3600e3, delivered = now - 22 * 3600e3, site = 'paystub-viewer.example', list = 'Phishing Army (extended)';
    const recips = staff.slice(20, 29);
    const make = (to) => eml({ fromName: 'Payroll Center', from: 'notices@paystub-viewer.example', to, dmarc: 'pass',
        subject: 'Your November pay statement is ready',
        html: '<p>Hello,</p><p>Your November pay statement is ready to view.</p><p><a href="https://paystub-viewer.example/statement">View my statement</a></p><p>Payroll Center</p>' });
    recips.forEach((u, i) => raws.set(`demo-recheck-${i}`, Buffer.from(make(u))));
    const svc = new Service({ cfg: Object.assign({}, cfg, { mode: 'enforce', orgDomains: [ORG], storeSubjects: true, storeAiQuotes: true, firstSeenLearningDays: 14 }), store, gmail: fakeGmail, intel, now: () => at, log: { error() {} } });
    const facts = await readMessage(raws.get('demo-recheck-0'));
    const first = await svc.judge(recips[0], { id: 'demo-recheck-0', threadId: 't-recheck-0', internalDate: delivered }, facts);
    if (!first || first.action !== 'move') return;
    const opened = new Set([0, 2, 3, 5]), clickedOne = 3;
    for (const [i, u] of recips.entries()) {
        const rx = delivered + Math.round(r() * 40) * 60 * 1000;
        const archived = i === 7;
        const clicks = { checkedAt: at + 3 * 3600e3, checks: 2, named: opened.has(i), opened: opened.has(i), openedAt: opened.has(i) ? rx + (30 + i * 47) * 60 * 1000 : null,
            clicked: i === clickedOne, clickedAt: i === clickedOne ? rx + (32 + i * 47) * 60 * 1000 : null };
        const rec = Object.assign(JSON.parse(JSON.stringify(first)), { key: `${u}|demo-recheck-${i}`, user: u, messageId: `demo-recheck-${i}`, threadId: `t-recheck-${i}`, receivedAt: rx, processedAt: at,
            rfc822MessageId: `stmt-${i}@paystub-viewer.example`,
            why: `found on a re-check (${list} listed ${site} after it was delivered): ${first.why}${archived ? '; it had already left the Inbox (archived by its reader), so it wasn\'t moved' : ''}`,
            action: archived ? 'flag' : 'move', state: archived ? 'inbox' : 'moved', arrival: { at: rx, action: 'none' },
            recheck: { at, source: 'lists', site, list, round: null, before: 'none', beforeScore: null, outcome: archived ? 'not-in-inbox' : 'moved', where: archived ? 'archived' : 'inbox', opened: opened.has(i), movedAt: archived ? null : at, clicks } });
        await store.saveRecord(rec);
        await store.incStat(require('../dashboard/aggregate').dayIn(at, cfg.timeZone), archived ? 'flagged' : 'moved');
    }
    await store.setState('clickLogs', { on: true, admin: `it.director@${ORG}`, by: `it.director@${ORG}`, at: now - 20 * DAY });
    await store.setState('clickLogsHealth', { at: at + 3 * 3600e3, ok: true, error: null, checked: recips.length });
    store.events.push({ at, kind: 'recheck', alert: true, text: `Re-checked mail: ${recips.length} emails delivered earlier are now found to be phishing (${list} listed ${site}), from "${first.campaignLabel}": ${recips.length - 1} moved to Spam, 1 had already left the Inbox. ${opened.size} had been opened. Who got them, when, and what Gmail's logs say they did: dashboard, Email → Re-checked. More: docs/ALERTS.md, "Re-checked mail".` },
        { at: at + 3 * 3600e3, kind: 'recheck-click', alert: true, text: `A link was clicked in mail later found to be phishing: ${recips[clickedOne]} (an email from notices@paystub-viewer.example). Their password may have been given away: consider resetting it, ending their sessions and checking their sign-ins (Admin console). Dashboard: Email → Re-checked. More: docs/ALERTS.md, "A link was clicked".` });
}

// A made-up day of an admin's Gmail log (Settings → Link clicks's Test in demo mode), as the Reports API gives it.
function demoLogEvents(now) {
    return [7, 31, 15].map((type, i) => ({ id: { time: new Date(now - (i + 1) * 3600e3).toISOString() }, events: [{ name: 'delivery', parameters: [
        { name: 'event_info', messageValue: { parameter: [{ name: 'mail_event_type', intValue: String(type) }] } },
        { name: 'message', messageValue: { parameter: [{ name: 'rfc2822_message_id', value: `<demo-${i}@maple-schools.example>` }] } }] }] }));
}

module.exports = { buildDemo, campaignTemplates, directoryNames, ORG, demoLogEvents };
