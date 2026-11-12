'use strict';
// 0.5.10: Review decides the copies of one email together; "…show more" reads what the AI reads (from Gmail,
// nothing stored); the colleague-name check knows the directory's names (as hashes only); an email the
// model can't read (not English) gets no AI score, and says why.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp, reviewGroups } = require('../src/server');
const { loadConfig } = require('../src/config');
const { buildDemo, campaignTemplates, directoryNames } = require('../src/demo/seed');
const { Service } = require('../src/pipeline');
const { MemoryStore } = require('../src/store/memory');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const { detectLanguage } = require('../src/engine/language');

const ORG = 'maple-schools.example';
async function serve(app) {
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, r));
    return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) };
}
const ts = Object.fromEntries(campaignTemplates().map(t => [t.id, t]));

test('language: clearly another language is not English (script or common words); English, bilingual and short texts are read', () => {
    const not = {
        es: 'Estimado cliente, su cuenta ha sido suspendida temporalmente. Para restablecer el acceso, haga clic en el enlace y confirme su información de pago lo antes posible. Gracias por su atención.',
        pt: 'Prezado cliente, sua conta foi bloqueada. Para desbloquear, clique aqui e confirme os seus dados. Obrigado pela sua atenção e pela confiança em nossos serviços.',
        fr: 'Bonjour, votre compte a été suspendu. Pour le réactiver, cliquez ici et confirmez vos informations dans les 24 heures. Merci de votre confiance et à bientôt.',
        vi: 'Kính gửi phụ huynh, nhà trường xin thông báo về lịch họp phụ huynh của các em học sinh trong tuần tới. Vui lòng xác nhận tham dự. Xin cảm ơn quý vị.',
        zh: '尊敬的用户，您的账户存在异常登录，请立即点击下方链接验证您的身份，否则账户将被冻结。',
        ja: 'お客様のアカウントに不正なログインがありました。下のリンクから本人確認をしてください。',
        ru: 'Уважаемый клиент, ваш аккаунт заблокирован. Пожалуйста, подтвердите свои данные по ссылке ниже в течение 24 часов.',
        ar: 'عزيزي العميل، تم تعليق حسابك مؤقتا. يرجى تأكيد معلوماتك عبر الرابط أدناه خلال 24 ساعة.'
    };
    for (const [code, text] of Object.entries(not)) {
        const r = detectLanguage(text);
        assert.equal(r.english, false, code);
        assert.equal(r.code, code, `${code}: ${JSON.stringify(r)}`);
    }
    const read = {
        phishing: 'Your mailbox is almost full. Please verify your account within 24 hours or it will be suspended. Click here to keep your messages and avoid losing access to your email.',
        genuine: 'Hi team, the field trip forms are due on Friday. Please send them to the office with the signed permission slip and the lunch order. Thanks for all your help this week.',
        bilingual: 'Dear families, the school will be closed on Monday for the holiday. Please make sure your child returns the permission form. Estimadas familias, la escuela estará cerrada el lunes por el feriado. Por favor asegúrese de que su hijo devuelva el formulario.',
        lookalikeLetters: 'Your Pаypal аccount hаs been limited. Plеase confirm your identity to restore full access to your account today.',
        short: 'Invoice attached'
    };
    for (const [k, text] of Object.entries(read)) assert.equal(detectLanguage(text).english, true, k);
});

test('an email in another language: the rule checks run, the AI gives no score and says why; English mail is scored', async () => {
    const es = await analyze(await readMessage(Buffer.from(ts.spanish.make(`sam.okafor@${ORG}`))), { mailbox: `sam.okafor@${ORG}`, orgDomains: [ORG] });
    assert.equal(es.ai.probability, null);
    assert.equal(es.ai.skipped, 'language');
    assert.equal(es.ai.language, 'Spanish');
    assert.equal(es.language.english, false);
    assert.ok(es.score > 0 && es.signals.length > 0, 'the rules still found signs');
    const en = await analyze(await readMessage(Buffer.from(ts.microsoft.make(`sam.okafor@${ORG}`))), { mailbox: `sam.okafor@${ORG}`, orgDomains: [ORG] });
    assert.equal(typeof en.ai.probability, 'number');
    assert.equal(en.language.english, true);
});

