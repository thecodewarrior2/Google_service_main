'use strict';
// The retraining export (Status → Model health → "Download for retraining"; off until an admin allows it in
// Settings). The emails an admin marked (confirmed as phishing; with a tick, false alarms too) are read
// from Gmail at the moment of the download, one per campaign, and each becomes one line of the
// extension's own training format (tools/ai/data/extra/*.jsonl: { facts, label }): the facts phish-tiny
// read, with the people taken out. The download is the only copy: nothing of the emails is stored.
// docs/RETRAINING.md says how to check the file and train with it.
//
// Taken out, on top of the model's own redaction (addresses keep only their domain; phone numbers and
// long numbers are replaced):
//   - the recipient: their mailbox name and display name become "your name", as the model sees them;
//   - the other people in To, Cc and Reply-To, and the names after Mr./Ms./Dr., greetings and
//     sign-offs: [NAME];
//   - the sender's name and address when the sender is inside the organization, or when the email is
//     genuine (a false alarm is a real person's or company's mail): [SENDER];
//   - the organization's own domains: [OUR-DOMAIN];
//   - the text past what the model reads (BODY_CHARS).
// Left for a person to decide, marked ⟦like this⟧: other capitalized words that may be names (a
// student named in the text, an attacker using a real leader's name). tools/check-training-file.js
// refuses a file with a mark left, and, with --final, with a placeholder left.
const fs = require('fs');
const path = require('path');
const spruce = require('./engine/spruce');
const { NAMES } = require('./names');

const BODY_CHARS = 1200;        // phish-tiny reads 256 word pieces, its header included: less than this
const OPEN = '⟦', CLOSE = '⟧';
const NAME = '[NAME]', SENDER = '[SENDER]', OUR = '[OUR-DOMAIN]', YOU = 'your name';
const CAP = "\\p{Lu}[\\p{L}\\p{M}'’-]+";

