// Mail Protection Admin: the dashboard page. Plain JavaScript, no libraries, no build step.
// Every value from an email (senders, subjects, reasons) is put on the page as TEXT (textContent,
// createTextNode), never as HTML: email content is written by attackers.
(function () {
    'use strict';
    const $ = (sel, root = document) => root.querySelector(sel);
    const SVG = 'http://www.w3.org/2000/svg';
    const view = () => $('#view');
    let days = 30;
    try { days = Number(localStorage.getItem('spruce.days')) || 30; } catch (e) { /* storage blocked */ }

    // --- Talking to the service (the clickable mockup swaps in window.SPRUCE_API) -------------------
    async function realApi(path, opts = {}) {
        const res = await fetch(path, { method: opts.method || 'GET', credentials: 'same-origin',
            headers: Object.assign({ 'x-requested-with': 'spruce-dashboard' }, opts.body ? { 'content-type': 'application/json' } : {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }
    const api = (path, opts) => (window.SPRUCE_API || realApi)(path, opts);

    // --- Building the page safely ----------------------------------------------------------------
    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : String(v));
        }
        for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
        return el;
    }
    function s(tag, attrs, ...kids) {
        const el = document.createElementNS(SVG, tag);
        for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
        for (const k of kids.flat()) if (k) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
        return el;
    }
    const nf = new Intl.NumberFormat();
    const num = (n) => nf.format(Math.round(n || 0));
    const compact = (n) => (n >= 10000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : num(n));
    const pct = (x, d = 0) => `${(100 * (x || 0)).toFixed(d)}%`;
    const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const ACTION = { move: ['Moved to Spam', 'moved'], 'would-move': ['Would be moved', 'would'], flag: ['Suspicious, not moved', 'flag'] };
    const STATE = { moved: ['In Spam', 'moved'], released: ['Released', 'released'], inbox: ['In Inbox', 'inbox'] };
    const stateOf = (m) => (m.state === 'released' && m.releasedByUser ? ['Moved back by user', 'released'] : STATE[m.state] || [m.state, '']);
    const pill = ([label, cls]) => h('span', { class: `pill ${cls}`, text: label });

    function toast(msg) {
        const t = h('div', { class: 'toast', role: 'status', text: msg });
        document.body.append(t);
        setTimeout(() => t.remove(), 3200);
    }

    // --- Tooltip (one, shared; values lead, names follow) ------------------------------------------
    const tip = () => $('#tip');
    function showTip(evt, title, rows) {
        const t = tip();
        t.textContent = '';
        t.append(h('div', { class: 't-title', text: title }));
        for (const r of rows) {
            const key = h('span', { class: 'key' });
            if (r.color) key.style.background = r.color;
            t.append(h('div', { class: 't-row' }, h('span', {}, r.color ? key : null, r.name), h('b', { text: r.value })));
        }
        t.hidden = false;
        const box = evt.target.getBoundingClientRect();
        const x = evt.clientX || box.left + box.width / 2, y = evt.clientY || box.top;
        const w = t.offsetWidth, hgt = t.offsetHeight;
        t.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 12))}px`;
        t.style.top = `${Math.max(8, y - hgt - 12)}px`;
    }
    const hideTip = () => { tip().hidden = true; };

    // --- Charts ----------------------------------------------------------------------------------
    // Round axis ticks: a step of 1, 2 or 5 × 10ⁿ, four or five of them.
    function niceAxis(v) {
        const raw = Math.max(1, v) / 4;
        const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
        const step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
        const n = Math.max(1, Math.ceil(Math.max(1, v) / step));
        return { max: n * step, step, n };
    }
    // Charts are drawn at the width they get, so their text stays 11px on a phone.
    const chartWidth = () => Math.max(320, Math.min(760, (view().clientWidth || 760) - (window.innerWidth < 900 ? 34 : 420)));
    // A column with a 4px rounded top (the data end) and a square base.
    function colPath(x, y, w, hgt, round) {
        const r = round ? Math.min(4, w / 2, hgt) : 0;
        return `M${x},${y + hgt}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + hgt}Z`;
    }
    // Stacked columns, one per day; series: [{ key, name, color }].
    function stackedColumns(rows, series, { label = 'day' } = {}) {
        const W = chartWidth(), H = 230, L = 38, B = 24, T = 10, R = 8;
        const pw = W - L - R, ph = H - B - T;
        const ax = niceAxis(Math.max(1, ...rows.map(r => series.reduce((a, se) => a + (r[se.key] || 0), 0)))), max = ax.max;
        const band = pw / rows.length, bw = Math.max(3, Math.min(24, band * 0.62));
        const y = (v) => T + ph - (v / max) * ph;
        const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Emails per ${label}, by reason` });
        for (let i = 0; i <= ax.n; i++) {
            const v = ax.step * i, yy = y(v);
            svg.append(s('line', { class: i === 0 ? 'baseline' : 'gridline', x1: L, x2: W - R, y1: yy, y2: yy }));
            svg.append(s('text', { x: L - 6, y: yy + 3.5, 'text-anchor': 'end' }, compact(v)));
        }
        const every = Math.max(1, Math.ceil(rows.length / Math.max(3, Math.floor(pw / 90))));
        rows.forEach((r, i) => {
            const x = L + i * band + (band - bw) / 2;
            let acc = 0;
            const segs = series.filter(se => (r[se.key] || 0) > 0);
            const g = s('g', { class: 'bar', tabindex: 0, role: 'img',
                'aria-label': `${dayLabel(r.day)}: ${series.map(se => `${se.name} ${r[se.key] || 0}`).join(', ')}` });
            segs.forEach((se, j) => {
                const v = r[se.key];
                const y0 = y(acc), y1 = y(acc + v);
                const top = j === segs.length - 1;
                const hgt = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));           // 2px surface gap between segments
                if (hgt > 0) g.append(s('path', { d: colPath(x, y1, bw, hgt, top), fill: css(se.color) }));
                acc += v;
            });
            g.append(s('rect', { class: 'hit', x: L + i * band, y: T, width: band, height: ph }));
            const rowsTip = series.map(se => ({ name: se.name, value: num(r[se.key] || 0), color: css(se.color) }));
            g.addEventListener('pointermove', (e) => showTip(e, dayLabel(r.day), rowsTip));
            g.addEventListener('focus', (e) => showTip(e, dayLabel(r.day), rowsTip));
            g.addEventListener('pointerleave', hideTip); g.addEventListener('blur', hideTip);
            svg.append(g);
            if (i % every === 0) svg.append(s('text', { x: L + i * band + band / 2, y: H - 6, 'text-anchor': 'middle' }, dayLabel(r.day)));
        });
        return svg;
    }
    function legend(series) {
        return h('div', { class: 'legend' }, series.map(se => { const i = h('i'); i.style.background = `var(${se.color})`; return h('span', {}, i, se.name); }));
    }
    function hbars(items, fmt = num) {
        const max = Math.max(1, ...items.map(i => i.value));
        return h('div', { class: 'hbars' }, items.map(i => {
            const fill = h('div', { class: 'fill' });
            fill.style.width = `${(100 * i.value) / max}%`;
            return h('div', { class: 'hbar' }, h('div', { class: 'name', text: i.name }), h('div', { class: 'track' }, fill), h('div', { class: 'num', text: fmt(i.value) }));
        }));
    }
    function histogram(buckets, threshold) {
        const W = chartWidth(), H = 220, L = 38, B = 26, T = 16, R = 8, pw = W - L - R, ph = H - B - T;
        const ax = niceAxis(Math.max(1, ...buckets.map(b => b.count))), max = ax.max;
        const band = pw / buckets.length, bw = Math.min(24, band * 0.6);
        const y = (v) => T + ph - (v / max) * ph;
        const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Recorded emails by AI score' });
        for (let i = 0; i <= ax.n; i++) { const v = ax.step * i; svg.append(s('line', { class: i ? 'gridline' : 'baseline', x1: L, x2: W - R, y1: y(v), y2: y(v) })); svg.append(s('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, compact(v))); }
        buckets.forEach((b, i) => {
            const x = L + i * band + (band - bw) / 2;
            const g = s('g', { class: 'bar', tabindex: 0, role: 'img', 'aria-label': `AI ${b.from}–${b.to}%: ${b.count} emails, ${b.released} released` });
            if (b.count) g.append(s('path', { d: colPath(x, y(b.count), bw, y(0) - y(b.count), true), fill: css('--s1') }));
            g.append(s('rect', { class: 'hit', x: L + i * band, y: T, width: band, height: ph }));
            const rows = [{ name: 'Emails', value: num(b.count) }, { name: 'Released (false alarm)', value: num(b.released) }];
            g.addEventListener('pointermove', (e) => showTip(e, `AI score ${b.from}–${b.to}%`, rows)); g.addEventListener('focus', (e) => showTip(e, `AI score ${b.from}–${b.to}%`, rows));
            g.addEventListener('pointerleave', hideTip); g.addEventListener('blur', hideTip);
            svg.append(g);
            if (b.count && b.from >= 80) svg.append(s('text', { x: x + bw / 2, y: y(b.count) - 5, 'text-anchor': 'middle' }, num(b.count)));
            if (pw > 500 || i % 2 === 0) svg.append(s('text', { x: L + i * band + band / 2, y: H - 8, 'text-anchor': 'middle' }, `${b.from}%`));
        });
        const tx = L + threshold * pw;
        svg.append(s('line', { class: 'thresh', x1: tx, x2: tx, y1: T - 6, y2: T + ph }));
        svg.append(s('text', { class: 'thresh-label', x: tx - 6, y: T - 2, 'text-anchor': 'end' }, `Moves at ${Math.round(threshold * 100)}%`));
        return svg;
    }
    function dataTable(cols, rows) {
        return h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'num' : '', text: c.name })))),
            h('tbody', {}, rows.map(r => h('tr', {}, cols.map(c => h('td', { class: c.num ? 'num' : '' }, c.get(r))))))));
    }
    // A table whose rows open something (mouse or keyboard).
    function clickTable(cols, rows, open, empty = 'Nothing in this period.') {
        if (!rows.length) return h('div', { class: 'empty', text: empty });
        return h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'num' : '', text: c.name })))),
            h('tbody', {}, rows.map(r => h('tr', { class: 'clickable', tabindex: 0, onclick: () => open(r), onkeydown: (e) => { if (e.key === 'Enter') open(r); } },
                cols.map(c => h('td', { class: `${c.num ? 'num' : ''} ${c.cls || ''}` }, c.get(r))))))));
    }
    // Where the page is: the address bar's #/route, or, in the clickable mockup (which runs inside a frame
    // that keeps the address bar to itself), a route kept in the page with its own Back stack.
    const MEMORY = !!window.SPRUCE_MEMORY_ROUTER;
    let memRoute = '#/overview';
    const memStack = [];
    const currentHash = () => (MEMORY ? memRoute : location.hash);
    const go = (hash) => {
        if (!MEMORY) { location.hash = hash; return; }
        memStack.push(memRoute); memRoute = hash; render(); window.scrollTo(0, 0);
    };
    const back = () => { if (!MEMORY) { history.back(); return; } memRoute = memStack.pop() || '#/overview'; render(); };
    const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

    // --- Views -----------------------------------------------------------------------------------
    const TREND_SERIES = [
        { key: 'rules+ai', name: 'Moved: rules + AI', color: '--s1' },
        { key: 'ai', name: 'Moved: AI score only', color: '--s2' },
        { key: 'rules', name: 'Moved: rules only', color: '--s3' },
        { key: 'wouldMove', name: 'Would move (monitor)', color: '--s4' }
    ];

    async function overview() {
        const d = await api(`/api/overview?days=${days}`);
        const sm = d.summary;
        const out = [];
        if (d.brake) {
            const held = d.brake.held || 0;
            const resume = (moveHeld) => postButton('/api/resume', () => ({ moveHeld }), (o) => (moveHeld && o.held && !o.held.monitor ? `Moving resumed: ${num(o.held.moved)} held emails moved to Spam${o.held.left ? `; ${num(o.held.left)} left, press again` : ''}.` : 'Moving resumed.'),
                moveHeld ? `Resume moving, and move the ${num(held)} held emails to Spam now?` : 'Resume moving, and leave the held emails in the Inbox?');
            out.push(h('div', { class: 'alert critical', role: 'alert' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '⛔' }),
                h('div', { class: 'grow' }, h('b', { text: 'Moving is paused (brake).' }), ` ${num(d.brake.moves)} emails were moved within an hour (the limit is ${num(d.brake.limit || d.brake.moves)}). ${num(held)} suspicious emails are held in the Inbox until you resume.`),
                h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: resume(true) }, `Resume and move held mail (${num(held)})`),
                    h('button', { class: 'btn', type: 'button', onclick: resume(false) }, 'Resume without moving'))));
        }
        if (d.heldCampaigns && d.heldCampaigns.length) out.push(h('div', { class: 'alert warning', role: 'status' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '✋' }),
            h('div', { class: 'grow' }, h('b', { text: `${d.heldCampaigns.length} campaign${d.heldCampaigns.length === 1 ? '' : 's'} held for your decision.` }),
                ' Many copies were moved on evidence nothing outside the email confirms, so later copies wait. Open one to confirm it as phishing (every copy is moved) or release it.',
                h('ul', { class: 'held-list' }, d.heldCampaigns.slice(0, 5).map(c => h('li', {}, h('a', { href: `#/messages?${q({ campaign: c.campaign })}`, text: c.label }), ` (${num(c.held)} held)`))))));
        if (d.mode !== 'enforce') out.push(h('div', { class: 'alert warning' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '👁' }),
            h('div', { class: 'grow' }, h('b', { text: 'Monitor mode.' }), ' Nothing is moved: emails the policy would move are only recorded, so you can measure false alarms first.')));
        const movedBack = `${num(sm.released)} moved back (${pct(sm.releaseRate, 1)}): ${num(sm.released - (sm.userReleased || 0))} by admins, ${num(sm.userReleased || 0)} by users`;
        const hero = d.mode === 'enforce' ? { label: 'Moved to Spam', value: sm.moved, note: movedBack } : { label: 'Would be moved', value: sm.wouldMove, note: 'monitor mode: recorded only' };
        out.push(h('div', { class: 'grid kpis' },
            h('div', { class: 'card kpi hero' }, h('div', { class: 'label', text: hero.label }), h('div', { class: 'value', text: num(hero.value) }), h('div', { class: 'note', text: hero.note })),
            kpi('Emails checked', compact(sm.scanned), `last ${days} days`),
            kpi('Users affected', num(sm.usersAffected), 'had mail moved or recorded'),
            kpi('Campaigns', num(sm.campaigns), 'same sender and subject'),
            kpi(d.mode === 'enforce' ? 'Recorded, not moved' : 'Moved', num(d.mode === 'enforce' ? sm.wouldMove : sm.moved), d.mode === 'enforce' ? 'monitor phase or brake' : sm.moved ? movedBack : ''),
            kpi('Suspicious only', num(sm.flagged), 'amber, below the move rules')));
        // Trend
        const chartBox = h('div', { class: 'chart' }, stackedColumns(d.trend, TREND_SERIES));
        let asTable = false;
        const toggle = h('button', { class: 'linkbtn', type: 'button', text: 'Show as table' });
        toggle.addEventListener('click', () => {
            asTable = !asTable; toggle.textContent = asTable ? 'Show as chart' : 'Show as table'; chartBox.textContent = '';
            chartBox.append(asTable ? dataTable([{ name: 'Day', get: r => dayLabel(r.day) }, { name: 'Checked', num: true, get: r => num(r.scanned) }, ...TREND_SERIES.map(se => ({ name: se.name, num: true, get: r => num(r[se.key]) })), { name: 'Released', num: true, get: r => num(r.released) }], d.trend.slice().reverse())
                                    : stackedColumns(d.trend, TREND_SERIES));
        });
        out.push(h('div', { class: 'grid two' },
            h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: 'Emails moved per day' }), h('div', { class: 'sub', text: 'By what triggered the move; hover a day for the numbers.' })), toggle), legend(TREND_SERIES), chartBox),
            h('section', { class: 'card' }, h('h2', { text: 'Top reasons' }), h('div', { class: 'sub', text: 'Signs found in moved and would-move emails.' }),
                d.topReasons.length ? hbars(d.topReasons.map(r => ({ name: r.reason, value: r.count }))) : h('div', { class: 'empty', text: 'Nothing moved in this period.' }))));
        out.push(h('div', { class: 'grid two' },
            h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: 'Largest campaigns' }), h('div', { class: 'sub', text: 'The same email sent to many people.' })), h('a', { href: '#/campaigns', text: 'All campaigns' })),
                campaignTable(d.campaigns)),
            h('section', { class: 'card' }, h('h2', { text: 'Recent activity' }), h('div', { class: 'sub', text: 'Alerts, releases and changes, last 7 days.' }),
                d.alerts.length ? h('ul', { class: 'events' }, d.alerts.map(a => h('li', {}, h('time', { text: when(a.at) }), a.text))) : h('div', { class: 'empty', text: 'Nothing new.' }))));
        return out;
    }
    // A button's click handler that posts to the service (asking first when ask is set), says the
    // outcome, and redraws the page.
    function postButton(path, body, done, ask) {
        return async (e) => {
            if (ask && !window.confirm(ask)) return;
            const b = e.currentTarget;
            b.disabled = true; acting++;
            try { const out = await api(path, { method: 'POST', body: body() }); toast(done(out)); render(); }
            catch (err) { toast(`Couldn't do that: ${err.message}`); b.disabled = false; }
            finally { acting--; }
        };
    }
    // A campaign's state and an admin's decisions for every copy (Messages, filtered to a campaign).
    async function campaignBar(key) {
        let c;
        try { ({ campaign: c } = await api(`/api/campaign?${q({ key })}`)); } catch (e) { return null; }
        const status = c.decision === 'confirmed' ? `Confirmed as phishing by ${c.decidedBy}: every copy is moved, and later ones too.`
            : c.decision === 'released' ? `Released as a false alarm by ${c.decidedBy}: its copies aren't moved.`
            : c.held ? `${num(c.held)} copies held: over ${num(c.holdAfter)} were moved on evidence nothing outside the email confirms. Confirm or release it.`
            : `${num(c.copies)} copies recorded: ${num(c.moved)} in Spam, ${num(c.recorded)} in the Inbox, ${num(c.released)} released.`;
        const search = h('input', { type: 'checkbox', checked: true });
        const found = (f) => (f ? `; ${num(f.found)} more found in ${num(f.searched)} of ${num(f.of)} mailboxes${f.moved ? `, ${num(f.moved)} moved` : ''}` : '');
        return h('section', { class: `card campaign-bar${c.held && !c.decision ? ' held' : ''}` },
            h('div', {}, h('b', { text: c.label }), h('div', { class: 'small muted', text: status })),
            h('div', { class: 'actions' },
                c.decision !== 'confirmed' ? [
                    h('button', { class: 'btn primary', type: 'button', onclick: postButton('/api/campaign/confirm', () => ({ key, search: search.checked }),
                        (o) => (o.moved && o.moved.monitor ? `Confirmed as phishing. Monitor mode: nothing moved${found(o.found)}.` : `Confirmed: ${num(o.moved.moved)} copies moved to Spam${found(o.found)}${o.moved.left ? `; ${num(o.moved.left)} left, press again` : ''}.`),
                        `Confirm "${c.label}" as phishing and move every copy to Spam${search.checked ? ', searching every watched mailbox for more' : ''}?`) }, 'Confirm phishing: move every copy'),
                    h('label', { class: 'small' }, search, ' also search every watched mailbox for copies not recorded')] : null,
                c.decision !== 'released' ? h('button', { class: 'btn', type: 'button', onclick: postButton('/api/campaign/release', () => ({ key }), (o) => `Released: ${num(o.released)} copies back in the Inbox.`,
                    `Release every copy of "${c.label}" to the Inbox, and stop moving it?`) }, 'False alarm: release every copy') : null,
                c.decision === 'confirmed' ? h('button', { class: 'btn', type: 'button', onclick: postButton('/api/campaign/find', () => ({ key }), (o) => `Searched: ${num(o.found.found)} more found in ${num(o.found.searched)} of ${num(o.found.of)} mailboxes${o.found.moved ? `, ${num(o.found.moved)} moved` : ''}.`) }, 'Find other copies') : null));
    }
    const kpi = (label, value, note) => h('div', { class: 'card kpi' }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), note ? h('div', { class: 'note', text: note }) : null);

    function campaignTable(list) {
        return clickTable([
            { name: 'Campaign', cls: 'trunc', get: c => h('div', {}, h('div', { text: c.subject || '(subject not stored)' }), h('div', { class: 'muted small', text: c.senderDomain })) },
            { name: 'People', num: true, get: c => num(c.recipients) },
            { name: 'Moved', num: true, get: c => num(c.moved) },
            { name: 'Would move', num: true, get: c => num(c.wouldMove) },
            { name: 'Released', num: true, get: c => num(c.released) },
            { name: 'Top reason', get: c => c.topReason }
        ], list, c => go(`#/messages?${q({ campaign: c.campaign })}`));
    }

    async function campaigns() {
        const d = await api(`/api/campaigns?days=${days}`);
        return [h('h1', { text: 'Campaigns' }), h('p', { class: 'sub', text: 'Emails grouped by sender domain and subject (numbers and the recipient\'s name taken out). Open one to see every copy.' }),
            h('section', { class: 'card' }, clickTable([
                { name: 'Campaign', cls: 'trunc', get: c => h('div', {}, h('div', { text: c.subject || '(subject not stored)' }), h('div', { class: 'muted small', text: c.senderDomain })) },
                { name: 'People', num: true, get: c => num(c.recipients) },
                { name: 'Moved', num: true, get: c => num(c.moved) },
                { name: 'Would move', num: true, get: c => num(c.wouldMove) },
                { name: 'Released', num: true, get: c => num(c.released) },
                { name: 'Highest AI', num: true, get: c => pct(c.maxAi) },
                { name: 'Top reason', get: c => c.topReason },
                { name: 'First seen', get: c => when(c.firstAt) },
                { name: 'Last seen', get: c => when(c.lastAt) }
            ], d.campaigns, c => go(`#/messages?${q({ campaign: c.campaign })}`)))];
    }

    async function users() {
        const d = await api(`/api/users?days=${days}`);
        return [h('h1', { text: 'Affected users' }), h('p', { class: 'sub', text: 'Everyone who had mail moved, would have had mail moved, or got suspicious mail in this period.' }),
            h('section', { class: 'card' }, clickTable([
                { name: 'User', get: u => u.user },
                { name: 'Moved', num: true, get: u => num(u.moved) },
                { name: 'Would move', num: true, get: u => num(u.wouldMove) },
                { name: 'Suspicious', num: true, get: u => num(u.flagged) },
                { name: 'Released', num: true, get: u => num(u.released) },
                { name: 'Last', get: u => when(u.last) }
            ], d.users, u => go(`#/messages?${q({ user: u.user })}`)))];
    }

    async function messages(params) {
        const filt = { user: params.get('user') || '', campaign: params.get('campaign') || '', action: params.get('action') || '', state: params.get('state') || '', q: params.get('q') || '' };
        const d = await api(`/api/messages?days=${days}&${q(filt)}`);
        const search = h('input', { type: 'search', placeholder: 'Search sender, recipient or subject', value: filt.q, 'aria-label': 'Search' });
        const action = h('select', { 'aria-label': 'Action' }, h('option', { value: '', text: 'Any action' }), Object.entries(ACTION).map(([k, [l]]) => h('option', { value: k, text: l, selected: filt.action === k })));
        const state = h('select', { 'aria-label': 'Where it is' }, h('option', { value: '', text: 'Anywhere' }), Object.entries(STATE).map(([k, [l]]) => h('option', { value: k, text: l, selected: filt.state === k })));
        const apply = () => go(`#/messages?${q(Object.assign({}, filt, { q: search.value.trim(), action: action.value, state: state.value }))}`);
        search.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
        action.addEventListener('change', apply); state.addEventListener('change', apply);
        const scope = filt.user ? `for ${filt.user}` : filt.campaign ? 'in this campaign' : '';
        const bar = filt.campaign ? await campaignBar(filt.campaign) : null;
        const csv = MEMORY ? null : h('a', { class: 'btn', href: `/api/export.csv?${q(Object.assign({ days: String(days) }, filt))}`, download: '' }, 'Download CSV');
        return [h('h1', { text: `Messages ${scope}`.trim() }),
            h('p', { class: 'sub' }, `${num(d.total)} recorded in the last ${days} days. `, (filt.user || filt.campaign) ? h('a', { href: '#/messages', text: 'Show all' }) : null),
            bar,
            h('div', { class: 'toolbar' }, search, action, state, h('button', { class: 'btn', type: 'button', onclick: apply }, 'Filter'), csv),
            h('section', { class: 'card' }, clickTable([
                { name: 'When', get: m => when(m.processedAt) },
                { name: 'To', get: m => m.user },
                { name: 'From', cls: 'trunc', get: m => h('div', {}, h('div', { text: m.sender.name || m.sender.address }), h('div', { class: 'muted small', text: m.sender.address })) },
                { name: 'Subject', cls: 'trunc', get: m => m.subject || '(not stored)' },
                { name: 'AI', num: true, get: m => (m.ai === null ? '–' : pct(m.ai)) },
                { name: 'Score', num: true, get: m => (m.score === null || m.score === undefined ? '–' : m.score) },
                { name: 'Action', get: m => pill(ACTION[m.action] || [m.action, '']) },
                { name: 'Now', get: m => pill(stateOf(m)) }
            ], d.messages, m => go(`#/message?${q({ key: m.key })}`), 'No messages match.'))];
    }

    async function message(params) {
        const key = params.get('key') || '';
        const { message: m } = await api(`/api/message?${q({ key })}`);
        const ai = m.ai && typeof m.ai.probability === 'number' ? m.ai.probability : null;
        // A user took back an email the checks flagged, and no admin has looked yet: worth a look.
        const rescueToCheck = m.state === 'released' && m.releasedByUser && !m.markedBy && m.score >= 5 && m.trigger !== 'ai';
        const decisionClass = rescueToCheck ? 'would' : m.state === 'released' ? 'released' : m.action === 'move' ? 'move' : m.action === 'would-move' ? 'would' : 'flag';
        const act = async (path, body, done) => { acting++; try { await api(path, { method: 'POST', body }); toast(done); render(); } catch (e) { toast(`Couldn't do that: ${e.message}`); } finally { acting--; } };
        const actions = h('div', { class: 'actions' },
            m.state === 'moved' ? h('button', { class: 'btn primary', type: 'button', onclick: () => act('/api/release', { key: m.key }, 'Released: back in the Inbox.') }, 'Release to Inbox') : null,
            m.falseAlarm !== true ? h('button', { class: 'btn', type: 'button', onclick: () => act('/api/mark', { key: m.key, falseAlarm: true }, 'Marked as a false alarm.') }, 'Mark false alarm') : null,
            m.falseAlarm !== false ? h('button', { class: 'btn', type: 'button', onclick: () => act('/api/mark', { key: m.key, falseAlarm: false }, 'Confirmed as phishing or spam.') }, 'Confirm phishing') : null);
        const verdictText = m.falseAlarm === true && m.releasedByUser && !m.markedBy ? 'Counted as a false alarm because the user moved it back. No admin has reviewed it yet.'
            : m.falseAlarm === true ? 'An admin marked this a false alarm.' : m.falseAlarm === false ? 'An admin confirmed this as phishing or spam.' : 'Not reviewed yet.';
        return [h('button', { class: 'linkbtn back', type: 'button', onclick: back }, '← Back'),
            h('h1', { text: m.subject || '(subject not stored)' }),
            h('p', { class: 'sub', text: `From ${m.sender.name ? `${m.sender.name} <${m.sender.address}>` : m.sender.address} to ${m.user}, ${when(m.receivedAt)}` }),
            h('div', { class: 'grid detail' },
                h('div', { class: 'grid' },
                    h('section', { class: 'card' }, h('h2', { text: 'What happened' }),
                        h('div', { class: `decision ${decisionClass}` }, h('b', { text: m.state === 'released' ? (m.releasedByUser ? 'Moved back to the Inbox by the user' : `Released by ${m.releasedBy}`) : (ACTION[m.action] || [m.action])[0] }), h('div', { text: m.state === 'released' ? `${when(m.releasedAt)}. It was moved because ${m.why}.` : `Because ${m.why}.` }),
                            rescueToCheck ? h('div', { text: 'The checks flagged it. Make sure it is safe, or confirm phishing and warn the user.' }) : null),
                        h('div', { class: 'small muted', text: `${verdictText} ${m.markedBy ? `(${m.markedBy})` : ''}`.trim() }),
                        m.evidence ? h('div', { class: 'small muted', text: m.evidence === 'strong' ? `Strong evidence: the rules flagged it, and ${(m.confirmedBy || []).join('; ')}. The brakes never hold it.`
                            : m.evidence === 'admin' ? 'A copy found by an admin\'s search for a campaign.' : 'Weaker evidence: nothing outside the email confirms it, so the campaign brake can hold its copies.' }) : null,
                        actions),
                    h('section', { class: 'card' }, h('h2', { text: 'Signs found' }), h('div', { class: 'sub', text: `The extension's checks: score ${m.score === null || m.score === undefined ? '–' : m.score} (amber at 3, flagged at 5).` }),
                        m.signals.length ? h('ul', { class: 'signals' }, m.signals.slice().sort((a, b) => b.weight - a.weight).map(sg => h('li', {}, h('span', { class: `weight ${sg.weight >= 3 ? 'high' : ''}`, text: String(sg.weight) }), h('span', { text: sg.text })))) : h('div', { class: 'empty', text: 'No signs.' })),
                    m.links && m.links.length ? h('section', { class: 'card' }, h('h2', { text: 'Flagged links' }), h('ul', { class: 'signals' }, m.links.map(l => h('li', {}, h('span', { class: `weight ${l.severity === 'danger' ? 'high' : ''}`, text: l.severity === 'danger' ? '!' : '?' }), h('span', {}, h('div', { text: l.reason || '' }), h('div', { class: 'muted small', text: l.finalUrl && l.finalUrl !== l.url ? `${l.url} → ${l.finalUrl}` : l.url })))))) : null),
                h('div', { class: 'grid' },
                    h('section', { class: 'card' }, h('h2', { text: 'AI opinion' }),
                        ai === null ? h('div', { class: 'empty', text: 'The model gave no score.' }) : [
                            h('div', { class: 'kpi' }, h('div', { class: 'value', text: pct(ai) }), h('div', { class: 'note', text: `${m.ai.model}: how likely it is phishing` })),
                            (() => { const mt = h('div', { class: `meter ${ai >= 0.85 ? 'hot' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(ai * 100), 'aria-label': 'AI score' }, h('div')); mt.firstChild.style.width = pct(ai); return mt; })(),
                            m.ai.reasons && m.ai.reasons.length ? [h('div', { class: 'small muted', text: 'What weighed most:' }), m.ai.reasons.map(r => h('div', { class: 'quote', text: r.facts ? 'Who sent it, the sender check and where its links go' : `“${r.sentence}”` }))] : null]),
                    h('section', { class: 'card' }, h('h2', { text: 'Details' }), h('dl', { class: 'kv' },
                        h('dt', { text: 'Sender check' }), h('dd', { text: m.auth ? `DMARC ${m.auth.dmarc || '–'}, SPF ${m.auth.spf || '–'}, DKIM ${m.auth.dkim || '–'}` : 'not recorded' }),
                        h('dt', { text: 'Trigger' }), h('dd', { text: m.trigger ? ({ rules: 'Rules', ai: 'AI score', 'rules+ai': 'Rules and AI' })[m.trigger] : 'none' }),
                        h('dt', { text: 'Mode' }), h('dd', { text: m.mode }),
                        h('dt', { text: 'Looked up' }), h('dd', { text: m.checks ? [m.checks.cloudflare ? `Cloudflare: ${m.checks.cloudflare} site${m.checks.cloudflare === 1 ? '' : 's'}` : '', m.checks.safeBrowsing ? `Safe Browsing: ${m.checks.safeBrowsing} link${m.checks.safeBrowsing === 1 ? '' : 's'}` : '', m.checks.lists ? 'phishing lists' : '', m.checks.ages ? `site age: ${m.checks.ages}` : '', m.checks.notChecked ? `${m.checks.notChecked} not checked` : ''].filter(Boolean).join(' · ') || 'nothing to look up' : 'offline checks only' }),
                        h('dt', { text: 'Attachments' }), h('dd', { text: m.attachments && m.attachments.length ? m.attachments.map(a => a.name || a.type).join(', ') : 'none' }),
                        h('dt', { text: 'Message ID' }), h('dd', { class: 'small', text: m.messageId }),
                        h('dt', { text: 'Checked' }), h('dd', { text: when(m.processedAt) })))))];
    }

    async function health() {
        const d = await api(`/api/health?days=${days}`);
        const reviewedRate = d.reviewed ? d.falseAlarms / d.reviewed : 0;
        return [h('h1', { text: 'Model health' }), h('p', { class: 'sub', text: 'Whether the move rules are right: how often each kind of move had to be undone. Use this to set the AI threshold.' }),
            h('div', { class: 'grid kpis' }, kpi('Moved back by users', num(d.userReleased || 0), 'Not spam, or dragged to the Inbox'), kpi('Reviewed', num(d.reviewed), 'released, marked or confirmed'), kpi('Confirmed phishing', num(d.confirmed), ''), kpi('False alarms', num(d.falseAlarms), d.reviewed ? `${pct(reviewedRate, 1)} of reviewed` : ''), kpi('Move threshold', pct(d.threshold), 'AI_MOVE_THRESHOLD')),
            h('div', { class: 'grid two' },
                h('section', { class: 'card' }, h('h2', { text: 'Recorded emails by AI score' }), h('div', { class: 'sub', text: 'Each column is a 10-point range of the model\'s score; hover for how many were released.' }), h('div', { class: 'chart' }, histogram(d.buckets, d.threshold))),
                h('section', { class: 'card' }, h('h2', { text: 'Undone moves by trigger' }), h('div', { class: 'sub', text: 'Released ÷ moved. A high rate for "AI score" alone means the threshold is too low.' }),
                    dataTable([{ name: 'Trigger', get: r => r.label }, { name: 'Moved', num: true, get: r => num(r.moved) }, { name: 'Released', num: true, get: r => num(r.released) }, { name: 'By users', num: true, get: r => num(r.byUser || 0) }, { name: 'Rate', num: true, get: r => pct(r.rate, 1) }], d.byTrigger),
                    h('p', { class: 'small muted', text: `Model: ${d.model || 'unknown'}.` })))];
    }

    async function settings() {
        const d = await api('/api/settings');
        const yes = (b) => (b ? 'Yes' : 'No');
        const row = (k, v) => [h('dt', { text: k }), h('dd', { text: v })];
        return [h('h1', { text: 'Settings' }), h('p', { class: 'sub', text: 'Read-only here: they are set when the service is deployed (environment variables, see docs/DEPLOY.md), so every change is reviewed.' }),
            h('div', { class: 'grid two' },
                h('section', { class: 'card' }, h('h2', { text: 'Policy' }), h('dl', { class: 'kv' },
                    row('Mode', d.mode === 'enforce' ? 'Enforce: moves to Spam' : 'Monitor: records only'),
                    row('Move when', `${d.moveOnRules ? 'the rules flag it (score 5+), or ' : ''}the AI scores ${pct(d.aiThreshold)} or more`),
                    row('AI alone, inside mail', d.aiMovesInside ? 'Moves it' : 'Never moves it (rules still can)'),
                    row('Brake (whole domain)', `Stops moving everywhere after ${num(d.brakeLimit)} moves in an hour (${d.brakePerHour ? 'BRAKE_PER_HOUR' : 'half the watched mailboxes, at least 100'}). A last resort against a misfire`),
                    row('Campaign hold', `Holds the copies of one campaign after ${num(d.campaignHoldAfter)} moved on weaker evidence, until you confirm or release it. Strong evidence is never held`),
                    row('Alerts', d.alertEmail ? `Emailed to ${d.alertEmail} by Cloud Monitoring` : 'Shown in Recent activity; not emailed (ALERT_EMAIL, deploy/install.sh)'),
                    row('Never moved', [...d.allowDomains, d.allowAddresses ? `${d.allowAddresses} addresses` : ''].filter(Boolean).join(', ') || 'none set'),
                    row('Label on moved mail', d.movedLabel))),
                h('section', { class: 'card' }, h('h2', { text: 'Scope and records' }), h('dl', { class: 'kv' },
                    row('Organization', d.orgDomains.join(', ') || '–'),
                    row('Mailboxes watched', `${num(d.watched)}${[...(d.pilotGroups || []).map(g => `group ${g}`), d.pilotOu ? `unit ${d.pilotOu}` : ''].filter(Boolean).map(s => ` (${s})`).join('')}`),
                    row('Records kept', `${d.retentionDays} days`),
                    row('Subjects stored', yes(d.storeSubjects)),
                    row('AI quotes stored', yes(d.storeAiQuotes)),
                    row('Model', `${d.model.name} ${d.model.version}`),
                    row('Engine', d.engine && d.engine.extensionVersion ? `S.P.R.U.C.E+ ${d.engine.extensionVersion} (${d.engine.commit || ''})` : 'bundled')))),
            h('section', { class: 'card spaced' }, h('h2', { text: 'Network checks' }), h('div', { class: 'sub', text: 'Lookups made for every email, besides the offline checks. A lookup that fails leaves a link "not checked", never "safe".' }),
                h('dl', { class: 'kv' },
                    row('Cloudflare Security', d.checks && d.checks.cloudflare ? 'On: link sites and sender domains' : 'Off'),
                    row('Google Safe Browsing', d.checks && d.checks.safeBrowsing ? 'On: links (no #part; one-time links without their query)' : 'Off (Cloudflare only for now)'),
                    row('Phishing lists', d.checks && d.checks.phishingLists ? 'On: downloaded once a day, matched here' : 'Off'),
                    row('Site age', d.checks && d.checks.siteAge ? 'On: up to 3 unfamiliar link sites and the sender\'s domain' : 'Off'),
                    row('Short links', 'Not looked up (no outside unshortening service)')),
                d.lists && d.lists.length ? dataTable([{ name: 'List', get: l => l.name }, { name: 'Kind', get: l => ({ url: 'phishing links', domain: 'phishing sites', address: 'scam senders' })[l.kind] || l.kind }, { name: 'Entries', num: true, get: l => num(l.count) }, { name: 'Updated', get: l => (l.updated ? when(l.updated) : 'not yet') }], d.lists) : null),
            h('section', { class: 'card spaced' }, h('h2', { text: 'Mailboxes watched' }),
                renewBar(d.renew),
                h('div', { class: 'sub', text: 'Who the pilot watches, and when Gmail last said each mailbox changed. "None yet" for a mailbox that does get mail means its notifications don\'t arrive. Recent activity says, after each daily re-read of the group, how many people it found and why any were left out.' }),
                d.mailboxes && d.mailboxes.length
                    ? dataTable([{ name: 'Mailbox', get: m => m.email }, { name: 'Last notification', get: m => (m.lastNotification ? when(m.lastNotification) : 'None yet') }, { name: 'Watch renews by', get: m => (m.watchExpiration ? when(m.watchExpiration) : '–') }], d.mailboxes)
                    : h('div', { class: 'empty', text: 'None: run the spruce-renew-watches job (docs/INSTALL.md, step 7).' }))];
    }

    // --- Keeping the page up to date --------------------------------------------------------------
    // While the tab is visible, the page shown is fetched again every LIVE_MS, quietly. A round is skipped
    // while someone is using the page (typing in a field, focus on something in it, a tooltip open, text
    // selected, an action under way), and taken as soon as they stop. Pausing is remembered per browser.
    const LIVE_MS = Number(window.SPRUCE_LIVE_MS) || 30000;   // (a test page may set it shorter)
    let live = true, updatedAt = 0, liveError = null, acting = 0;
    try { live = localStorage.getItem('spruce.live') !== 'off'; } catch (e) { /* storage blocked */ }
    const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    function inUse() {
        const v = view(), a = document.activeElement, sel = window.getSelection && window.getSelection();
        return acting > 0 || !tip().hidden || (a && a !== v && v.contains(a))
            || [...v.querySelectorAll('input, textarea')].some(i => i.value !== i.defaultValue)
            || !!(sel && !sel.isCollapsed && sel.anchorNode && v.contains(sel.anchorNode));
    }
    function showLive() {
        const box = $('#live');
        if (!box) return;
        box.classList.toggle('paused', !live);
        box.classList.toggle('stale', live && !!liveError);
        $('#liveState').textContent = !live ? 'Updates paused'
            : liveError ? `Couldn't update (${liveError.message}); trying again`
            : updatedAt ? `Live · updated ${clock(updatedAt)}` : 'Live';
        const b = $('#liveToggle');
        b.textContent = live ? 'Pause updates' : 'Resume updates';
        b.setAttribute('aria-pressed', String(live));
    }
    function liveDone(err) { liveError = err; updatedAt = Date.now(); showLive(); }
    function liveTick() {
        if (live && !document.hidden && Date.now() - updatedAt >= LIVE_MS && !inUse()) render({ quiet: true });
    }

    // --- Activity: alerts, what admins did, errors, the watching of mailboxes ---------------------
    async function activity(params) {
        const kind = params.get('kind') || '';
        const d = await api(`/api/activity?${q({ days: String(days), kind })}`);
        const sel = h('select', { 'aria-label': 'Kind' }, [['', 'Everything'], ['alert', 'Alerts'], ['admin', 'What admins did'], ['error', 'Errors and gaps'], ['watch', 'Watching mailboxes']]
            .map(([v, l]) => h('option', { value: v, text: l, selected: v === kind })));
        sel.addEventListener('change', () => go(`#/activity?${q({ kind: sel.value })}`));
        return [h('h1', { text: 'Activity' }), h('p', { class: 'sub', text: `Alerts, what admins did, errors and the watching of mailboxes, last ${days} days (newest first, up to 500).` }),
            h('div', { class: 'toolbar' }, sel),
            h('section', { class: 'card' }, d.events.length ? h('ul', { class: 'events' }, d.events.map(e => h('li', { class: e.alert ? 'alerted' : '' }, h('time', { text: `${when(e.at)}${e.alert ? ' · alert' : ''}` }), e.text)))
                : h('div', { class: 'empty', text: 'Nothing in this period.' }))];
    }

    // --- Ready for enforce mode? -------------------------------------------------------------------
    async function readiness() {
        const { readiness: r } = await api(`/api/readiness?days=${days}`);
        const todo = r.checks.filter(c => !c.ok).length;
        return [h('h1', { text: 'Ready for enforce mode?' }),
            h('p', { class: 'sub', text: r.mode === 'enforce' ? 'Enforce mode is on. The checks still show how the policy is doing.'
                : `What monitor mode has shown in the last ${days} days. When every check is green: set MODE=enforce in deploy/settings.env and run deploy/install.sh (docs/INSTALL.md, step 7).` }),
            h('div', { class: `alert ${r.ready ? 'good' : 'warning'}`, role: 'status' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: r.ready ? '✅' : '⏳' }),
                h('div', { class: 'grow' }, h('b', { text: r.ready ? 'Ready.' : `Not yet: ${todo} of ${r.checks.length} checks to look at.` }))),
            h('section', { class: 'card' }, h('ul', { class: 'checks' }, r.checks.map(c => h('li', { class: c.ok ? 'ok' : 'todo' },
                h('span', { class: 'mark', 'aria-hidden': 'true', text: c.ok ? '✓' : '!' }), h('span', { class: 'sr-only', text: c.ok ? 'Done: ' : 'To look at: ' }), h('span', { text: c.text }))))),
            h('div', { class: 'grid kpis' },
                kpi('Would be moved', num(r.wouldMove), r.strongShare === null ? '' : `${pct(r.strongShare)} on strong evidence`),
                kpi('Reviewed', num(r.reviewed), `${num(r.falseAlarms)} false alarms`),
                kpi('Busiest hour', num(r.peakHour), `the brake stops at ${num(r.brakeLimit)}`),
                kpi('Days so far', num(r.monitorDays), 'since the install')),
            r.campaignsOverHold.length ? h('section', { class: 'card spaced' }, h('h2', { text: 'Campaigns the hold would have stopped' }),
                h('div', { class: 'sub', text: `More than ${r.holdAfter} copies on weaker evidence: in enforce mode the rest would wait for your decision.` }),
                dataTable([{ name: 'Campaign', get: c => h('a', { href: `#/messages?${q({ campaign: c.campaign })}`, text: c.label }) }, { name: 'Copies', num: true, get: c => num(c.count) }], r.campaignsOverHold)) : null];
    }

    // "Update group membership now" (Settings): runs the daily re-read of the pilot group at once, and
    // says when the group was last read and whether that reached the service.
    function renewBar(r) {
        if (!r) return null;
        const last = r.last;
        const status = !last ? null
            : last.error ? h('span', { class: 'muted small', text: `Couldn't read when the group was last read: ${last.error}` })
            : !last.at ? h('span', { class: 'muted small', text: 'The group hasn\'t been read yet.' })
            : last.code ? h('span', { class: 'renew-bad', text: `Group last read ${when(last.at)}, but that didn't reach the service (Cloud Scheduler status ${last.code}): no mailbox is watched or checked. docs/INSTALL.md, Troubleshooting, "The jobs and notifications are refused".` })
            : h('span', { class: 'muted small', text: `Group last read ${when(last.at)}: it reached the service.` });
        const button = r.available ? h('button', { class: 'btn', type: 'button', onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true; acting++;
            try {
                await api('/api/renew-watches', { method: 'POST', body: {} });
                toast('Asked: the group is read again within a minute. This page updates by itself.');
                setTimeout(() => { if (/settings/.test(currentHash())) render({ quiet: true }); }, 10000);
            } catch (err) { toast(`Couldn't do that: ${err.message}`); b.disabled = false; }
            finally { acting--; }
        } }, 'Update group membership now') : null;
        return h('div', { class: 'renew' }, button, status);
    }

    // --- Routing ---------------------------------------------------------------------------------
    const ROUTES = { overview, campaigns, users, messages, message, health, readiness, activity, settings };
    let rendering = 0;
    // quiet: a live update (no loading fade, the scroll position kept, and on failure the page stays).
    async function render({ quiet = false } = {}) {
        const [path, query] = (currentHash().replace(/^#\/?/, '') || 'overview').split('?');
        const name = ROUTES[path] ? path : 'overview';
        const tab = name === 'message' ? 'messages' : name;
        for (const a of document.querySelectorAll('.tabs a')) { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
        for (const b of document.querySelectorAll('.range')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
        const id = ++rendering;
        if (!quiet) { view().classList.add('loading'); hideTip(); }
        const scrollY = window.scrollY;
        try {
            const nodes = await ROUTES[name](new URLSearchParams(query || ''));
            if (id !== rendering) return;
            view().textContent = '';
            view().append(...[].concat(nodes).flat(Infinity).filter(Boolean));
            if (quiet) window.scrollTo(0, scrollY);
            liveDone(null);
        } catch (e) {
            if (id !== rendering) return;
            if (quiet) { liveDone(e); return; }
            view().textContent = '';
            view().append(h('div', { class: 'alert critical', role: 'alert' }, h('span', { class: 'icon', text: '⚠️' }), h('div', {}, h('b', { text: 'Couldn\'t load this page. ' }), e.message)));
        } finally { if (id === rendering) view().classList.remove('loading'); }
    }

    async function boot() {
        for (const b of document.querySelectorAll('.range')) b.addEventListener('click', () => { days = Number(b.dataset.days); try { localStorage.setItem('spruce.days', String(days)); } catch (e) { /* not kept */ } render(); });
        if (MEMORY) document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="#/"]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });
        else window.addEventListener('hashchange', render);
        window.addEventListener('scroll', hideTip, { passive: true });
        // Live updates (not in the clickable mockup, whose data never changes).
        if (!MEMORY && $('#live')) {
            $('#live').hidden = false;
            $('#liveToggle').addEventListener('click', () => {
                live = !live;
                try { localStorage.setItem('spruce.live', live ? 'on' : 'off'); } catch (e) { /* not kept */ }
                showLive();
                if (live) liveTick();
            });
            document.addEventListener('visibilitychange', liveTick);
            setInterval(liveTick, 5000);
            showLive();
        }
        try {
            const st = await api('/api/settings');
            $('#who').textContent = st.admin || '';
            $('#orgLine').textContent = `Google Workspace · ${st.orgDomains.join(', ') || 'your organization'}`;
            const badge = $('#modeBadge');
            badge.hidden = false;
            badge.className = `mode ${st.mode}`;
            badge.textContent = st.mode === 'enforce' ? 'Enforce mode' : 'Monitor mode';
            if (st.demo) $('.top-right').prepend(h('span', { class: 'demo-flag', text: 'DEMO · made-up data' }));
            $('#foot').textContent = `Checks and AI model from S.P.R.U.C.E+ (${st.model.name} ${st.model.version}). Records hold sender, subject and the checks' findings, never email bodies, and are deleted after ${st.retentionDays} days.`;
        } catch (e) { /* the view shows the error */ }
        render();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