test('the colleague-name check: the directory\'s names as one-way hashes; an outside sender using one is a sign, an inside one isn\'t', async () => {
    const store = new MemoryStore();
    let reads = 0;
    const names = ['Jordan Whitfield', 'Sam Okafor'];
    const gmail = { labelId: async (u, n) => `L_${n}`, modify: async () => ({}), userNames: async () => { reads++; return names; } };
    let t = Date.now();
    const cfg = loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `sam.okafor@${ORG}`, DIRECTORY_ADMIN: `spruce-directory@${ORG}` });
    const svc = new Service({ cfg, store, gmail, now: () => t });
    const hashes = await svc.colleagueNames();
    assert.equal(hashes.size, 2);
    assert.ok(![...hashes].some(h => /jordan|whitfield|okafor/i.test(h)), 'only hashes are kept');
    const state = await store.getState('colleagueNames');
    assert.deepEqual([state.names, state.error], [2, null]);
    assert.ok(!JSON.stringify(state).match(/jordan|whitfield/i), 'no name in the stored state');
    await svc.colleagueNames(); t += 11 * 3600e3; await svc.colleagueNames();
    assert.equal(reads, 1, 'kept 12 hours');
    t += 2 * 3600e3; await svc.colleagueNames();
    assert.equal(reads, 2, 'read again after 12 hours');

    const facts = await readMessage(Buffer.from(ts.colleague.make(`sam.okafor@${ORG}`)));
    const out = await analyze(facts, { mailbox: `sam.okafor@${ORG}`, orgDomains: [ORG], colleagues: hashes });
    assert.ok(out.signals.some(s => /name of someone in your organization/.test(s.text) && s.weight === 3), JSON.stringify(out.signals));
    const without = await analyze(facts, { mailbox: `sam.okafor@${ORG}`, orgDomains: [ORG], colleagues: null });
    assert.ok(!without.signals.some(s => /name of someone in your organization/.test(s.text)));
    // "Okafor, Sam" is the same name; from inside the organization it is no sign.
    const inside = await readMessage(Buffer.from(ts.colleague.make(`avery.lee@${ORG}`).replace('"Jordan Whitfield" <jordan.whitfield.office@freemail.example>', `"Okafor, Sam" <sam.okafor@${ORG}>`)));
    assert.ok(!(await analyze(inside, { mailbox: `avery.lee@${ORG}`, orgDomains: [ORG], colleagues: hashes })).signals.some(s => /name of someone in your organization/.test(s.text)));

    // The directory can't be read (no privilege or scope): the check keeps what it had, notes why, never throws.
    const failing = new Service({ cfg, store: new MemoryStore(), gmail: Object.assign({}, gmail, { userNames: async () => { throw new Error('Not Authorized to access this resource/api'); } }), log: { warn() {}, error() {} } });
    assert.equal(await failing.colleagueNames(), null);
    assert.match((await failing.store.getState('colleagueNames')).error, /Not Authorized/);
    // Off without DIRECTORY_ADMIN, or with COLLEAGUE_NAMES=off.
    assert.equal(await new Service({ cfg: loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `sam.okafor@${ORG}` }), store, gmail }).colleagueNames(), null);
    assert.equal(await new Service({ cfg: loadConfig({ STORE: 'memory', ORG_DOMAINS: ORG, PILOT_USERS: `sam.okafor@${ORG}`, DIRECTORY_ADMIN: `d@${ORG}`, COLLEAGUE_NAMES: 'off' }), store, gmail }).colleagueNames(), null);
});

test('review groups: the copies of one campaign are one item (its keys, recipients and senders), in the queue\'s order', () => {
    const rec = (key, campaign, user, from) => ({ key, campaign, campaignLabel: campaign ? `label ${campaign}` : '', user, sender: { address: from } });
    const g = reviewGroups([rec('k1', 'c1', 'a@x', 's1@y'), rec('k2', null, 'b@x', 's2@y'), rec('k3', 'c1', 'c@x', 's3@y'), rec('k4', 'c1', 'a@x', 's1@y'), rec('k5', null, 'd@x', 's4@y')]);
    assert.deepEqual(g.map(x => x.keys), [['k1', 'k3', 'k4'], ['k2'], ['k5']]);
    assert.deepEqual(g[0].users, ['a@x', 'c@x']);
    assert.deepEqual(g[0].senders, ['s1@y', 's3@y']);
    assert.equal(g[0].count, 3);
});