// Words that are capitalized for other reasons (sentence starts, headlines, brands, school and IT
// words): never marked as possible names. A word the same email also has in lower case isn't either.
const COMMON = new Set(`
a about above access accessed account accounts action actions activity additional additionally address admin administration administrator after again against all also always am amount an and announcement
announcements another any app apps april are around as at attached attachment attention august authorized available away back balance bank banking be because been before being below benefits best
better between big billing board both box break bulletin business but button by call calendar campus can cancel card cards care case cash center centre change changed changes check checking
chief children christmas city claim class classroom click client cloud code codes college company complete conference confirm confirmation congratulations contact continue contract copyright
corp corporation could county credit customer customers daily data day days dead deadline deal deals dear debit december delivery department deposit desk details did digital direct director discount
district do document documents does done down download due during each early easter education elementary email emails employee employees end enrollment event events every exclusive executive
expire expired expires expiration expiring fall false family families faculty february file files final finance first for form forms free friday friend friends from full further get gift give
global go good google got grade grades great greetings group groups had has have hello help helpdesk here hey hi high holiday holidays home hour hours how however hr human if important in inbox inc
information info international invoice invoices is it its january job july june just keep kind last learn learning let library limited link links llc locked log login ltd mail mailbox make management
manager march may meeting meetings member members message messages middle minute minutes mobile monday money month months more morning most must my need needed network new news newsletter
next night no not notice november now number october of off offer offers office officer official on once one online only open operations or order orders other our out over overdue own package
paid parent parents password passwords pay payable payment payments payroll pdf people period phone pin plan plans please policy portal premium president price principal privacy prize
program programs project proposal purchase purchasing question questions quick quote ready receipt receivable recent register registration regards reminder renew renewal reply report reports
request requested requests required reserved reset resources response review reward rewards rights safety saturday save scan scanned schedule school schools secretary secure security see
september server service services session share shared shipping sign signed signin since sincerely site social soon space special specialist spring staff start state statement status still
storage student students subject submit subscription summer sunday superintendent support sure survey suspended system systems tax taxes teacher teachers team teams technology terms than thank
thanks that the their them then there these they this those thursday time times to today together tomorrow tonight total tracking transfer transportation tuesday unauthorized under
university unlock unsubscribe until unusual up update updated upgrade urgent us use user users valued verification verified verify very view voicemail wait want was we web website wednesday week
weekly weeks welcome were what when where which while who why will winter wire with within without work would year years yes yet you your yours
mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec
microsoft outlook onedrive sharepoint exchange windows azure gmail drive docs sheets slides meet chromebook chrome workspace apple icloud iphone ipad itunes paypal venmo zelle amazon prime aws
netflix hulu disney spotify docusign dropbox adobe acrobat zoom webex slack canvas schoology clever powerschool skyward infinite remind classdojo seesaw walmart target costco ebay fedex ups usps dhl
irs ssa medicare chase wells fargo citi citibank capital discover visa mastercard american express amex norton mcafee geek squad coinbase bitcoin crypto facebook meta instagram whatsapp linkedin
twitter tiktok youtube yahoo aol verizon comcast xfinity spectrum att sprint roku lenovo dell samsung
mr mrs ms miss mx dr prof sir madam coach
signature signatures list lists bonus notification notifications invitation invite approval approved pending voice video videos photo photos folder trial membership points shop store sales parcel
page profile settings options preferences manage browser install device devices computer laptop tablet wifi internet faq conditions legal disclaimer confidential confidentiality trademark
registered license licensed authorized safe protected protection fraud scam spam phishing virus malware warning caution external internal sender recipient fwd attachments doc docx xls xlsx zip
image images picture pictures logo tap press annual quarterly monthly hourly seconds asap later late previous current latest cancellation refund return exchange transaction transactions bill
receipts fee fees charge charges subtotal coupon promo voucher winner won win lottery sweepstakes selected chosen eligible qualify qualified limited vip gold silver elite plus pro ultra super mega
top amazing incredible huge massive lowest cheapest savings percent bargain clearance flash hot trending popular featured recommended arrivals collection edition lifetime unlimited subscribe
subscriber pricing webinar workshop training course courses classes lesson lessons certificate certification degree diploma transcript application apply admission admissions scholarship
grant loan loans aid financial live channels channel smart android stick flexible entertainment sports music movies series shows news weather traffic
following attached unfortunately regarding kindly note sorry looking forward interested wondering enclosed many much others every everyone anyone someone nothing something everything anything
okay absolutely certainly definitely maybe perhaps actually really simply basically finally meanwhile otherwise instead besides moreover furthermore thus hence therefore accordingly
although though even whether unless whenever wherever whose ask asked become begin bring buy choose come consider create discover earn enjoy enter explore follow forward grab hurry join look
love meet pick play protect provide read receive remember remove reserve return select send shop show stay stop take tell try turn visit watch answer
`.split(/\s+/).filter(Boolean));
// First names that are also everyday words: replaced only where they are capitalized or in capitals.
const EVERYDAY = new Set('will mark bill grace hope joy rose may june april art frank faith chase hunter summer sky dawn rich page ray gene dean sue max guy pat rob jack sandy carol crystal amber ruby pearl iris holly ivy lily daisy violet autumn river stone wood woods young king brown white black green gray grey rice price long short love hall hill field fields banks park parks lane ford cook baker miller'.split(' '));
const GREETING_OK = new Set('team all everyone staff parents families family customer customers sir madam friend friends colleagues colleague user users member members valued teachers students folks there guest guests partner partners client clients'.split(' '));

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (name) => String(name || '').split(/[^\p{L}\p{M}'’-]+/u).map(w => w.replace(/^['’-]+|['’-]+$/g, '')).filter(w => w.length >= 3 && !COMMON.has(w.toLowerCase()));

// Replaces a name (a whole phrase or one word) wherever it appears as whole words. Case doesn't matter,
// except for names that are everyday words ("Will", "Grace"): those only where capitalized.
function replaceName(text, name, by) {
    const n = String(name || '').trim();
    if (n.length < 3) return text;
    const everyday = EVERYDAY.has(n.toLowerCase());
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(n)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    return text.replace(re, (m, pre, w) => (everyday && !(/^\p{Lu}/u.test(w)) ? m : `${pre}${by}`));
}
// The parts of a person's mailbox name (jordan.smith → jordan, smith); none for a shared mailbox.
function addressParts(E, address) {
    const a = String(address || '').toLowerCase();
    if (!a.includes('@') || E.isSharedMailbox(a)) return [];
    return a.split('@')[0].split(/[._+-]+/).filter(p => /^\p{L}{3,}$/u.test(p) && !COMMON.has(p));
}
function replaceOrg(text, orgDomains) {
    let t = String(text || '');
    for (const d of orgDomains || []) {
        if (!d) continue;
        t = t.replace(new RegExp(`(^|[^a-z0-9-])((?:[a-z0-9-]+\\.)*)${esc(d)}(?![a-z0-9-])`, 'gi'), `$1$2${OUR}`);
    }
    return t;
}

// Names after a title, in greetings and after sign-offs: [NAME] (unless the "name" is a common word:
// "Don't Miss Out", "Dear Valued Customer", "Thanks! Click here").
const TITLE_RE = new RegExp(`(^|[^\\p{L}])(Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Coach)(\\.?[ \\t]+)(${CAP}(?:[ \\t]+${CAP})?)`, 'gu');
const GREET_RE = new RegExp(`(^|[^\\p{L}])(Hi|Hello|Hey|Dear|Good morning|Good afternoon|Good evening|Greetings)([ \\t]+)(${CAP}(?:[ \\t]+${CAP})?)`, 'gu');
const SIGN_RE = new RegExp(`(^|[^\\p{L}])(Thank you|Thanks|Many thanks|Best regards|Kind regards|Warm regards|Best wishes|All the best|Regards|Sincerely|Respectfully|Cheers|Best|Take care|Warmly)(\\s*[,!.—–-]+\\s*|\\s*\\n\\s*)(${CAP}(?:\\s+${CAP}){0,2})`, 'gu');
function namedPhrases(text) {
    const keepCommon = (pre, lead, sep, run, okSet) => {
        const ws = run.split(/\s+/);
        const n = ws.findIndex(w => COMMON.has(w.toLowerCase()) || (okSet && okSet.has(w.toLowerCase())));
        if (n === 0) return null;                                   // not a name
        return `${pre}${lead}${sep}${NAME}${n > 0 ? ` ${ws.slice(n).join(' ')}` : ''}`;
    };
    return String(text)
        .replace(TITLE_RE, (m, pre, t, sep, run) => keepCommon(pre, t, sep, run) || m)
        .replace(GREET_RE, (m, pre, g, sep, run) => keepCommon(pre, g, sep, run, GREETING_OK) || m)
        .replace(SIGN_RE, (m, pre, s, sep, run) => keepCommon(pre, s, sep, run) || m);
}

// Other capitalized words that may be names: ⟦marked⟧ for a person to decide. In a sentence, a
// capitalized word is marked unless it is a common word, the same email has it in lower case, or it is
// in the email's own domains (a brand: "Harbor" from harbor-supply.example). At the start of a sentence
// or in a headline (most words capitalized), only a common name (src/names.js) or a word that isn't an
// everyday one (not in the model's vocabulary) is marked; so is a capitalized word right after a marked
// one ("Tyler Brown"). Words in capitals and placeholders are left as they are.
let vocab = null;
function vocabulary() {
    if (!vocab) {
        const file = path.resolve(__dirname, '..', 'vendor', 'spruce', 'models', 'phish-tiny', 'vocab.txt');
        vocab = new Set(fs.readFileSync(file, 'utf8').split('\n').map(w => w.trim()).filter(w => w && !w.startsWith('##') && !w.startsWith('[')));
    }
    return vocab;
}
const WORD_RE = /(?<![\p{L}\p{N}[⟦_])\p{L}[\p{L}\p{M}'’-]*(?![\p{L}\p{N}\]])/gu;
const lowerWords = (text) => (String(text || '').match(/(?<![\p{L}\p{N}])\p{Ll}[\p{L}'’-]*/gu) || []).map(w => w.toLowerCase());
function markNames(text, domains, ownNames, lower) {
    const V = vocabulary();
    const segment = (seg) => {
        const ws = seg.match(WORD_RE) || [];
        const headline = ws.length >= 3 && ws.filter(w => /^\p{Lu}/u.test(w)).length / ws.length >= 0.75;
        let i = 0, lastEnd = -1, prevMarked = false;
        return seg.replace(WORD_RE, (w, offset) => {
            const first = i++ === 0;
            const next = prevMarked && lastEnd >= 0 && /^[ \t]+$/.test(seg.slice(lastEnd, offset));
            lastEnd = offset + w.length;
            // (Tyler's → Tyler; We've, Don't → We, Do)
            const base = w.replace(/['’](?:s|ve|re|ll|d|m)$/iu, '').replace(/n['’]t$/iu, '').replace(/[-'’]+$/u, '');
            const l = base.toLowerCase();
            let mark = false;
            if (!/^\p{Lu}/u.test(w) || base.length < 3 || base === base.toUpperCase()) mark = false;
            else if (ownNames.has(l)) mark = true;          // the organization's own name (maple from maple-schools.example)
            else if (!COMMON.has(l) && !lower.has(l) && !l.split(/[-'’]/).every(p => COMMON.has(p)) && !domains.some(d => d.includes(l))) {
                mark = next || (first || headline ? NAMES.has(l) || !V.has(l) : true);
            }
            prevMarked = mark;
            return mark ? `${OPEN}${w}${CLOSE}` : w;
        });
    };
    return String(text).replace(/[^.!?\n]+[.!?\n]*|[.!?\n]+/g, segment)
        .replace(new RegExp(`${CLOSE}([ \t]+)${OPEN}`, 'gu'), '$1')
        // the capitalized word just before a marked one belongs to it (Pat ⟦Delgado⟧ → ⟦Pat Delgado⟧)
        .replace(/(?<![\p{L}\p{N}[⟦_])(\p{Lu}[\p{L}\p{M}'’-]+)([ \t]+)⟦/gu, (m, w, sp) => (COMMON.has(w.toLowerCase()) ? m : `${OPEN}${w}${sp}`));
}

const cut = (t, n) => { const s = String(t || ''); if (s.length <= n) return s; const c = s.slice(0, n); const sp = c.search(/\s\S*$/); return sp > n * 0.8 ? c.slice(0, sp) : c; };

// One email → one training example. aiFacts: what the model read (analyze with keepAiFacts); people:
// mime.readMessage's people; mailbox: the recipient; label: 1 phishing, 0 genuine.
function deidentify(aiFacts, { people = {}, mailbox = '', orgDomains = [], label }) {
    const E = spruce.load();
    const f = aiFacts || {};
    const me = String(mailbox || '').toLowerCase();
    const all = [...(people.to || []), ...(people.cc || []), ...(people.replyTo || [])];
    const myNames = all.filter(p => p.address === me).map(p => p.name).filter(Boolean);
    const others = all.filter(p => p.address && p.address !== me);
    const sender = String(f.senderAddress || '').toLowerCase();
    const dropSender = label === 0 || f.org === 'inside';
    const sharedMe = !me || E.isSharedMailbox(me);
    // Whole names first, then their words; the longest first.
    const swaps = [];
    for (const n of myNames) { swaps.push([n, YOU]); if (!sharedMe) for (const w of words(n)) swaps.push([w, YOU]); }
    for (const p of addressParts(E, me)) swaps.push([p, YOU]);
    for (const p of others) {
        if (p.address === sender) continue;
        if (p.name) { swaps.push([p.name, NAME]); for (const w of words(p.name)) swaps.push([w, NAME]); }
        for (const w of addressParts(E, p.address)) swaps.push([w, NAME]);
    }
    if (dropSender) {
        if (f.senderName) { swaps.push([f.senderName, SENDER]); for (const w of words(f.senderName)) swaps.push([w, SENDER]); }
        for (const w of addressParts(E, sender)) swaps.push([w, SENDER]);
    }
    const ordered = swaps.filter(([n]) => String(n).trim().length >= 3).sort((a, b) => b[0].length - a[0].length);
    const domains = [sender.split('@')[1] || '', ...(f.links || []).flatMap(l => [l.host, l.destHost])].filter(Boolean).map(d => d.toLowerCase());
    // Words the email also has in lower case, anywhere: everyday words, not names.
    const lower = new Set([f.subject, f.senderName, f.bodyText, ...(f.links || []).map(l => l.text)].flatMap(lowerWords));
    // The organization's own name, from its domains (maple-schools.example → maple): always marked.
    const ownNames = new Set(orgDomains.flatMap(d => String(d).toLowerCase().split('.').slice(0, -1)).flatMap(x => x.split('-')).filter(x => x.length >= 3 && !COMMON.has(x) && !/^(k12|edu|org|net|com|gov|us)$/.test(x)));
    const clean = (text, { names = true, mark = true } = {}) => {
        let t = E.redactForAi(String(text || ''));
        t = replaceOrg(t, orgDomains);
        if (me) t = E.maskRecipient(t, me.split('@')[0]);
        for (const [n, by] of ordered) t = replaceName(t, n, by);
        if (names) t = namedPhrases(t);
        if (mark) t = markNames(t, domains, ownNames, lower);
        return t;
    };
    const local = sender.split('@')[0], domain = sender.split('@')[1] || '';
    const out = {
        subject: clean(cut(f.subject, 200)),
        senderName: dropSender ? (f.senderName ? SENDER : '') : clean(cut(f.senderName, 80)),
        senderAddress: sender ? `${E.isSharedMailbox(sender) ? local : 'sender'}@${replaceOrg(domain, orgDomains)}` : '',
        auth: f.auth && f.auth.dmarc ? { dmarc: f.auth.dmarc } : null,
        links: (f.links || []).slice(0, 8).map(l => ({ text: clean(cut(l.text, 60)), host: replaceOrg(l.host || '', orgDomains), destHost: replaceOrg(l.destHost || '', orgDomains), finding: clean(l.finding || '', { names: false, mark: false }) })),
        bodyText: clean(cut(f.bodyText, BODY_CHARS))
    };
    if (f.org) out.org = f.org;
    if (f.layout && f.layout.length) out.layout = f.layout.slice();
    if (f.mailChecks && f.mailChecks.length) out.mailChecks = f.mailChecks.slice();
    return out;
}

// The records to export: marked by an admin (confirmed phishing, and false alarms when asked), one per
// campaign (copies of one email would count it many times), newest first. Each campaign comes with its
// copies, newest first, so a copy deleted since can be replaced by another. A campaign marked both ways
// is left out: its label isn't sure. An email the service judged comes before a copy an admin's search
// found.
function pickRecords(records, { falseAlarms = false } = {}) {
    const marked = records.filter(r => r.markedBy && r.messageId && r.user && (r.falseAlarm === false || (falseAlarms && r.falseAlarm === true)));
    const labelsOf = new Map();
    for (const r of records.filter(x => x.markedBy && typeof x.falseAlarm === 'boolean')) {
        const k = r.campaign || r.key;
        labelsOf.set(k, (labelsOf.get(k) || new Set()).add(r.falseAlarm));
    }
    const groups = new Map();
    let conflicting = 0;
    for (const r of marked.slice().sort((a, b) => (a.trigger === 'admin') - (b.trigger === 'admin') || b.processedAt - a.processedAt)) {
        const k = r.campaign || r.key;
        if (labelsOf.get(k).size > 1) { if (!groups.has(k)) { groups.set(k, null); conflicting++; } continue; }
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    return { groups: [...groups.values()].filter(Boolean).sort((a, b) => b[0].processedAt - a[0].processedAt), conflicting };
}

// A short note for the person checking the file; nothing personal.
function noteFor(rec, label) {
    const ai = rec.ai && typeof rec.ai.probability === 'number' ? `, AI ${Math.round(rec.ai.probability * 100)}%` : '';
    const act = { move: 'moved to Spam', 'would-move': 'would have been moved (monitor mode)', flag: 'flagged, not moved' }[rec.action] || rec.action || 'recorded';
    const score = typeof rec.score === 'number' ? `, rules score ${rec.score}` : '';
    return `${label ? 'Confirmed as phishing or spam by an admin' : 'A false alarm (genuine mail), marked by an admin'}. On arrival: ${act}; trigger ${rec.trigger || 'none'}${score}${ai}.`;
}

function example(rec, label, aiFacts, people, orgDomains) {
    return { name: `spruce-${rec.messageId}`, label, note: noteFor(rec, label), facts: deidentify(aiFacts, { people, mailbox: rec.user, orgDomains, label }) };
}

const toJsonl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

// What tools/check-training-file.js looks for. Each: [kind, regex, what to do].
const LEFTOVERS = [
    ['mark', /⟦[^⟧]*⟧?/u, 'a ⟦marked⟧ word: replace it with [NAME] (or a made-up name) if it is a person, school or place that identifies someone; otherwise take the marks away'],
    ['address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, 'an email address: keep only its domain ("address at example.org")'],
    ['phone', /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/, 'a phone number: write "phone number"'],
    ['number', /\b\d[\d -]{5,}\d\b/, 'a long number (an account, card, student ID or code): write "number"']
];
const PLACEHOLDERS = /\[(NAME|SENDER|OUR-DOMAIN|SCHOOL|PLACE)\]/;

// The problems in one example (an object), for the check tool. final: placeholders must be gone too.
function problems(x, { final = false } = {}) {
    const out = [];
    if (!x || typeof x !== 'object') return ['not a JSON object'];
    if (x.label !== 0 && x.label !== 1) out.push('label must be 0 (genuine) or 1 (phishing)');
    if (typeof x.text === 'string') out.push('has "text": make-dataset.js would use it instead of the facts; remove it');
    const f = x.facts;
    if (!f || typeof f !== 'object') { out.push('no "facts"'); return out; }
    if (f.recipient) out.push('has "recipient": remove it (the export never has one)');
    const fields = [['subject', f.subject], ['senderName', f.senderName], ['senderAddress', f.senderAddress], ['bodyText', f.bodyText],
        ...(Array.isArray(f.links) ? f.links : []).flatMap((l, i) => [[`links[${i}].text`, l && l.text], [`links[${i}].host`, l && l.host], [`links[${i}].destHost`, l && l.destHost], [`links[${i}].finding`, l && l.finding]])];
    for (const [where, v] of fields) {
        const s = String(v || '');
        for (const [kind, re, fix] of LEFTOVERS) {
            if (kind === 'address' && where === 'senderAddress') continue;
            const m = re.exec(s);
            if (m) out.push(`${where}: ${fix} (found "${m[0].slice(0, 40)}")`);
        }
        if (final) { const m = PLACEHOLDERS.exec(s); if (m) out.push(`${where}: ${m[0]} is still there: replace it with a made-up one`); }
    }
    if (f.senderAddress && !/^[^@\s]+@[^@\s]+$/.test(String(f.senderAddress))) out.push('senderAddress must look like name@domain');
    return out;
}

module.exports = { deidentify, pickRecords, example, noteFor, toJsonl, problems, BODY_CHARS, COMMON };
