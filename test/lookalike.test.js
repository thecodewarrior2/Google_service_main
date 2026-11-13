'use strict';
// 0.5.36: the look-alike watch. Look-alikes of the organization's domains are asked of a DNS resolver, a
// pass a day; the first pass takes stock without alerts; a look-alike that appears afterwards (or was
// registered in the last 30 days) is an alert and a strong sign in mail; an admin can mark each one.
// Every domain and address here is made up (lookups answered by a fake resolver).
const test = require('node:test');
const assert = require('node:assert');
const spruce = require('../src/engine/spruce');
const L = require('../src/lookalike');
const { MemoryStore } = require('../src/store/memory');
const { Service } = require('../src/pipeline');
const { loadConfig } = require('../src/config');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');

const E = spruce.load();
const ORG = 'maple-schools.example';
const DAY = 24 * 3600 * 1000;
const silent = { error() {}, warn() {} };

test('the candidates: typing and look-alike variants, other endings, a district\'s usual forms; never your own domains', () => {
    const k12 = L.variantsOf(E, ['hardee.k12.fl.us']);
    for (const d of ['hardee-k12.org', 'hardeek12.com', 'hardeeschools.org', 'hardee-schools.com', 'hardee-k12-fl.com', 'hardeek12fl.org', 'hardee.org', 'harde.com', 'hardeee.org', 'hadree.com', 'hardee-payroll.com'])
        assert.ok(k12.includes(d), d);
    assert.ok(!k12.includes('hardee.k12.fl.us') && !k12.some(d => d.endsWith('.k12.fl.us')), 'nothing under k12.fl.us (only the state registers there)');
    const own = L.variantsOf(E, [ORG, 'maple-schools.org']);
    for (const d of ['maple-schools.com', 'mapleschools.example', 'maple-schoo1s.example', 'maple-schoools.example', 'maple-schools-k12.org', 'maple-schoolsk12.com', 'maple-schools-hr.net'])
        assert.ok(own.includes(d), d);
    assert.ok(!own.includes(ORG) && !own.includes('maple-schools.org'), 'never one of your own');
    assert.ok(!own.some(d => /schoolsschool/.test(d)), 'a word the name already has isn\'t added');
    assert.ok(own.every(d => /^[a-z0-9-]+\.[a-z.]+$/.test(d) && !/^-|-\./.test(d)), 'valid names only');
    assert.deepEqual(L.variantsOf(E, [ORG]), L.variantsOf(E, [ORG]), 'the same list every time');
    assert.equal(L.weightOf({ status: 'new' }), 'strong');
    assert.equal(L.weightOf({ status: 'baseline' }), 'weak');
    assert.equal(L.weightOf({ status: 'ours' }), null);
    assert.equal(L.weightOf({ status: 'new', gone: 1 }), null);
});

test('the DNS check: NXDOMAIN is "doesn\'t exist"; a name with mail servers and a website; a failed lookup is unknown', async () => {
    const answers = {
        'NS:gone.example': { Status: 3 },
        'NS:here.example': { Status: 0, Answer: [{ type: 2, data: 'ns1.host.example.' }] },
        'MX:here.example': { Status: 0, Answer: [{ type: 15, data: '10 mx.host.example.' }] },
        'A:here.example': { Status: 0, Answer: [{ type: 1, data: '192.0.2.10' }] },
        'NS:nullmx.example': { Status: 0 }, 'MX:nullmx.example': { Status: 0, Answer: [{ type: 15, data: '0 .' }] }, 'A:nullmx.example': { Status: 0 }
    };
    const http = { request: async (url) => { const u = new URL(url); const a = answers[`${u.searchParams.get('type')}:${u.searchParams.get('name')}`]; if (u.searchParams.get('name') === 'broken.example') return { ok: false, status: 503 }; return { ok: true, status: 200, json: async () => a || { Status: 0 } }; } };
    const check = L.createDnsCheck({ http });
    assert.deepEqual(await check('gone.example'), { exists: false });
    assert.deepEqual(await check('here.example'), { exists: true, mx: true, web: true });
    assert.deepEqual(await check('nullmx.example'), { exists: true, mx: false, web: false }, 'a null MX accepts no mail');
    assert.equal(await check('broken.example'), null);
});

function setup(env = {}) {
    let now = Date.UTC(2026, 10, 2, 9);
    const exists = new Map([['maple-schools.com', { exists: true, mx: true, web: true }], ['mapleschools.example', { exists: true, mx: false, web: true }], ['maple-schools-k12.org', { exists: true, mx: true, web: false }]]);
    const ages = { 'maple-schools.com': 4000, 'mapleschools.example': 900, 'maple-schools-k12.org': 5 };
    const asked = [];
    const intel = {
        dnsCheck: async (d) => { asked.push(d); return exists.get(d) || { exists: false }; },
        rdap: { ageDays: async (d) => (d in ages ? ages[d] : null) }
    };
    const store = new MemoryStore();
    const cfg = loadConfig(Object.assign({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `a@${ORG}`, ALERT_EMAIL: `it@${ORG}` }, env));
    const svc = new Service({ cfg, store, gmail: {}, intel, now: () => now, log: silent });
    return { svc, store, exists, ages, asked, clock: { add: (ms) => { now += ms; }, get: () => now } };
}
const runPass = async (t) => { let r; do { r = await t.svc.lookalikeStep({ budgetMs: 60000 }); } while (r && !r.idle && r.cursor < r.of); return r; };

