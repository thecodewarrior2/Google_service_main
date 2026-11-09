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
function eml({ fromName, from, to, subject, dmarc, html, extraHeaders = '' }) {
    const dom = from.split('@')[1];
    return [`Delivered-To: ${to}`, `Received: from mail.${dom} (mail.${dom}. [203.0.113.${(dom.length * 7) % 250}]) by mx.google.com with ESMTPS id d1; Mon, 02 Nov 2026 11:46:40 -0800 (PST)`,
        auth(dom, dmarc), `From: "${fromName}" <${from}>`, `To: ${to}`, `Subject: ${subject}`, 'Date: Mon, 02 Nov 2026 19:46:39 +0000',
        `Message-ID: <${Math.abs(subject.length * 7919)}@${dom}>`, 'MIME-Version: 1.0', ...extraHeaders.split('\r\n'), 'Content-Type: text/html; charset=utf-8'].filter(Boolean).join('\r\n') + '\r\n\r\n' + html;
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
        // A genuine newsletter the AI scored high: moved by mistake, released by IT (a false alarm).
        { id: 'deals', recipients: 3, daysAgo: 3, spread: 0.1, falseAlarm: true, make: (to) => eml({ fromName: 'Gadget Deals', from: 'deals@e.gadgetdeals-shop.example', to, dmarc: 'pass',
            subject: 'Last chance! 90% off ends tonight — claim your reward',
            html: '<p>Congratulations! You have been selected for our biggest reward of the year.</p><p>Claim your $500 gift card today. Offer expires in 24 hours.</p><p>Confirm your account details to receive your reward.</p><p><a href="https://e.gadgetdeals-shop.example/claim">Claim now</a></p>' }) },
        // Suspicious but below the move rules: recorded only.
        { id: 'newvendor', recipients: 6, daysAgo: 9, spread: 0.4, make: (to) => eml({ fromName: 'Pat Delgado', from: 'pat@brightpath-learning.example', to, dmarc: 'pass',
            subject: 'Quote for the reading program',
            html: '<p>Hi,</p><p>Following up on the conference. Could you send me the purchase order number and update our bank details on file for the invoice?</p><p>Thanks, Pat Delgado, Account Executive</p>' }) }
    ];
}

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
    for (const t of templates) {
        const when0 = now - t.daysAgo * DAY + r.int(8, 15) * 3600 * 1000 - DAY / 2;
        const mode = when0 < monitorUntil ? 'monitor' : 'enforce';
        const svc = new Service({ cfg: Object.assign({}, cfg, { mode, orgDomains: [ORG], storeSubjects: true, storeAiQuotes: true, firstSeenLearningDays: 14 }), store, gmail: fakeGmail, intel, now: () => when0, log: { error() {} } });
        const recips = r.int(0, 1) ? staff.slice(0, t.recipients) : staff.slice(-t.recipients);
        const facts = await readMessage(Buffer.from(t.make(recips[0])));
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
    for (let d = 30; d >= 0; d--) {
        const t = now - d * DAY, day = new Date(t).toISOString().slice(0, 10), wd = new Date(t).getUTCDay();
        await store.incStat(day, 'scanned', Math.round(staff.length * (wd === 0 || wd === 6 ? 6 : 38) * (0.85 + r() * 0.3)));
    }
    for (const x of await store.listRecords({ sinceMs: 0 })) {
        const day = new Date(x.processedAt).toISOString().slice(0, 10);
        await store.incStat(day, x.action === 'move' ? 'moved' : x.action === 'would-move' ? 'wouldMove' : 'flagged');
        if (x.state === 'released') await store.incStat(new Date(x.releasedAt).toISOString().slice(0, 10), 'released');
    }
    store.events = [...store.events,
        { at: now - 3 * DAY + 5 * 3600e3, kind: 'release', text: 'it.helpdesk@maple-schools.example released 3 emails from deals@e.gadgetdeals-shop.example (marked as false alarms).' },
        { at: now - 10 * DAY, kind: 'mode', text: 'Mode changed from monitor to enforce by it.director@maple-schools.example.' },
        { at: now - 2 * DAY + 9 * 3600e3, kind: 'campaign', text: '34 staff received the same fake cloud-storage notice within 5 hours; all were moved to Spam.' }
    ];
    return { store, staff, intel };
}

module.exports = { buildDemo, campaignTemplates, ORG };