test('dashboard: the review queue in groups; one decision marks every copy; "…show more" reads the email (nothing stored, noted)', async () => {
    const cfg = loadConfig({ DEMO: '1', MODE: 'monitor', ORG_DOMAINS: ORG });
    const { store, raws, staff } = await buildDemo({ cfg, now: Date.now() });
    const gm = { labelId: async (u, n) => `L_${n}`, modify: async () => ({}), userNames: async () => directoryNames(staff),
        raw: async (u, id) => { const b = raws.get(id); if (!b) throw Object.assign(new Error('not found'), { status: 404 }); return { id, raw: b }; } };
    const service = new Service({ cfg, store, gmail: gm });
    const { base, close } = await serve(createApp({ cfg, store, service }));
    const get = async (p) => (await fetch(base + p)).json();
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'spruce-dashboard' }, body: JSON.stringify(body) });
    try {
        const d = await get('/api/review?days=30');
        assert.ok(d.groups.length < d.total, `${d.groups.length} items for ${d.total} emails`);
        const big = d.groups.find(x => x.keys.length > 2);
        assert.ok(big && big.users.length > 2 && big.campaign, 'a campaign with its recipients');
        assert.equal(d.groups.reduce((a, x) => a + x.keys.length, 0), d.total);
        assert.equal(typeof d.aiSuspicious, 'number', 'every answer gives the suspicious line too');
        // One decision for every copy (the dashboard sends them together).
        const out = await (await post('/api/bulk', { keys: big.keys, action: 'false-alarm' })).json();
        assert.equal(out.done, big.keys.length);
        const after = await get('/api/review?days=30');
        assert.ok(!after.groups.some(x => x.campaign === big.campaign), 'the whole campaign left the queue');

        // "…show more": what the model reads, sentence by sentence, from Gmail now.
        const key = after.groups.find(x => x.campaign).keys[0];
        const before = JSON.stringify(await store.getRecord(key));
        const res = await post('/api/message/context', { key });
        assert.equal(res.status, 200);
        const c = await res.json();
        assert.ok(c.reading && c.reading.head.startsWith('subject:'), JSON.stringify(c).slice(0, 300));
        assert.ok(c.reading.sentences.length > 0 && c.reading.sentences.every(s => typeof s.weight === 'number'));
        assert.ok(!/@/.test(JSON.stringify(c.reading)), 'addresses keep only their domain, as the model reads them');
        assert.equal(JSON.stringify(await store.getRecord(key)), before, 'nothing stored');
        assert.ok((await store.listEvents()).some(e => e.kind === 'check' && /opened what the AI reads of an email/.test(e.text)), 'noted in Activity');
        assert.equal((await post('/api/message/context', { key })).status, 429, 'not twice within seconds');
        // A Spanish email: no reading, and why.
        const es = (await store.listRecords({ sinceMs: 0 })).find(r => /correo-seguro/.test(r.sender.domain));
        assert.equal(es.ai.skipped, 'language');
        const ce = await (await post('/api/message/context', { key: es.key })).json();
        assert.equal(ce.reading, null);
        assert.equal(ce.language.english, false);
        // Deleted for good: said so.
        raws.delete(es.messageId);
        const gone = (await store.listRecords({ sinceMs: 0 })).find(r => r.key !== es.key && /correo-seguro/.test(r.sender.domain));
        raws.delete(gone.messageId);
        const g404 = await post('/api/message/context', { key: gone.key });
        assert.equal(g404.status, 404);
        // The demo's colleague-name campaign carries the sign.
        const col = (await store.listRecords({ sinceMs: 0 })).find(r => /freemail/.test(r.sender.domain) && /Whitfield/.test(r.sender.name));
        assert.ok(col && col.signals.some(s => /name of someone in your organization/.test(s.text)), col && JSON.stringify(col.signals));
    } finally { await close(); }
});
