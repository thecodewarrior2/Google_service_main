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
    // A POST whose answer is a file (the retraining export): saved by the browser; its headers returned.
    async function downloadPost(path, body) {
        const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'spruce-dashboard', 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || `HTTP ${res.status}`); }
        const blob = await res.blob();
        const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'download';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return res.headers;
    }

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

    // The mode, in the header: set when the page loads, and again whenever Overview or Settings is read
    // (the mode can be switched on the dashboard, by this admin or another).
    function showMode(mode) {
        const badge = $('#modeBadge');
        if (!badge || !mode) return;
        badge.hidden = false;
        badge.className = `mode ${mode}`;
        badge.textContent = mode === 'enforce' ? 'Enforce mode' : 'Monitor mode';
    }

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
        showMode(d.mode);
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
        const search = h('input', { type: 'search', placeholder: 'Search sender, recipient, subject or Message-ID', value: filt.q, 'aria-label': 'Search' });
        const action = h('select', { 'aria-label': 'Action' }, h('option', { value: '', text: 'Any action' }), Object.entries(ACTION).map(([k, [l]]) => h('option', { value: k, text: l, selected: filt.action === k })));
        const state = h('select', { 'aria-label': 'Where it is' }, h('option', { value: '', text: 'Anywhere' }), Object.entries(STATE).map(([k, [l]]) => h('option', { value: k, text: l, selected: filt.state === k })));
        const apply = () => go(`#/messages?${q(Object.assign({}, filt, { q: search.value.trim(), action: action.value, state: state.value }))}`);
        search.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
        action.addEventListener('change', apply); state.addEventListener('change', apply);
        const scope = filt.user ? `for ${filt.user}` : filt.campaign ? 'in this campaign' : '';
        const bar = filt.campaign ? await campaignBar(filt.campaign) : null;
        const csv = MEMORY ? null : h('a', { class: 'btn', href: `/api/export.csv?${q(Object.assign({ days: String(days) }, filt))}`, download: '' }, 'Download CSV');
        // Several at once: a checkbox on each row, and a bar with what to do with the selected ones.
        const selected = new Set(), boxes = [];
        const count = h('b', { text: '' });
        const bulkBar = h('div', { class: 'bulk-bar card', hidden: true });
        const changed = () => { bulkBar.hidden = !selected.size; count.textContent = `${num(selected.size)} selected`; };
        pageBusy = () => selected.size > 0;   // (live updates wait while some are selected)
        const box = (m) => {
            const c = h('input', { type: 'checkbox', 'aria-label': `Select the email from ${m.sender.address} to ${m.user}` });
            c.addEventListener('click', (e) => { e.stopPropagation(); if (c.checked) selected.add(m.key); else selected.delete(m.key); changed(); });
            c.addEventListener('keydown', (e) => e.stopPropagation());
            boxes.push([m, c]);
            return c;
        };
        const all = h('input', { type: 'checkbox', 'aria-label': 'Select every email on this page' });
        all.addEventListener('change', () => { for (const [m, c] of boxes) { c.checked = all.checked; if (all.checked) selected.add(m.key); else selected.delete(m.key); } changed(); });
        const bulk = (action, done, ask) => postButton('/api/bulk', () => ({ action, keys: [...selected] }),
            (o) => `${done}: ${num(o.done)}${o.skipped ? ` (${num(o.skipped)} skipped: not in Spam, or already so)` : ''}${o.failed ? `, ${num(o.failed)} failed` : ''}.`, ask);
        bulkBar.append(count,
            h('button', { class: 'btn', type: 'button', onclick: bulk('release', 'Released to the Inbox', 'Release the selected emails that are in Spam to the Inbox?') }, 'Release to Inbox'),
            h('button', { class: 'btn', type: 'button', onclick: bulk('false-alarm', 'Marked as false alarms') }, 'Mark false alarm'),
            h('button', { class: 'btn', type: 'button', onclick: bulk('phishing', 'Confirmed as phishing') }, 'Confirm phishing'),
            h('button', { class: 'linkbtn', type: 'button', onclick: () => { selected.clear(); all.checked = false; for (const [, c] of boxes) c.checked = false; changed(); } }, 'Clear'));
        return [h('h1', { text: `Messages ${scope}`.trim() }),
            h('p', { class: 'sub' }, `${num(d.total)} recorded in the last ${days} days. `, (filt.user || filt.campaign) ? h('a', { href: '#/messages', text: 'Show all' }) : null),
            bar,
            h('div', { class: 'toolbar' }, search, action, state, h('button', { class: 'btn', type: 'button', onclick: apply }, 'Filter'), csv,
                MEMORY ? null : h('a', { class: 'btn', href: '#/check' }, 'Check an email'),
                d.messages.length ? h('label', { class: 'small select-all' }, all, ' Select all on this page') : null),
            bulkBar,
            h('section', { class: 'card' }, clickTable([
                { name: '', get: m => box(m) },
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
        return emailView(m);
    }
    // A Copy button: the text goes to the clipboard (or, where the browser doesn't allow it, by a hidden
    // field), and a message says so.
    function copyButton(text, what) {
        return h('button', { class: 'linkbtn copy', type: 'button', 'aria-label': `Copy the ${what}`, onclick: async () => {
            try { await navigator.clipboard.writeText(text); }
            catch (e) {
                const t = h('textarea', { 'aria-hidden': 'true' });
                t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
                document.body.append(t); t.select();
                try { document.execCommand('copy'); } finally { t.remove(); }
            }
            toast(`${what} copied.`);
        } }, 'Copy');
    }
    // A row with an identifier, its Copy button, and what it is for.
    const idRow = (label, value, note) => [h('dt', { text: label }),
        h('dd', {}, value ? [h('code', { class: 'mid', text: value }), ' ', copyButton(value, label), note ? h('div', { class: 'muted small', text: note }) : null]
            : h('span', { class: 'muted', text: 'not recorded (emails before 0.3.1)' }))];
    const PASTED = { move: 'Would be moved to Spam', 'would-move': 'Would be recorded as "would move" (monitor mode: nothing is moved)', flag: 'Would be recorded as suspicious, not moved', none: 'Nothing would happen: the checks find nothing to act on' };

    // One email's decision: a record (Messages), or a pasted email's answer (Check an email: m.pasted).
    // opts.inReview: the review queue shows its own buttons and title.
    function emailView(m, opts = {}) {
        const pasted = !!m.pasted, quiet = pasted || !!opts.inReview;
        const ai = m.ai && typeof m.ai.probability === 'number' ? m.ai.probability : null;
        // A user took back an email the checks flagged, and no admin has looked yet: worth a look.
        const rescueToCheck = !pasted && m.state === 'released' && m.releasedByUser && !m.markedBy && m.score >= 5 && m.trigger !== 'ai';
        const decisionClass = rescueToCheck ? 'would' : m.state === 'released' ? 'released' : m.action === 'move' ? 'move' : m.action === 'would-move' ? 'would' : m.action === 'none' ? 'released' : 'flag';
        const act = async (path, body, done) => { acting++; try { await api(path, { method: 'POST', body }); toast(done); render(); } catch (e) { toast(`Couldn't do that: ${e.message}`); } finally { acting--; } };
        const actions = quiet ? null : h('div', { class: 'actions' },
            m.state === 'moved' ? h('button', { class: 'btn primary', type: 'button', onclick: () => act('/api/release', { key: m.key }, 'Released: back in the Inbox.') }, 'Release to Inbox') : null,
            m.falseAlarm !== true ? h('button', { class: 'btn', type: 'button', onclick: () => act('/api/mark', { key: m.key, falseAlarm: true }, 'Marked as a false alarm.') }, 'Mark false alarm') : null,
            m.falseAlarm !== false ? h('button', { class: 'btn', type: 'button', onclick: () => act('/api/mark', { key: m.key, falseAlarm: false }, 'Confirmed as phishing or spam.') }, 'Confirm phishing') : null);
        const verdictText = pasted ? 'Checked from a pasted copy: nothing was stored, moved or counted.'
            : m.falseAlarm === true && m.releasedByUser && !m.markedBy ? 'Counted as a false alarm because the user moved it back. No admin has reviewed it yet.'
            : m.falseAlarm === true ? 'An admin marked this a false alarm.' : m.falseAlarm === false ? 'An admin confirmed this as phishing or spam.' : 'Not reviewed yet.';
        return [quiet ? null : h('button', { class: 'linkbtn back', type: 'button', onclick: back }, '← Back'),
            h(quiet ? 'h2' : 'h1', { class: quiet ? 'pasted-title' : null, text: m.subject || (pasted ? '(no subject)' : '(subject not stored)') }),
            h('p', { class: 'sub', text: `From ${m.sender.name ? `${m.sender.name} <${m.sender.address}>` : m.sender.address || 'an unknown sender'} to ${m.user || '–'}${m.receivedAt ? `, ${when(m.receivedAt)}` : ''}` }),
            h('div', { class: 'grid detail' },
                h('div', { class: 'grid' },
                    h('section', { class: 'card' }, h('h2', { text: 'What happened' }),
                        h('div', { class: `decision ${decisionClass}` }, h('b', { text: pasted ? (PASTED[m.action] || m.action) : m.state === 'released' ? (m.releasedByUser ? 'Moved back to the Inbox by the user' : `Released by ${m.releasedBy}`) : (ACTION[m.action] || [m.action])[0] }), h('div', { text: m.state === 'released' ? `${when(m.releasedAt)}. It was moved because ${m.why}.` : m.why ? `Because ${m.why}.` : 'No sign of phishing from the checks or the AI.' }),
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
                        idRow('Message-ID', m.rfc822MessageId, 'To look it up in Google Workspace: Admin console → Reporting → Email log search (Message ID), or the security investigation tool.'),
                        pasted ? null : idRow('Gmail ID', m.messageId, 'The Gmail API\'s id of this copy, in this mailbox.'),
                        h('dt', { text: 'Checked' }), h('dd', { text: when(m.processedAt) })))))];
    }

    // --- Check an email: what the service would decide for a reported email ----------------------------
    async function check() {
        const area = h('textarea', { class: 'paste', rows: 10, spellcheck: 'false', 'aria-label': 'The email\'s original',
            placeholder: 'In Gmail, open the email, then ⋮ → Show original → Copy to clipboard, and paste it here. Or choose a saved .eml file below.' });
        const file = h('input', { type: 'file', accept: '.eml,message/rfc822,text/plain', 'aria-label': 'An .eml file' });
        const out = h('div', { class: 'check-result', 'aria-live': 'polite' });
        const run = async (raw) => {
            if (!raw.trim()) { toast('Paste the email\'s original first, or choose an .eml file.'); return; }
            acting++;
            out.textContent = '';
            out.append(h('div', { class: 'muted', text: 'Checking…' }));
            try {
                const { result } = await api('/api/check', { method: 'POST', body: { raw } });
                out.textContent = '';
                out.append(...[].concat(emailView(result)).flat(Infinity).filter(Boolean));
            } catch (e) {
                out.textContent = '';
                out.append(h('div', { class: 'alert critical', role: 'alert' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '⚠️' }), h('div', {}, h('b', { text: 'Couldn\'t check it. ' }), e.message)));
            } finally { acting--; }
        };
        file.addEventListener('change', async () => {
            const f = file.files && file.files[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024) { toast('That file is over 10 MB.'); return; }
            run(await f.text());
        });
        return [h('button', { class: 'linkbtn back', type: 'button', onclick: back }, '← Back'),
            h('h1', { text: 'Check an email' }),
            h('p', { class: 'sub', text: 'What the service would decide for an email someone reported, and why: judged as on arrival, in the current mode, with the same lookups. Nothing is stored, moved or counted; Activity notes that you checked one.' }),
            h('section', { class: 'card' }, area, h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => run(area.value) }, 'Check'), file)),
            out];
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
                    h('p', { class: 'small muted', text: `Model: ${d.model || 'unknown'}.` }))),
            trainingCard(d)];
    }

    // --- Model health: examples for retraining the model (off until an admin allows it in Settings) ----
    function trainingCard(d) {
        const title = h('h2', { text: 'Examples for retraining the model' });
        const intro = h('div', { class: 'sub', text: `The emails an admin confirmed as phishing in the last ${days} days (and, if you tick it, the false alarms), one per campaign, newest first, up to 100, as training examples for the AI model. Each is read from Gmail when you download, with the people in it taken out. The file is the only copy: nothing is stored, and Activity notes who downloaded it.` });
        const guide = h('p', { class: 'small muted', text: 'Before the file goes anywhere, follow docs/RETRAINING.md: check every example (words marked ⟦like this⟧ may be names), run tools/check-training-file.js, then train.' });
        if (!d.trainingExport) return h('section', { class: 'card spaced' }, title, intro, h('p', { class: 'small muted', text: 'Off. A dashboard admin can allow it in Settings.' }));
        if (MEMORY) return h('section', { class: 'card spaced' }, title, intro, h('p', { class: 'small muted', text: 'The clickable mockup has no emails to read: in the real dashboard, the download is here.' }), guide);
        const fa = h('input', { type: 'checkbox', 'aria-label': 'Include false alarms' });
        const warn = h('div', { class: 'alert warning', hidden: true }, h('div', { text: 'False alarms are real people\'s mail: parents, staff, companies. Check each one with care, and leave out any you can\'t make anonymous (anything about a student, health, grades or discipline).' }));
        fa.addEventListener('change', () => { warn.hidden = !fa.checked; });
        const result = h('p', { class: 'small muted', role: 'status' });
        const btn = h('button', { class: 'btn', type: 'button' }, 'Download for retraining');
        btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = 'Reading the emails (up to a minute)…'; acting++;
            try {
                const hd = await downloadPost('/api/training-export', { days, falseAlarms: fa.checked });
                const n = (k) => Number(hd.get(`x-spruce-${k}`) || 0);
                const pl = (k, one, many) => `${num(n(k))} ${n(k) === 1 ? one : many}`;
                result.textContent = [`${pl('examples', 'example', 'examples')} in the file: ${num(n('phishing'))} phishing${fa.checked ? `, ${pl('genuine', 'false alarm', 'false alarms')}` : ''}.`,
                    n('gone') ? `${num(n('gone'))} no longer in a mailbox.` : '', n('failed') ? `${num(n('failed'))} couldn't be read.` : '',
                    n('conflicting') ? `${num(n('conflicting'))} campaigns marked both ways left out.` : '',
                    n('not-reached') ? `${num(n('not-reached'))} more not reached: choose a shorter period for the older ones.` : ''].filter(Boolean).join(' ');
                toast('Downloaded. Check it before it goes anywhere.');
            } catch (e) { result.textContent = `Couldn't make the file: ${e.message}`; }
            finally { btn.disabled = false; btn.textContent = 'Download for retraining'; acting--; }
        });
        return h('section', { class: 'card spaced' }, title, intro,
            h('label', { class: 'switch' }, fa, h('span', { text: 'Include false alarms' })), warn,
            h('div', { class: 'actions' }, btn), result, guide);
    }

    async function settings() {
        const d = await api('/api/settings');
        showMode(d.mode);
        const yes = (b) => (b ? 'Yes' : 'No');
        const row = (k, v) => [h('dt', { text: k }), h('dd', { text: v })];
        return [h('h1', { text: 'Settings' }), h('p', { class: 'sub', text: 'The policy below can be changed here, each change confirmed with the Google Cloud project ID; so can the weekly summary email and the retraining export. The rest is set when the service is deployed (deploy/settings.env, docs/DEPLOY.md).' }),
            policyCard(d),
            digestCard(d),
            trainingSettingCard(d),
            h('div', { class: 'grid two' },
                h('section', { class: 'card' }, h('h2', { text: 'Policy' }), h('dl', { class: 'kv' },
                    row('Move when', `${d.moveOnRules ? 'the rules flag it (score 5+), or ' : ''}the AI scores ${pct(d.aiThreshold)} or more`),
                    row('AI alone, inside mail', d.aiMovesInside ? 'Moves it' : 'Never moves it (rules still can)'),
                    row('Campaign hold', `Holds the copies of one campaign after ${num(d.campaignHoldAfter)} moved on weaker evidence, until you confirm or release it. Strong evidence is never held`),
                    row('Alerts', d.alertEmail ? `Emailed to ${d.alertEmail} by Cloud Monitoring` : 'Shown in Recent activity; not emailed (ALERT_EMAIL, deploy/install.sh)'),
                    row('Never moved', [...d.allowDomains, d.allowAddresses ? `${d.allowAddresses} addresses` : ''].filter(Boolean).join(', ') || 'none set'),
                    row('Label on moved mail', d.movedLabel))),
                h('section', { class: 'card' }, h('h2', { text: 'Scope and records' }), h('dl', { class: 'kv' },
                    row('Organization', d.orgDomains.join(', ') || '–'),
                    row('Mailboxes watched', `${num(d.watched)}${[...(d.pilotGroups || []).map(g => `group ${g}`), d.pilotOu ? `unit ${d.pilotOu}` : ''].filter(Boolean).map(s => ` (${s})`).join('')}`),
                    row('Records kept', `${d.retentionDays} days`),
                    row('Version', d.version || ''),
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
        return acting > 0 || pageBusy() || !tip().hidden || (a && a !== v && v.contains(a))
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
        // (not on Check an email: its answer isn't fetched again)
        if (!document.hidden) refreshPending();
        if (live && !document.hidden && Date.now() - updatedAt >= LIVE_MS && !inUse() && !/^#\/?(check|review)/.test(currentHash())) render({ quiet: true });
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

    // --- Review: the emails nobody has reviewed, one at a time (F, P, N) ----------------------------------
    let reviewState = null, reviewKeys = null;
    async function review(params) {
        if (!reviewState || params.get('restart') || reviewState.days !== days) {
            const d = await api(`/api/review?days=${days}`);
            reviewState = { keys: d.keys, i: 0, done: 0, days };
        }
        const st = reviewState;
        reviewKeys = null;
        const head = [h('h1', { text: 'Review' })];
        if (st.i >= st.keys.length) {
            return [...head, h('div', { class: 'alert good', role: 'status' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '✅' }),
                h('div', { class: 'grow' }, h('b', { text: 'Nothing left to review.' }), ` ${num(st.done)} reviewed now; every moved or "would move" email of the last ${days} days has been looked at.`)),
                h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/readiness' }, 'See Readiness'), h('a', { class: 'btn', href: '#/review?restart=1' }, 'Look again'))];
        }
        const key = st.keys[st.i];
        let m;
        try { ({ message: m } = await api(`/api/message?${q({ key })}`)); } catch (e) { st.i++; return review(new URLSearchParams()); }
        if (m.markedBy) { st.i++; return review(new URLSearchParams()); }   // (someone reviewed it meanwhile)
        const decide = async (falseAlarm) => {
            acting++;
            try { await api('/api/mark', { method: 'POST', body: { key, falseAlarm } }); st.done++; st.i++; toast(falseAlarm ? 'Marked as a false alarm.' : 'Confirmed as phishing.'); render(); }
            catch (e) { toast(`Couldn't do that: ${e.message}`); } finally { acting--; }
        };
        const next = () => { st.i++; render(); };
        reviewKeys = { f: () => decide(true), p: () => decide(false), n: next };
        return [...head,
            h('p', { class: 'sub', text: `${num(st.i + 1)} of ${num(st.keys.length)} moved or "would move" emails nobody has reviewed (last ${days} days, oldest first). Keys: F false alarm, P phishing, N next.` }),
            h('div', { class: 'review-bar card' },
                h('button', { class: 'btn', type: 'button', onclick: () => decide(true) }, h('kbd', { text: 'F' }), ' False alarm'),
                h('button', { class: 'btn', type: 'button', onclick: () => decide(false) }, h('kbd', { text: 'P' }), ' Phishing'),
                h('button', { class: 'btn', type: 'button', onclick: next }, h('kbd', { text: 'N' }), ' Next, undecided'),
                h('a', { class: 'linkbtn', href: `#/message?${q({ key })}` }, 'Open it with its other buttons')),
            ...[].concat(emailView(m, { inReview: true }))];
    }

    // --- Status: the service end to end, as checks with what to do ---------------------------------------
    async function status() {
        const d = await api('/api/status');
        const bad = d.checks.filter(c => c.ok === false).length, unknown = d.checks.filter(c => c.ok === null).length;
        return [h('h1', { text: 'Status' }),
            h('p', { class: 'sub', text: 'Whether the service works end to end, checked from here. In Cloud Shell, bash deploy/doctor.sh checks more (the subscription, Gmail\'s permission to publish, the alert policies) and says what to run.' }),
            h('div', { class: `alert ${bad ? 'critical' : unknown ? 'warning' : 'good'}`, role: 'status' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: bad ? '⛔' : unknown ? '⏳' : '✅' }),
                h('div', { class: 'grow' }, h('b', { text: bad ? `${bad} problem${bad === 1 ? '' : 's'} to fix.` : unknown ? 'No problem found, but not everything could be checked.' : 'Everything checked works.' }))),
            h('section', { class: 'card' }, h('ul', { class: 'checks' }, d.checks.map(c => h('li', { class: c.ok === true ? 'ok' : c.ok === false ? 'todo' : 'unknown' },
                h('span', { class: 'mark', 'aria-hidden': 'true', text: c.ok === true ? '✓' : c.ok === false ? '!' : '?' }),
                h('span', { class: 'sr-only', text: c.ok === true ? 'Works: ' : c.ok === false ? 'Problem: ' : 'Not checked: ' }),
                h('div', {}, h('div', { text: c.text }), c.fix ? h('div', { class: 'muted small', text: `What to do: ${c.fix}` }) : null)))))];
    }

    // --- Settings: the weekly summary email (off by default) ---------------------------------------------
    function digestCard(d) {
        const g = d.digest || { enabled: false };
        const preview = h('pre', { class: 'digest-preview', hidden: true });
        const toggle = h('input', { type: 'checkbox', role: 'switch', checked: !!g.enabled, 'aria-label': 'Send the weekly summary email' });
        toggle.addEventListener('change', async () => {
            acting++;
            try { await api('/api/digest', { method: 'POST', body: { enabled: toggle.checked } }); toast(toggle.checked ? 'The weekly summary is on.' : 'The weekly summary is off.'); render(); }
            catch (e) { toggle.checked = !toggle.checked; toast(`Couldn't change it: ${e.message}`); } finally { acting--; }
        });
        const show = async () => {
            try { const { preview: p } = await api('/api/digest/preview'); preview.textContent = `Subject: ${p.subject}\n\n${p.text}`; preview.hidden = false; }
            catch (e) { toast(`Couldn't make the preview: ${e.message}`); }
        };
        const facts = [g.updatedBy ? `Turned ${g.enabled ? 'on' : 'off'} by ${g.updatedBy}, ${when(g.updatedAt)}.` : 'Off: nobody has turned it on.', g.lastSentAt ? `Last sent ${when(g.lastSentAt)}.` : ''].filter(Boolean).join(' ');
        return h('section', { class: 'card spaced' }, h('h2', { text: 'Weekly summary email' }),
            h('div', { class: 'sub', text: `Every Monday from 7 AM (${d.timeZone || 'UTC'}), a summary of the week goes into the Inbox of each dashboard admin (ADMIN_EMAILS, and the members of ADMIN_GROUP): what was checked and moved, false alarms, what waits for you, the largest campaigns.` }),
            h('label', { class: 'switch' }, toggle, h('span', { text: 'Send the weekly summary' })),
            h('div', { class: 'small muted', text: facts }),
            h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: show }, 'Preview'),
                MEMORY ? null : h('button', { class: 'btn', type: 'button', onclick: postButton('/api/digest/send', () => ({}), (o) => (o.demo ? 'Demo mode: nothing sent.' : `Put in ${num(o.sent)} admin Inbox${o.sent === 1 ? '' : 'es'}${o.failed && o.failed.length ? `; ${o.failed.length} couldn't be reached` : ''}.`),
                    'Put this week\'s summary in every dashboard admin\'s Inbox now?') }, 'Send one now')),
            preview);
    }

    // --- Settings: the policy, changed here with the project ID ---------------------------------------------
    // Mode, the AI move threshold, the brake and the time zone. Each Change opens a form under its row; it
    // needs the project ID, and switching to enforce mode the agreement too. Live updates wait while a form
    // is open. deploy/install.sh asks which to keep when settings.env says otherwise (deploy/dashboard-policy.sh).
    const POLICY_ROWS = [
        { key: 'mode', label: 'Mode', show: (v) => (v === 'enforce' ? 'Enforce: emails the policy flags are moved to Spam' : 'Monitor: emails are checked and recorded, nothing is moved') },
        { key: 'aiThreshold', label: 'AI move threshold', show: (v) => `${pct(v)}: an email the AI scores this high or higher is moved (rules aside)` },
        { key: 'brakePerHour', label: 'Brake (whole domain)', show: (v, d) => (v ? `${num(v)} moves an hour, then moving stops everywhere until an admin resumes` : `Automatic: ${num(d.brakeLimit)} moves an hour now (half the watched mailboxes, at least 100), then moving stops until an admin resumes`) },
        { key: 'timeZone', label: 'Time zone', show: (v) => `${v || 'UTC'}: the weekly summary, and the nightly jobs` }
    ];
    const ENV_NAME = { mode: 'MODE', aiThreshold: 'AI_MOVE_THRESHOLD', brakePerHour: 'BRAKE_PER_HOUR', timeZone: 'TIME_ZONE' };
    function policyCard(d) {
        const P = d.policy || {};
        let openKey = null;
        pageBusy = () => !!openKey;
        const short = (key, v) => (key === 'mode' ? v : key === 'aiThreshold' ? pct(v) : key === 'brakePerHour' ? (v ? `${num(v)} an hour` : 'automatic') : v);
        const source = (key) => {
            const p = P[key] || {};
            if (p.changed) return `Changed here by ${p.changed.by}, ${when(p.changed.at)}. settings.env (${ENV_NAME[key]}) says ${short(key, p.env)}.`;
            if (p.replaced) return `From settings.env (${ENV_NAME[key]}). It replaced ${short(key, p.replaced.value)}, set here by ${p.replaced.by}.`;
            return `From settings.env (${ENV_NAME[key]}).`;
        };
        const rows = POLICY_ROWS.map(r => {
            const value = (P[r.key] || {}).value !== undefined ? P[r.key].value : d[r.key];
            const slot = h('div', { class: 'policy-form-slot' });
            const button = h('button', { class: 'btn', type: 'button', 'aria-expanded': 'false' }, 'Change');
            button.addEventListener('click', () => {
                for (const el of box.querySelectorAll('.policy-form-slot')) el.textContent = '';
                for (const b of box.querySelectorAll('button[aria-expanded]')) b.setAttribute('aria-expanded', 'false');
                if (openKey === r.key) { openKey = null; return; }
                openKey = r.key; button.setAttribute('aria-expanded', 'true');
                slot.append(policyForm(r.key, value, d, () => { openKey = null; slot.textContent = ''; button.setAttribute('aria-expanded', 'false'); }));
                const first = slot.querySelector('input, select'); if (first) first.focus();
            });
            return h('div', { class: 'policy-row' },
                h('div', { class: 'policy-head' }, h('div', { class: 'policy-label', text: r.label }),
                    h('div', { class: 'policy-value' }, h('div', { text: r.show(value, d) }), h('div', { class: 'small muted', text: source(r.key) })),
                    d.projectKnown ? button : null),
                slot);
        });
        const box = h('section', { class: 'card spaced' }, h('h2', { text: 'Policy' }),
            h('div', { class: 'sub', text: 'Each change needs the Google Cloud project ID, applies within 30 seconds, is noted in Status → Activity, and is emailed as an alert (the time zone is only noted). When deploy/settings.env says something else, deploy/install.sh (and upgrade.sh) asks which to keep, and writes the answer into settings.env.' }),
            d.projectKnown ? null : h('div', { class: 'alert warning' }, h('div', { text: 'This dashboard doesn\'t know its Google Cloud project (GOOGLE_CLOUD_PROJECT), so these can\'t be changed here yet. Run bash deploy/install.sh once.' })),
            rows);
        return box;
    }
    function policyForm(key, value, d, close) {
        const err = h('div', { class: 'policy-error', role: 'alert' });
        const project = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'project-id', 'aria-label': 'Google Cloud project ID' });
        const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
        const cancel = h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel');
        let read = () => value, extra = [], agreeBox = null;
        const update = () => { save.disabled = !project.value.trim() || (agreeBox && !agreeBox.hidden && !agreeBox.querySelector('input').checked); };
        if (key === 'mode') {
            const radio = (v, label) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'policy-mode', value: v, checked: v === value }), h('span', { text: label }));
            const choices = h('div', { class: 'choices' }, radio('monitor', 'Monitor: record only, move nothing'), radio('enforce', 'Enforce: move what the policy flags to Spam'));
            const ready = h('div', { class: 'small muted' });
            agreeBox = h('div', { class: 'agree', hidden: true },
                h('div', { class: 'alert warning' }, h('div', {}, h('b', { text: 'Enforce mode moves mail. ' }), 'From the moment you save, emails the rules flag, or the AI scores at the threshold or higher, are moved to Spam in every watched mailbox (the brakes still apply; emails already recorded as "would move" stay where they are).', ready)),
                h('label', { class: 'choice' }, h('input', { type: 'checkbox', onchange: update }), h('span', { text: 'I agree: I have looked at Status → Readiness, and I want emails moved to Spam from now on.' })));
            const sync = async () => {
                const v = choices.querySelector('input:checked').value;
                agreeBox.hidden = !(v === 'enforce' && value !== 'enforce'); update();
                if (!agreeBox.hidden && !ready.textContent) {
                    try { const { readiness: r } = await api(`/api/readiness?days=${days}`); const ok = r.checks.filter(c => c.ok).length; ready.textContent = ` Readiness: ${ok} of ${r.checks.length} checks pass.`; }
                    catch (e) { ready.textContent = ' (Couldn\'t read Readiness.)'; }
                }
            };
            choices.addEventListener('change', sync);
            read = () => choices.querySelector('input:checked').value;
            extra = [choices, agreeBox, value === 'enforce' ? h('div', { class: 'small muted', text: 'Monitor mode: nothing is moved from then on; emails already moved stay in Spam.' }) : null];
        } else if (key === 'aiThreshold') {
            const input = h('input', { type: 'number', min: 51, max: 100, step: 1, value: String(Math.round(value * 100)), 'aria-label': 'AI move threshold in percent', class: 'num-input' });
            read = () => Number(input.value) / 100;
            extra = [h('label', { class: 'inline' }, input, h('span', { text: '%' })), h('div', { class: 'small muted', text: 'Higher moves fewer emails on the AI score alone. Status → Model health shows how often moves on the AI score were undone.' })];
        } else if (key === 'brakePerHour') {
            const auto = h('input', { type: 'radio', name: 'policy-brake', value: 'auto', checked: !value });
            const fixed = h('input', { type: 'radio', name: 'policy-brake', value: 'fixed', checked: !!value });
            const n = h('input', { type: 'number', min: 10, max: 100000, step: 1, value: String(value || d.brakeLimit || 100), 'aria-label': 'Moves an hour', class: 'num-input' });
            n.addEventListener('focus', () => { fixed.checked = true; });
            read = () => (auto.checked ? 0 : Number(n.value));
            extra = [h('div', { class: 'choices' }, h('label', { class: 'choice' }, auto, h('span', { text: 'Automatic: half the watched mailboxes, at least 100' })),
                h('label', { class: 'choice inline-choice' }, fixed, h('span', { text: 'A fixed limit:' }), n, h('span', { text: 'moves an hour' }))),
                h('div', { class: 'small muted', text: 'After this many moves in one hour, moving stops everywhere until an admin resumes (Overview). Strong evidence still counts toward it.' })];
        } else if (key === 'timeZone') {
            let zones = [];
            try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { /* an older browser: typed in */ }
            const input = zones.length ? h('select', { 'aria-label': 'Time zone' }, (zones.includes(value) ? zones : [value, ...zones]).map(z => h('option', { value: z, selected: z === value, text: z })))
                : h('input', { type: 'text', value, 'aria-label': 'Time zone', placeholder: 'America/New_York' });
            read = () => input.value;
            extra = [input, h('div', { class: 'small muted', text: 'The weekly summary uses it at once. The nightly jobs move to it the next time deploy/install.sh runs.' })];
        }
        project.addEventListener('input', update); update();
        save.addEventListener('click', async () => {
            err.textContent = ''; save.disabled = true; acting++;
            try {
                const out = await api('/api/policy', { method: 'POST', body: { key, value: read(), projectId: project.value, agree: !!(agreeBox && agreeBox.querySelector('input').checked) } });
                toast(out.changed && out.changed.unchanged ? 'That is already the setting: nothing changed.' : 'Changed. It applies everywhere within 30 seconds.');
                close(); render();
            } catch (e) { err.textContent = e.message; update(); }
            finally { acting--; }
        });
        return h('div', { class: 'policy-form' }, extra,
            h('label', { class: 'project' }, h('span', { text: 'Google Cloud project ID, to confirm' }), project),
            d.demoProjectId ? h('div', { class: 'small muted', text: `Demo mode: the project ID is ${d.demoProjectId}.` }) : null,
            h('div', { class: 'actions' }, save, cancel), err);
    }

    // --- Settings: the retraining export (off by default) -----------------------------------------------
    function trainingSettingCard(d) {
        const g = d.trainingExport || { enabled: false };
        const toggle = h('input', { type: 'checkbox', role: 'switch', checked: !!g.enabled, 'aria-label': 'Allow the retraining export' });
        toggle.addEventListener('change', async () => {
            acting++;
            try { await api('/api/training-export/allow', { method: 'POST', body: { enabled: toggle.checked } }); toast(toggle.checked ? 'The retraining export is allowed (Status → Model health).' : 'The retraining export is off.'); render(); }
            catch (e) { toggle.checked = !toggle.checked; toast(`Couldn't change it: ${e.message}`); } finally { acting--; }
        });
        const facts = g.updatedBy ? `${g.enabled ? 'Allowed' : 'Turned off'} by ${g.updatedBy}, ${when(g.updatedAt)}.` : 'Off: nobody has allowed it.';
        return h('section', { class: 'card spaced' }, h('h2', { text: 'Retraining export' }),
            h('div', { class: 'sub', text: 'Lets dashboard admins download the emails an admin marked, with the people in them taken out, to retrain the AI model (Status → Model health → Download for retraining; docs/RETRAINING.md). Each download reads those emails from Gmail at that moment: the file is the only copy, and Activity notes who downloaded it. Turn it on only while someone is preparing training examples.' }),
            h('label', { class: 'switch' }, toggle, h('span', { text: 'Allow the retraining export' })),
            h('div', { class: 'small muted', text: facts }));
    }

    // The tab's title shows how many things need you (the brake, held campaigns, users who took flagged
    // mail back); the Email tab and its Review item, how many emails wait for review. Every 30 s, with
    // the live updates.
    let pendingAt = 0, unreviewed = 0;
    function showUnreviewed() {
        const badge = $('#reviewCount');
        if (badge) { badge.hidden = !unreviewed; badge.textContent = num(unreviewed); badge.title = `${num(unreviewed)} email${unreviewed === 1 ? '' : 's'} to review`; }
        const item = document.querySelector('.side a[data-page="review"]');
        if (item) item.textContent = unreviewed ? `Review (${num(unreviewed)})` : 'Review';
    }
    async function refreshPending() {
        if (Date.now() - pendingAt < 25000) return;
        pendingAt = Date.now();
        try {
            const p = await api('/api/pending');
            document.title = p.total ? `(${p.total}) Mail Protection Admin` : 'Mail Protection Admin';
            unreviewed = p.unreviewed || 0;
            showUnreviewed();
        } catch (e) { /* the next tick tries again */ }
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
    const ROUTES = { overview, review, campaigns, users, messages, message, check, health, readiness, activity, status, settings };
    // The top tabs: Overview, Email, Status, Settings. Email and Status each have a menu on the left; the
    // pages keep their own addresses (#/review, #/health…), so links to them still work. An email's page
    // and "Check an email" belong to Messages.
    const SECTIONS = {
        email: { label: 'Email', pages: [['review', 'Review'], ['campaigns', 'Campaigns'], ['messages', 'Messages'], ['users', 'Users']] },
        status: { label: 'Status', pages: [['status', 'Service status'], ['health', 'Model health'], ['readiness', 'Readiness'], ['activity', 'Activity']] }
    };
    const PAGE_OF = { message: 'messages', check: 'messages' };
    function placeOf(name) {
        const page = PAGE_OF[name] || name;
        const section = Object.keys(SECTIONS).find(k => SECTIONS[k].pages.some(([p]) => p === page));
        return { page, section, tab: section || page };
    }
    function withSideMenu(section, page, nodes) {
        const s = SECTIONS[section];
        const menu = h('nav', { class: 'side', 'aria-label': s.label },
            s.pages.map(([p, label]) => h('a', { href: `#/${p}`, 'data-page': p, 'aria-current': p === page ? 'page' : null,
                text: p === 'review' && unreviewed ? `${label} (${num(unreviewed)})` : label })));
        return h('div', { class: 'with-side' }, menu, h('div', { class: 'side-page' }, nodes));
    }
    let pageBusy = () => false;   // a page sets it when live updates should wait (Messages with emails selected)
    let rendering = 0;
    // quiet: a live update (no loading fade, the scroll position kept, and on failure the page stays).
    async function render({ quiet = false } = {}) {
        const [path, query] = (currentHash().replace(/^#\/?/, '') || 'overview').split('?');
        const name = ROUTES[path] ? path : 'overview';
        const place = placeOf(name);
        for (const a of document.querySelectorAll('.tabs a')) { if (a.dataset.tab === place.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
        for (const b of document.querySelectorAll('.range')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
        const id = ++rendering;
        if (!quiet) { view().classList.add('loading'); hideTip(); }
        pageBusy = () => false;
        const scrollY = window.scrollY;
        try {
            let nodes = [].concat(await ROUTES[name](new URLSearchParams(query || ''))).flat(Infinity).filter(Boolean);
            if (id !== rendering) return;
            if (place.section) nodes = [withSideMenu(place.section, place.page, nodes)];
            view().textContent = '';
            view().append(...nodes);
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
        // The review queue's keys (not while typing, nor with Ctrl, Alt or Cmd).
        document.addEventListener('keydown', (e) => {
            if (!reviewKeys || !/^#\/?review/.test(currentHash()) || e.ctrlKey || e.metaKey || e.altKey || acting) return;
            if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
            const f = reviewKeys[String(e.key).toLowerCase()];
            if (f) { e.preventDefault(); f(); }
        });
        refreshPending();
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
            showMode(st.mode);
            if (st.demo) $('.top-right').prepend(h('span', { class: 'demo-flag', text: 'DEMO · made-up data' }));
            $('#foot').textContent = `Checks and AI model from S.P.R.U.C.E+ (${st.model.name} ${st.model.version}). Records hold sender, subject and the checks' findings, never email bodies, and are deleted after ${st.retentionDays} days.`;
        } catch (e) { /* the view shows the error */ }
        render();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