test('the first pass takes stock without alerts (except a name registered in the last 30 days); a name that appears later is an alert', async () => {
    const t = setup();
    const first = await t.svc.lookalikeStep({ budgetMs: 60000 });
    assert.equal(first.asked, 80, 'about 80 an hour');
    await runPass(t);
    const w = await t.store.getState('lookalikeWatch');
    assert.equal(w.baselineDone, true);
    assert.equal(w.passes, 1);
    assert.deepEqual(Object.values(w.found).map(e => [e.domain, e.status]).sort(), [['maple-schools-k12.org', 'new'], ['maple-schools.com', 'baseline'], ['mapleschools.example', 'baseline']]);
    let alerts = (await t.store.listEvents(0)).filter(e => e.kind === 'lookalike');
    assert.equal(alerts.length, 1, 'only the one registered 5 days ago');
    assert.match(alerts[0].text, /maple-schools-k12\.org \(mail servers: yes; a website: no; registered 5 days ago\).*Status → Look-alikes/);
    // Within the day: nothing more asked.
    t.clock.add(3 * 3600e3);
    assert.deepEqual(await t.svc.lookalikeStep(), { idle: true });
    // The next day a new one exists; one has gone.
    t.clock.add(DAY);
    t.exists.set('maple-schoo1s.example', { exists: true, mx: true, web: true });
    t.exists.delete('mapleschools.example');
    await runPass(t);
    const w2 = await t.store.getState('lookalikeWatch');
    assert.equal(w2.found['maple-schoo1s.example'].status, 'new');
    assert.ok(w2.found['mapleschools.example'].gone);
    alerts = (await t.store.listEvents(0)).filter(e => e.kind === 'lookalike');
    assert.equal(alerts.length, 2);
    assert.ok(alerts.some(a => /^A domain that imitates yours was registered: maple-schoo1s\.example/.test(a.text)), 'the new one');
    // In mail: strong for the new ones, a small sign for one there before, none for a gone one.
    const map = await t.svc.lookalikeMap();
    assert.deepEqual([...map.entries()].sort(), [['maple-schoo1s.example', 'strong'], ['maple-schools-k12.org', 'strong'], ['maple-schools.com', 'weak']]);
});

test('in mail: from, replying to or linking to a watched look-alike; strong evidence when new', async () => {
    const mail = (from, extra = []) => readMessage(Buffer.from([`From: Payroll <${from}>`, `To: pat@${ORG}`, 'Subject: Direct deposit update', ...extra,
        'Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass', 'Content-Type: text/html; charset=utf-8', '', '<p>Please confirm your direct deposit details by Friday.</p><p><a href="https://portal.maple-schools.com/login">Staff portal</a></p>'].join('\r\n')));
    const lookalikes = new Map([['maple-schools-k12.org', 'strong'], ['maple-schools.com', 'weak']]);
    const r1 = await analyze(await mail('payroll@maple-schools-k12.org'), { mailbox: `pat@${ORG}`, orgDomains: [ORG], lookalikes });
    const kinds = (r) => r.signals.map(s => `${s.kind}:${s.weight}`).filter(k => /lookalike/.test(k));
    assert.deepEqual(kinds(r1), ['watched-lookalike-sender:5', 'known-lookalike-link:2']);
    assert.ok(r1.confirmedBy.some(c => /newly registered look-alike/.test(c)));
    const r2 = await analyze(await mail('pay@payroll-services.example', ['Reply-To: hr@maple-schools-k12.org']), { mailbox: `pat@${ORG}`, orgDomains: [ORG], lookalikes });
    assert.ok(kinds(r2).includes('watched-lookalike-reply-to:5'));
    const r3 = await analyze(await mail('pay@payroll-services.example'), { mailbox: `pat@${ORG}`, orgDomains: [ORG] });
    assert.deepEqual(kinds(r3), [], 'without the watch: none');
});

test('an admin\'s mark: ours or harmless takes the sign away, a threat makes it strong, watch puts it back; noted in Activity', async () => {
    const t = setup();
    await runPass(t);
    const by = `it.director@${ORG}`;
    assert.equal((await t.svc.markLookalike('maple-schools-k12.org', 'ours', by)).entry.status, 'ours');
    assert.ok(!(await t.svc.lookalikeMap()).has('maple-schools-k12.org'));
    assert.equal((await t.svc.markLookalike('maple-schools.com', 'threat', by)).entry.status, 'threat');
    assert.equal((await t.svc.lookalikeMap()).get('maple-schools.com'), 'strong');
    assert.equal((await t.svc.markLookalike('maple-schools.com', 'watch', by)).entry.status, 'baseline', 'back to what the watch found it as');
    assert.equal((await t.svc.markLookalike('maple-schools-k12.org', 'watch', by)).entry.status, 'new');
    assert.equal((await t.svc.markLookalike('nothing.example', 'ours', by)).status, 404);
    assert.equal((await t.svc.markLookalike('maple-schools.com', 'delete', by)).status, 400);
    const notes = (await t.store.listEvents(0)).filter(e => e.kind === 'lookalike-mark');
    assert.ok(notes.length === 4 && notes.every(e => e.admin));
    assert.match(notes.map(e => e.text).join('\n'), /it\.director@maple-schools\.example marked the look-alike maple-schools-k12\.org as the district's own \(no sign in mail\)/);
});

test('off (LOOKALIKE_WATCH=off): nothing asked', async () => {
    const t = setup({ LOOKALIKE_WATCH: 'off' });
    assert.equal(await t.svc.lookalikeStep(), null);
    assert.equal(t.asked.length, 0);
});
