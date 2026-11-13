// S.P.R.U.C.E Mail Protection Service: the admin dashboard page. Plain JavaScript, no libraries, no build step.
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
    // The AI move threshold and suspicious line in force, and whether the AI alone moves inside mail (every
    // answer says them; 90%, 65% and off until the first one).
    let aiThreshold = 0.9, aiSuspicious = 0.65, aiMovesInside = false;
    const api = async (path, opts) => {
        const data = await (window.SPRUCE_API || realApi)(path, opts);
        if (data && typeof data.aiThreshold === 'number') aiThreshold = data.aiThreshold;
        if (data && typeof data.aiSuspicious === 'number') aiSuspicious = data.aiSuspicious;
        if (data && typeof data.aiMovesInside === 'boolean') aiMovesInside = data.aiMovesInside;
        return data;
    };
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
    const STATE = { moved: ['In Spam', 'moved'], released: ['Moved back', 'released'], inbox: ['In Inbox', 'inbox'] };
    const stateOf = (m) => (m.state === 'released' && m.releasedByUser ? ['Moved back by user', 'released'] : STATE[m.state] || [m.state, '']);
    const pill = ([label, cls]) => h('span', { class: `pill ${cls}`, text: label });
    // Re-checked after delivery (0.5.35): what happened, and the outcomes that mean phishing had been delivered.
    const RECHECK_BAD = ['moved', 'would-move', 'held', 'not-in-inbox'];
    const WHERE = { archived: 'archived by its reader', spam: 'in Spam', trash: 'in the Trash', inbox: 'in the Inbox' };

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

    // --- Popup: an in-page dialog over the page (Escape or Close closes it; the page's keys wait meanwhile) ----
    function popup(title, ...content) {
        const close = h('button', { class: 'linkbtn', type: 'button', text: 'Close' });
        const dlg = h('dialog', { class: 'popup', 'aria-label': title },
            h('div', { class: 'popup-head' }, h('h2', { text: title }), close),
            h('div', { class: 'popup-body' }, ...content));
        close.addEventListener('click', () => dlg.close());
        dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // a click outside the box
        dlg.addEventListener('close', () => dlg.remove());
        document.body.append(dlg);
        if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
        return dlg;
    }
    const popupOpen = () => !!document.querySelector('dialog.popup[open]');
    // A list that shows its first two, then "…show more": the rest in a popup.
    function shortList(items, title, { describe = (n) => `${n} in all` } = {}) {
        if (items.length <= 2) return h('span', { text: items.join(', ') });
        const more = h('button', { class: 'linkbtn', type: 'button', text: `…show more (${items.length - 2})` });
        more.addEventListener('click', () => popup(title, h('p', { class: 'sub', text: describe(items.length) }), h('ul', { class: 'plain-list' }, items.map(x => h('li', { text: x })))));
        return h('span', {}, `${items.slice(0, 2).join(', ')} `, more);
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
    // Stacked columns, one per day; series: [{ key, name, color }]. totals: the tooltip also gives the day's
    // emails checked (first) and moved back (last), when the rows have them (Overview's trend).
    function stackedColumns(rows, series, { label = 'day', totals = false } = {}) {
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
            const checked = totals && typeof r.scanned === 'number' ? [{ name: 'Emails checked', value: num(r.scanned) }] : [];
            const back = totals && typeof r.released === 'number' ? [{ name: 'Moved back', value: num(r.released) }] : [];
            const g = s('g', { class: 'bar', tabindex: 0, role: 'img',
                'aria-label': `${dayLabel(r.day)}: ${[...checked, ...series.map(se => ({ name: se.name, value: r[se.key] || 0 })), ...back].map(x => `${x.name} ${x.value}`).join(', ')}` });
            segs.forEach((se, j) => {
                const v = r[se.key];
                const y0 = y(acc), y1 = y(acc + v);
                const top = j === segs.length - 1;
                const hgt = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));           // 2px surface gap between segments
                if (hgt > 0) g.append(s('path', { d: colPath(x, y1, bw, hgt, top), fill: css(se.color) }));
                acc += v;
            });
            g.append(s('rect', { class: 'hit', x: L + i * band, y: T, width: band, height: ph }));
            const rowsTip = [...checked, ...series.map(se => ({ name: se.name, value: num(r[se.key] || 0), color: css(se.color) })), ...back];
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
            const g = s('g', { class: 'bar', tabindex: 0, role: 'img', 'aria-label': `AI ${b.from}–${b.to}%: ${b.count} emails, ${b.released} moved back` });
            if (b.count) g.append(s('path', { d: colPath(x, y(b.count), bw, y(0) - y(b.count), true), fill: css('--s1') }));
            g.append(s('rect', { class: 'hit', x: L + i * band, y: T, width: band, height: ph }));
            const rows = [{ name: 'Emails', value: num(b.count) }, { name: 'Moved back (false alarm)', value: num(b.released) }];
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
    // rowClass: a row's class (or ''), for a row that needs attention.
    function dataTable(cols, rows, rowClass = null) {
        return h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'num' : '', text: c.name })))),
            h('tbody', {}, rows.map(r => h('tr', { class: (rowClass && rowClass(r)) || '' }, cols.map(c => h('td', { class: c.num ? 'num' : '' }, c.get(r))))))));
    }
    // The red alert icon, beside something that needs an admin (a phishing list that missed its download).
    const alertIcon = (label) => h('span', { class: 'alert-icon', role: 'img', 'aria-label': label, title: label, text: '!' });
    // Phishing found after it was delivered (0.5.35), on the Overview and Messages until an admin marks it seen.
    function recheckBanner(rc) {
        if (!rc) return null;
        const one = rc.emails === 1;
        return h('div', { class: 'alert critical recheck-alert', role: 'alert' }, alertIcon('Alert'),
            h('div', { class: 'grow' }, h('b', { text: `${one ? 'An email' : `${num(rc.emails)} emails`} already delivered ${one ? 'was' : 'were'} found to be phishing on a re-check.` }),
                ` ${num(rc.people)} ${rc.people === 1 ? 'person' : 'people'} got ${one ? 'it' : 'them'}: ${num(rc.moved)} moved to Spam since, ${num(rc.opened)} opened before that`,
                rc.clicked ? h('b', { text: `, ${num(rc.clicked)} with a link clicked` }) : null, '. The admins were sent an alert. ',
                h('a', { href: '#/rechecked', text: 'Who got them, and what they did: Email → Re-checked' }), '.'));
    }
    // A table whose rows open something (mouse or keyboard).
    function clickTable(cols, rows, open, empty = 'Nothing in this period.', rowClass = null) {
        if (!rows.length) return h('div', { class: 'empty', text: empty });
        return h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'num' : '', text: c.name })))),
            h('tbody', {}, rows.map(r => h('tr', { class: `clickable ${(rowClass && rowClass(r)) || ''}`.trim(), tabindex: 0, onclick: () => open(r), onkeydown: (e) => { if (e.key === 'Enter') open(r); } },
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
            const resume = (moveHeld) => postButton('/api/resume', () => ({ moveHeld }), (o) => (moveHeld && o.held && !o.held.monitor ? `Moving resumed: ${num(o.held.moved)} moved to Spam${o.held.left ? `; ${num(o.held.left)} to go, press again` : ''}.` : 'Moving resumed.'),
                moveHeld ? `Resume moving, and move the ${num(held)} emails the brake left in the Inbox to Spam now?` : 'Resume moving, and leave those emails in the Inbox?');
            out.push(h('div', { class: 'alert critical', role: 'alert' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '⛔' }),
                h('div', { class: 'grow' }, h('b', { text: 'Moving is paused (brake).' }), ` ${num(d.brake.moves)} emails were moved within an hour (the limit is ${num(d.brake.limit || d.brake.moves)}). Since then, ${num(held)} emails that would have been moved were left in the Inbox, like any other email; resuming can move them now.`),
                h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: resume(true) }, `Resume, and move those ${num(held)} to Spam`),
                    h('button', { class: 'btn', type: 'button', onclick: resume(false) }, 'Resume, and leave them in the Inbox'))));
        }
        if (d.heldCampaigns && d.heldCampaigns.length) out.push(h('div', { class: 'alert warning', role: 'status' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '✋' }),
            h('div', { class: 'grow' }, h('b', { text: `Moving is paused for ${d.heldCampaigns.length} campaign${d.heldCampaigns.length === 1 ? '' : 's'}, waiting for your decision.` }),
                ' Many copies were moved on evidence nothing outside the email confirms, so its other copies are left in the Inbox, like any email not moved. Open one to confirm it as phishing (every copy is moved to Spam) or dismiss it as a false alarm (the moved ones go back to the Inbox).',
                h('ul', { class: 'held-list' }, d.heldCampaigns.slice(0, 5).map(c => h('li', {}, h('a', { href: `#/messages?${q({ campaign: c.campaign })}`, text: c.label }), ` (${num(c.held)} left in the Inbox)`))))));
        // A phishing list that missed its download (0.5.22): until it downloads again; the details on About.
        if (d.missedLists && d.missedLists.length) {
            const ml = d.missedLists, one = ml.length === 1;
            out.push(h('div', { class: 'alert critical lists-alert', role: 'alert' }, alertIcon('Alert'),
                h('div', { class: 'grow' }, h('b', { text: `${one ? 'A phishing list' : `${num(ml.length)} phishing lists`} missed ${one ? 'its' : 'their'} download: ${ml.map(l => l.name).join(', ')}.` }),
                    ` The checks still use ${one ? 'its' : 'their'} previous copy, and ${one ? 'it is' : 'they are'} tried again every 3 hours; the admins were sent an alert. `,
                    h('a', { href: '#/about?show=lists', text: 'Details, and Re-check, on the About page' }), '.')));
        }
        if (d.rechecked) out.push(recheckBanner(d.rechecked));
        // New look-alikes of your domain, until an admin marks them (0.5.36).
        if (d.lookalikes && d.lookalikes.length) out.push(h('div', { class: 'alert critical', role: 'alert' }, alertIcon('Alert'),
            h('div', { class: 'grow' }, h('b', { text: `${d.lookalikes.length === 1 ? 'A domain that imitates yours was' : `${num(d.lookalikes.length)} domains that imitate yours were`} registered: ${d.lookalikes.slice(0, 5).join(', ')}${d.lookalikes.length > 5 ? '…' : ''}.` }),
                ' Mail from them counts as a strong sign of phishing. The admins were sent an alert. ', h('a', { href: '#/lookalikes', text: 'Details, and marking one as the district\'s own: Status → Look-alikes' }), '.')));
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
        const chartBox = h('div', { class: 'chart' }, stackedColumns(d.trend, TREND_SERIES, { totals: true }));
        let asTable = false;
        const toggle = h('button', { class: 'linkbtn', type: 'button', text: 'Show as table' });
        toggle.addEventListener('click', () => {
            asTable = !asTable; toggle.textContent = asTable ? 'Show as chart' : 'Show as table'; chartBox.textContent = '';
            chartBox.append(asTable ? dataTable([{ name: 'Day', get: r => dayLabel(r.day) }, { name: 'Checked', num: true, get: r => num(r.scanned) }, ...TREND_SERIES.map(se => ({ name: se.name, num: true, get: r => num(r[se.key]) })), { name: 'Moved back', num: true, get: r => num(r.released) }], d.trend.slice().reverse())
                                    : stackedColumns(d.trend, TREND_SERIES, { totals: true }));
        });
        out.push(h('div', { class: 'grid two' },
            h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: 'Emails moved per day' }), h('div', { class: 'sub', text: 'By what triggered the move; hover a day for its numbers and the emails checked that day.' })), toggle), legend(TREND_SERIES), chartBox),
            h('section', { class: 'card' }, h('h2', { text: 'Top reasons' }), h('div', { class: 'sub', text: 'Signs found in moved and would-move emails.' }),
                d.topReasons.length ? hbars(d.topReasons.map(r => ({ name: r.reason, value: r.count }))) : h('div', { class: 'empty', text: 'Nothing moved in this period.' }))));
        out.push(h('div', { class: 'grid two' },
            h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: 'Largest campaigns' }), h('div', { class: 'sub', text: 'The same email sent to many people.' })), h('a', { href: '#/campaigns', text: 'All campaigns' })),
                campaignTable(d.campaigns)),
            h('section', { class: 'card' }, h('h2', { text: 'Recent activity' }), h('div', { class: 'sub', text: 'Alerts, emails moved back, and changes, last 7 days.' }),
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
            : c.decision === 'released' ? `Dismissed as a false alarm by ${c.decidedBy}: its moved copies went back to the Inbox, and later ones aren't moved.`
            : c.held ? `Moving is paused: ${num(c.held)} copies were left in the Inbox, because over ${num(c.holdAfter)} were moved on evidence nothing outside the email confirms. Confirm it as phishing, or dismiss it as a false alarm.`
            : `${num(c.copies)} copies recorded: ${num(c.moved)} in Spam, ${num(c.recorded)} in the Inbox, ${num(c.released)} moved back.`;
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
                c.decision !== 'released' ? h('button', { class: 'btn', type: 'button', onclick: postButton('/api/campaign/release', () => ({ key }), (o) => `Moved back: ${num(o.released)} copies in the Inbox again.`,
                    `Move every copy of "${c.label}" back to the Inbox, and stop moving it?`) }, 'False alarm: move every copy back') : null,
                c.decision === 'confirmed' ? h('button', { class: 'btn', type: 'button', onclick: postButton('/api/campaign/find', () => ({ key }), (o) => `Searched: ${num(o.found.found)} more found in ${num(o.found.searched)} of ${num(o.found.of)} mailboxes${o.found.moved ? `, ${num(o.found.moved)} moved` : ''}.`) }, 'Find other copies') : null));
    }
    const kpi = (label, value, note) => h('div', { class: 'card kpi' }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), note ? h('div', { class: 'note', text: note }) : null);

    function campaignTable(list) {
        return clickTable([
            { name: 'Campaign', cls: 'trunc', get: c => h('div', {}, h('div', { text: c.subject || '(subject not stored)' }), h('div', { class: 'muted small', text: c.senderDomain })) },
            { name: 'People', num: true, get: c => num(c.recipients) },
            { name: 'Moved', num: true, get: c => num(c.moved) },
            { name: 'Would move', num: true, get: c => num(c.wouldMove) },
            { name: 'Moved back', num: true, get: c => num(c.released) },
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
                { name: 'Moved back', num: true, get: c => num(c.released) },
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
                { name: 'Moved back', num: true, get: u => num(u.released) },
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
            h('button', { class: 'btn', type: 'button', onclick: bulk('release', 'Moved back to the Inbox', 'Move the selected emails that are in Spam back to the Inbox?') }, 'Move back to Inbox'),
            h('button', { class: 'btn', type: 'button', onclick: bulk('false-alarm', 'Marked as false alarms') }, 'Mark false alarm'),
            h('button', { class: 'btn', type: 'button', onclick: bulk('phishing', 'Confirmed as phishing') }, 'Confirm phishing'),
            h('button', { class: 'linkbtn', type: 'button', onclick: () => { selected.clear(); all.checked = false; for (const [, c] of boxes) c.checked = false; changed(); } }, 'Clear'));
        return [h('h1', { text: `Messages ${scope}`.trim() }),
            h('p', { class: 'sub' }, `${num(d.total)} recorded in the last ${days} days. `, (filt.user || filt.campaign) ? h('a', { href: '#/messages', text: 'Show all' }) : null),
            recheckBanner(d.rechecked),
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
                { name: 'Action', get: m => (m.recheck ? h('span', { class: 'found-later' }, alertIcon(`Found after it was delivered (re-checked ${when(m.recheck.at)})${m.recheck.clicked ? ': a link in it was clicked' : m.recheck.opened ? ': it had been opened' : ''}`), pill(ACTION[m.action] || [m.action, '']), h('span', { class: 'small muted', text: ' found later' }))
                    : pill(ACTION[m.action] || [m.action, ''])) },
                { name: 'Now', get: m => pill(stateOf(m)) }
            ], d.messages, m => go(`#/message?${q({ key: m.key })}`), 'No messages match.', m => (m.recheck && RECHECK_BAD.includes(m.recheck.outcome) ? 'row-alert' : '')))];
    }

    async function message(params) {
        const key = params.get('key') || '';
        const { message: m, mode } = await api(`/api/message?${q({ key })}`);
        return emailView(m, { mode });
    }
    // A Copy button: the text goes to the clipboard (or, where the browser doesn't allow it, by a hidden
    // field), and a message says so. label: the button's text ("Copy").
    function copyButton(text, what, label = 'Copy') {
        return h('button', { class: 'linkbtn copy', type: 'button', 'aria-label': `Copy the ${what}`, onclick: async () => {
            try { await navigator.clipboard.writeText(text); }
            catch (e) {
                const t = h('textarea', { 'aria-hidden': 'true' });
                t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
                document.body.append(t); t.select();
                try { document.execCommand('copy'); } finally { t.remove(); }
            }
            toast(`${what} copied.`);
        } }, label);
    }
    // A row with an identifier, its Copy button (and any others: extra), and what it is for.
    const idRow = (label, value, note, extra = []) => [h('dt', { text: label }),
        h('dd', {}, value ? [h('code', { class: 'mid', text: value }), ' ', copyButton(value, label), ...extra.flatMap(b => [' ', b]), note ? h('div', { class: 'muted small', text: note }) : null]
            : h('span', { class: 'muted', text: 'not recorded (emails before 0.3.1)' }))];
    // Google Vault's search finds an email by its Message-ID written as rfc822msgid:<id> (no angle brackets).
    const vaultQuery = (id) => `rfc822msgid:${String(id || '').replace(/^<|>$/g, '')}`;
    const PASTED = { move: 'Would be moved to Spam', 'would-move': 'Would be recorded as "would move" (monitor mode: nothing is moved)', flag: 'Would be recorded as suspicious, not moved', none: 'Nothing would happen: the checks find nothing to act on' };

    // Re-scan (Review, Messages): the email read again from its mailbox and judged now, with today's checks
    // and model; nothing is moved, and the record keeps what happened on arrival beside it.
    const pctOr = (x) => (typeof x === 'number' ? pct(x) : 'none');
    async function rescanEmail(key) {
        acting++;
        try {
            const out = await api('/api/rescan', { method: 'POST', body: { key } });
            const r = out.rescan;
            toast(`Re-scanned with ${r.model || 'no AI model'}: AI ${pctOr(r.ai)}, rules score ${r.score}. ${PASTED[r.action] || r.action}.`);
            render();
        } catch (e) { toast(`Couldn't re-scan it: ${e.message}`); } finally { acting--; }
    }
    function rescanButton(m, cls) {
        if (m.pasted || !m.key || MEMORY) return null;
        return h('button', { class: cls, type: 'button', title: 'Read it again from the mailbox and judge it with today\'s checks and AI model. Nothing is moved.', onclick: () => rescanEmail(m.key) },
            cls.includes('review') ? [h('kbd', { text: 'R' }), ' Re-scan'] : 'Re-scan');
    }
    function rescanBox(m) {
        const r = m.rescan;
        if (!r) return null;
        // On arrival: kept apart since 0.5.4 (arrival); a record re-scanned by 0.5.3 still has it in ai and score.
        const arr = m.arrival || { ai: m.ai, score: m.score };
        const was = arr.ai && typeof arr.ai.probability === 'number' ? arr.ai.probability : null;
        const other = arr.ai && arr.ai.model && r.model && arr.ai.model !== r.model ? `, ${arr.ai.model}` : '';
        return h('div', { class: 'rescan' },
            h('b', { text: `Re-scanned ${when(r.at)}${r.by ? ` by ${r.by}` : ''}` }),
            h('div', { text: `With ${r.model || 'no AI model'}: AI ${pctOr(r.ai)} (on arrival ${pctOr(was)}${other}); rules score ${r.score} (on arrival ${arr.score === null || arr.score === undefined ? '–' : arr.score}).` }),
            h('div', { text: `With today's checks and model: ${PASTED[r.action] || r.action}.` }),
            h('div', { class: 'small muted', text: 'The scores, the AI opinion and the signs on this page are the re-scan\'s; what happened to the email stays, and nothing was moved by the re-scan: decide with the buttons. The sender counts as new if it was new on arrival.' }));
    }

    // Found after it was delivered (0.5.35): why, when, where it was, opened, a link clicked.
    function recheckBox(m) {
        const r = m.recheck;
        if (!r) return null;
        const c = r.clicks;
        const why = r.source === 'lists' ? `${r.list || 'A phishing list'} listed ${r.site || 'one of its sites'} after it was delivered` : `A second look ${r.round === 2 ? 'a day' : 'an hour'} after it arrived`;
        const did = { moved: `It was moved to Spam ${when(r.movedAt || r.at)}.`, 'would-move': 'Monitor mode: it was recorded as "would move" and left in the Inbox.', held: 'A brake left it in the Inbox.',
            'not-in-inbox': `It had already left the Inbox (${WHERE[r.where] || r.where}), so it wasn't moved.`, flag: 'It is now suspicious, and was left in the Inbox.' }[r.outcome] || '';
        return h('div', { class: `rescan recheck-box${RECHECK_BAD.includes(r.outcome) ? ' bad' : ''}` },
            h('b', {}, RECHECK_BAD.includes(r.outcome) ? alertIcon('Found after delivery') : null, ` Found on a re-check, ${when(r.at)}`),
            h('div', { text: `${why}. ${r.before === 'none' ? 'Nothing was found on arrival' : `On arrival it was ${(ACTION[r.before] || [r.before])[0].toLowerCase()}`}${typeof r.beforeScore === 'number' ? ` (score ${r.beforeScore})` : ''}. ${did}` }),
            h('div', { text: `Delivered ${when(m.receivedAt)}. Opened before the re-check: ${c && c.opened ? `yes${c.openedAt ? `, ${when(c.openedAt)}` : ''}` : r.opened ? 'yes' : 'no'}. Link clicked: ${c ? (c.clicked ? `YES${c.clickedAt ? `, ${when(c.clickedAt)}` : ''}` : `none found in Gmail's logs (checked ${when(c.checkedAt)})`) : 'not checked (Settings → Link clicks)'}.` }),
            h('a', { class: 'small', href: '#/rechecked', text: 'Every copy: Email → Re-checked' }));
    }

    // The AI's opinion of one email: its score and where that stands against the lines that move or flag
    // mail, what weighed most, and "…show more": what the model reads of it, sentence by sentence (read from
    // Gmail on demand; the service keeps no email text). No score: why (a language it doesn't read).
    function aiOpinion(m, ai, opts = {}) {
        if (ai === null) {
            if (m.ai && m.ai.skipped === 'inside') return h('div', { class: 'ai-none' },
                h('b', { text: 'Not scored: the sender is inside your organization.' }),
                h('div', { text: 'The AI doesn\'t read mail from inside (your domains, Gmail\'s DMARC check passed): Settings → Policy, "AI on inside mail", turns it on. The rule checks read it as usual: its links, its headers and the rest.' }));
            if (m.ai && m.ai.skipped === 'language') return h('div', { class: 'ai-none' },
                h('b', { text: 'Not scored: the AI model reads English only.' }),
                h('div', { text: `This email looks like it is in ${m.ai.language || 'another language'}, so the AI gives no opinion of it. The rule checks don't depend on the language and ran as usual; decide from the signs and the email itself.` }));
            return h('div', { class: 'empty', text: m.ai && m.ai.error ? `The model gave no score (${m.ai.error}).` : 'The model gave no score.' });
        }
        const inside = !!m.inside;
        const where = ai >= aiThreshold ? (inside ? (aiMovesInside ? `at or over the move line (${pct(aiThreshold)}): the AI score alone moves it, though the sender is inside your organization ("AI alone moves inside mail" is on)`
                : `at or over the move line (${pct(aiThreshold)}), but the sender is inside your organization, so the AI score alone doesn't move it ("AI alone moves inside mail" is off)`) : `at or over the move line (${pct(aiThreshold)}): the AI score alone moves an outside email`)
            : ai >= aiSuspicious ? `over the suspicious line (${pct(aiSuspicious)}), under the move line (${pct(aiThreshold)}): recorded as suspicious, not moved`
            : ai >= 0.5 ? `50% or more, so it leans toward phishing, but under the suspicious line (${pct(aiSuspicious)}): the AI alone does nothing`
            : `under 50%: the AI reads it as genuine`;
        const canRead = !m.pasted && !!m.key;
        const more = canRead ? h('button', { class: 'linkbtn', type: 'button', text: '…show more' }) : null;
        if (more) more.addEventListener('click', () => showAiReading(m));
        return [
            h('div', { class: 'kpi' }, h('div', { class: 'value', text: pct(ai) }), h('div', { class: 'note', text: `${m.ai.model}: how likely it is phishing` })),
            m.rescan && m.arrival ? h('div', { class: 'small muted', text: `Re-scanned ${when(m.rescan.at)}. On arrival: ${m.arrival.ai ? `${pct(m.arrival.ai.probability)}, ${m.arrival.ai.model || 'an unknown model'}` : 'no AI score'}.` }) : null,
            (() => { const mt = h('div', { class: `meter ${ai >= aiThreshold ? 'hot' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(ai * 100), 'aria-label': 'AI score' }, h('div')); mt.firstChild.style.width = pct(ai); return mt; })(),
            h('div', { class: 'small ai-where', text: `Where it stands: ${pct(ai)} is ${where}.` }),
            m.ai.reasons && m.ai.reasons.length ? [h('div', { class: 'small muted', text: 'What weighed most (each part scored on its own):' }),
                m.ai.reasons.map(r => h('div', { class: 'quote', text: r.facts ? 'Who sent it, the sender check and where its links go' : `“${r.sentence}”` }))]
                : ai >= 0.5 ? h('div', { class: 'small muted', text: 'Which parts weighed most isn\'t kept for this email (STORE_AI_QUOTES=off, or recorded before it was).' }) : null,
            h('div', { class: 'small muted' }, 'The model reads the subject, the sender\'s name and domain, the sender check, where the links go and the text, with addresses and numbers replaced. ',
                more ? [more, ' to see all of it, sentence by sentence, around what weighed most.'] : null)];
    }
    // "…show more": what the model reads of the email, read from Gmail now (nothing is kept), in a popup.
    async function showAiReading(m) {
        const body = h('div', { class: 'ai-reading' }, h('div', { class: 'empty', text: 'Reading the email from Gmail…' }));
        popup(`What the AI reads: ${m.subject || 'this email'}`, body);
        try {
            const { language, reading: r, skipped } = await api('/api/message/context', { method: 'POST', body: { key: m.key } });
            body.textContent = '';
            if (skipped === 'inside') { body.append(h('div', { class: 'ai-none' }, h('b', { text: 'Not scored: the sender is inside your organization.' }), h('div', { text: 'The AI doesn\'t read mail from inside (Settings → Policy, "AI on inside mail").' }))); return; }
            body.append(h('p', { class: 'sub', text: 'Read from Gmail just now; nothing is kept, and Activity notes that you looked. Addresses keep only their domain, and phone numbers and long numbers are replaced, as the model sees them. Each part is also scored on its own: how much that part alone reads like phishing.' }));
            if (!r) { body.append(h('div', { class: 'ai-none' }, h('b', { text: 'Not scored: the AI model reads English only.' }), h('div', { text: `This email looks like it is in ${language && language.name || 'another language'}.` }))); return; }
            const lean = (w) => 1 / (1 + Math.exp(-w));
            // The whole email's score is the AI's opinion. A part scored alone, out of context, can read
            // more like phishing than the email does ("click here to accept" is in invitations too): when
            // the whole email reads as genuine (under 50%), nothing is marked or shown in red.
            const calm = r.probability < 0.5;
            const weighed = calm ? new Set() : new Set(r.sentences.map((x, i) => [x.weight, i]).filter(([w]) => w > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i));
            const badge = (w) => h('span', { class: `lean ${!calm && lean(w) >= 0.5 ? 'hot' : ''}`, text: `${pct(lean(w))} on its own` });
            const partsHigher = calm && [r.headWeight, ...r.sentences.map(x => x.weight)].some(w => lean(w) >= 0.5);
            body.append(h('div', { class: 'small' }, h('b', { text: `The AI now: ${pct(r.probability)}` }), ` (${r.model} ${r.version}, the whole email${m.ai && typeof m.ai.probability === 'number' && Math.abs(m.ai.probability - r.probability) >= 0.01 ? `; ${pct(m.ai.probability)} when it was checked` : ''}).`));
            if (partsHigher) body.append(h('div', { class: 'alert info' }, h('div', { text: `The whole email reads as genuine to the AI (${pct(r.probability)}): that is its opinion. Some parts score higher on their own, because without the rest of the email a single line (a link, "click here to accept") reads like many phishing emails; together, the AI doesn't find it phishing.` })));
            // What weighed most, each with the nearest sentence of real text before and after it (blank
            // lines, lone punctuation and invisible padding skipped: reading() marks them filler).
            const inContext = calm ? [] : (r.weighed || []).filter(c => r.sentences[c.index]);
            if (inContext.length) body.append(h('h3', { text: 'What weighed most, with the sentence before and after' }),
                ...inContext.map(c => h('div', { class: 'in-context' },
                    h('div', { class: 'ctx muted', text: c.before ? c.before.text : '(the start of the text)' }),
                    h('div', { class: 'ctx weighed' }, h('span', { text: r.sentences[c.index].text }), badge(r.sentences[c.index].weight)),
                    h('div', { class: 'ctx muted', text: c.after ? c.after.text : '(the end of the text)' }))));
            body.append(h('h3', { text: 'About the sender and links' }), h('div', { class: 'reading-line' }, h('div', { class: 'mono small', text: r.head }), badge(r.headWeight)));
            const shown = r.sentences.map((x, i) => [x, i]).filter(([x]) => !x.filler);
            const left = r.sentences.length - shown.length;
            body.append(...[h('h3', { text: `The whole text, sentence by sentence${weighed.size ? ' (what weighed most is marked)' : ''}` }),
                shown.length ? h('ol', { class: 'reading' }, shown.map(([x, i]) => h('li', { class: weighed.has(i) ? 'weighed' : '' }, h('span', { text: x.text }), badge(x.weight))))
                    : h('div', { class: 'empty', text: 'No text: the model read only the subject, the sender and the links.' }),
                left ? h('div', { class: 'small muted', text: `${num(left)} blank or filler line${left === 1 ? '' : 's'} (spaces, lone punctuation, invisible characters) left out.` }) : null,
                r.more ? h('div', { class: 'small muted', text: `…and ${num(r.more)} more sentences the model reads, not scored one by one here.` }) : null].filter(Boolean));
        } catch (e) {
            body.textContent = '';
            body.append(h('div', { class: 'alert warning' }, h('div', { text: `Couldn't read it: ${e.message}` })));
        }
    }

    // One email's decision: a record (Messages), or a pasted email's answer (Check an email: m.pasted).
    // opts.inReview: the review queue shows its own buttons and title.
    function emailView(m, opts = {}) {
        const pasted = !!m.pasted, quiet = pasted || !!opts.inReview;
        const ai = m.ai && typeof m.ai.probability === 'number' ? m.ai.probability : null;
        // A user took back an email the checks flagged, and no admin has looked yet: worth a look.
        const rescueToCheck = !pasted && m.state === 'released' && m.releasedByUser && !m.markedBy && m.score >= 5 && m.trigger !== 'ai';
        const decisionClass = rescueToCheck ? 'would' : m.state === 'released' ? 'released' : m.action === 'move' ? 'move' : m.action === 'would-move' ? 'would' : m.action === 'none' ? 'released' : 'flag';
        const act = async (path, body, done) => { acting++; try { const out = await api(path, { method: 'POST', body }); toast(typeof done === 'function' ? done(out) : done); render(); } catch (e) { toast(`Couldn't do that: ${e.message}`); } finally { acting--; } };
        // Suspicious emails weren't moved, so "not phishing" says it better than "false alarm"; in enforce
        // mode, phishing still in the Inbox is moved to Spam when confirmed.
        const notMoved = m.action === 'flag';
        const moves = opts.mode === 'enforce' && m.state === 'inbox' && m.action !== 'move';
        const actions = quiet ? null : h('div', { class: 'actions' },
            rescanButton(m, 'btn'),
            m.state === 'moved' ? h('button', { class: 'btn primary', type: 'button', onclick: () => act('/api/release', { key: m.key }, 'Moved back to the Inbox.') }, 'Move back to Inbox') : null,
            m.falseAlarm !== true ? h('button', { class: 'btn', type: 'button', onclick: () => act('/api/mark', { key: m.key, falseAlarm: true }, notMoved ? 'Marked as not phishing.' : 'Marked as a false alarm.') }, notMoved ? 'Mark not phishing' : 'Mark false alarm') : null,
            m.falseAlarm !== false || moves ? h('button', { class: `btn${moves ? ' primary' : ''}`, type: 'button', onclick: () => act('/api/mark', { key: m.key, falseAlarm: false, move: moves }, (out) => phishedText(out.moved)) }, moves ? 'Confirm phishing: move to Spam' : 'Confirm phishing') : null);
        const verdictText = pasted ? 'Checked from a pasted copy: nothing was stored, moved or counted.'
            : m.falseAlarm === true && m.releasedByUser && !m.markedBy ? 'Counted as a false alarm because the user moved it back. No admin has reviewed it yet.'
            : m.falseAlarm === true ? (notMoved ? 'An admin marked this as not phishing.' : 'An admin marked this a false alarm.') : m.falseAlarm === false ? 'An admin confirmed this as phishing or spam.' : 'Not reviewed yet.';
        return [quiet ? null : h('button', { class: 'linkbtn back', type: 'button', onclick: back }, '← Back'),
            h(quiet ? 'h2' : 'h1', { class: quiet ? 'pasted-title' : null, text: m.subject || (pasted ? '(no subject)' : '(subject not stored)') }),
            h('p', { class: 'sub', text: `From ${m.sender.name ? `${m.sender.name} <${m.sender.address}>` : m.sender.address || 'an unknown sender'} to ${m.user || '–'}${m.receivedAt ? `, ${when(m.receivedAt)}` : ''}` }),
            h('div', { class: 'grid detail' },
                h('div', { class: 'grid' },
                    h('section', { class: 'card' }, h('h2', { text: 'What happened' }),
                        h('div', { class: `decision ${decisionClass}` }, h('b', { text: pasted ? (PASTED[m.action] || m.action) : m.state === 'released' ? (m.releasedByUser ? 'Moved back to the Inbox by the user' : `Moved back to the Inbox by ${m.releasedBy}`) : (ACTION[m.action] || [m.action])[0] }), h('div', { text: m.state === 'released' ? `${when(m.releasedAt)}. It was moved because ${m.why}.` : m.why ? `Because ${m.why}.` : 'No sign of phishing from the checks or the AI.' }),
                            rescueToCheck ? h('div', { text: 'The checks flagged it. Make sure it is safe, or confirm phishing and warn the user.' }) : null),
                        h('div', { class: 'small muted', text: `${verdictText} ${m.markedBy ? `(${m.markedBy})` : ''}`.trim() }),
                        pasted ? null : recheckBox(m),
                        pasted ? null : rescanBox(m),
                        // (about moving, so not for an email the service didn't move: suspicious, or moved by an admin's decision)
                        m.evidence && !notMoved && !(m.heldMovedBy && !m.trigger) ? h('div', { class: 'small muted', text: m.evidence === 'strong' ? `Strong evidence: the rules flagged it, and ${(m.confirmedBy || []).join('; ')}. Moving its campaign is never paused for it.`
                            : m.evidence === 'admin' ? 'A copy found by an admin\'s search for a campaign.' : 'Weaker evidence: nothing outside the email confirms it, so moving its campaign\'s copies can pause for your decision (they stay in the Inbox meanwhile).' }) : null,
                        actions),
                    h('section', { class: 'card' }, h('h2', { text: 'Signs found' }), h('div', { class: 'sub', text: `The rule checks: score ${m.score === null || m.score === undefined ? '–' : m.score} (amber at 3, flagged at 5).` }),
                        m.signals.length ? h('ul', { class: 'signals' }, m.signals.slice().sort((a, b) => b.weight - a.weight).map(sg => h('li', {}, h('span', { class: `weight ${sg.weight >= 3 ? 'high' : ''}`, text: String(sg.weight) }), h('span', { text: sg.text })))) : h('div', { class: 'empty', text: 'No signs.' })),
                    m.links && m.links.length ? h('section', { class: 'card' }, h('h2', { text: 'Flagged links' }), h('ul', { class: 'signals' }, m.links.map(l => h('li', {}, h('span', { class: `weight ${l.severity === 'danger' ? 'high' : ''}`, text: l.severity === 'danger' ? '!' : '?' }), h('span', {}, h('div', { text: l.reason || '' }), h('div', { class: 'muted small', text: `${l.from ? `${l.from[0].toUpperCase()}${l.from.slice(1)}: ` : ''}${l.finalUrl && l.finalUrl !== l.url ? `${l.url} → ${l.finalUrl}` : l.url}` })))))) : null),
                h('div', { class: 'grid' },
                    h('section', { class: 'card' }, h('h2', { text: 'AI opinion' }), aiOpinion(m, ai, opts)),
                    h('section', { class: 'card' }, h('h2', { text: 'Details' }), h('dl', { class: 'kv' },
                        h('dt', { text: 'Sender check' }), h('dd', { text: m.auth ? `DMARC ${m.auth.dmarc || '–'}, SPF ${m.auth.spf || '–'}, DKIM ${m.auth.dkim || '–'}` : 'not recorded' }),
                        h('dt', { text: 'Trigger' }), h('dd', { text: m.trigger ? ({ rules: 'Rules', ai: 'AI score', 'rules+ai': 'Rules and AI', admin: 'An admin\'s search for a campaign' })[m.trigger] || m.trigger : m.state === 'moved' && m.heldMovedBy ? `none: ${m.heldMovedBy} confirmed it as phishing` : 'none' }),
                        h('dt', { text: 'Mode' }), h('dd', { text: m.mode }),
                        h('dt', { text: 'Looked up' }), h('dd', { text: m.checks ? [m.checks.cloudflare ? `Cloudflare: ${m.checks.cloudflare} site${m.checks.cloudflare === 1 ? '' : 's'}` : '', m.checks.safeBrowsing ? `Safe Browsing: ${m.checks.safeBrowsing} link${m.checks.safeBrowsing === 1 ? '' : 's'}` : '', m.checks.lists ? 'phishing lists' : '', m.checks.ages ? `site age: ${m.checks.ages}` : '', m.checks.notChecked ? `${m.checks.notChecked} not checked` : ''].filter(Boolean).join(' · ') || 'nothing to look up' : 'offline checks only' }),
                        h('dt', { text: 'Attachments' }), h('dd', { text: m.attachments && m.attachments.length ? m.attachments.map(a => a.name || a.type).join(', ') : 'none' }),
                        // What the attachment checks found (0.5.34): a QR code's site, a form, a script…
                        m.attachmentFindings && m.attachmentFindings.length ? [h('dt', { text: 'Found in them' }), h('dd', {}, h('ul', { class: 'plain-list' }, m.attachmentFindings.map(f => h('li', { text: f.what }))))] : null,
                        idRow('Message-ID', m.rfc822MessageId, 'To look it up in Google Workspace: Admin console → Reporting → Email log search (Message ID), or the security investigation tool. Copy for Vault gives Google Vault\'s search for it (rfc822msgid:…).',
                            m.rfc822MessageId ? [copyButton(vaultQuery(m.rfc822MessageId), 'Vault search', 'Copy for Vault')] : []),
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

    // The model in use, and, when others scored some of the period's emails (before an upgrade), which.
    function modelLine(d) {
        const now = d.current || d.model || 'unknown';
        const models = d.models || [];
        if (!models.length || (models.length === 1 && models[0].model === now)) return `Model in use: ${now}.`;
        const total = models.reduce((n, m) => n + m.count, 0);
        return `Model in use: ${now}. The scores above for these ${num(total)} emails came from ${models.map(m => `${m.model} (${num(m.count)})`).join(', ')}: emails are scored on arrival, and keep the score the model in use then gave them.`;
    }
    async function health() {
        const d = await api(`/api/health?days=${days}`);
        const reviewedRate = d.reviewed ? d.falseAlarms / d.reviewed : 0;
        return [h('h1', { text: 'Model health' }), h('p', { class: 'sub', text: 'Whether the move rules are right: how often each kind of move had to be undone. Use this to set the AI threshold.' }),
            h('div', { class: 'grid kpis' }, kpi('Moved back by users', num(d.userReleased || 0), 'Not spam, or dragged to the Inbox'), kpi('Reviewed', num(d.reviewed), 'moved back, marked or confirmed'), kpi('Confirmed phishing', num(d.confirmed), ''), kpi('False alarms', num(d.falseAlarms), d.reviewed ? `${pct(reviewedRate, 1)} of reviewed` : ''), kpi('Move threshold', pct(d.threshold), 'AI_MOVE_THRESHOLD')),
            h('div', { class: 'grid two' },
                h('section', { class: 'card' }, h('h2', { text: 'Recorded emails by AI score' }), h('div', { class: 'sub', text: 'Each column is a 10-point range of the model\'s score; hover for how many were moved back.' }), h('div', { class: 'chart' }, histogram(d.buckets, d.threshold))),
                h('section', { class: 'card' }, h('h2', { text: 'Undone moves by trigger' }), h('div', { class: 'sub', text: 'Moved back ÷ moved. A high rate for "AI score" alone means the threshold is too low.' }),
                    dataTable([{ name: 'Trigger', get: r => r.label }, { name: 'Moved', num: true, get: r => num(r.moved) }, { name: 'Moved back', num: true, get: r => num(r.released) }, { name: 'By users', num: true, get: r => num(r.byUser || 0) }, { name: 'Rate', num: true, get: r => pct(r.rate, 1) }], d.byTrigger),
                    h('p', { class: 'small muted', text: modelLine(d) }))),
            togetherCard(d),
            trainingCard(d)];
    }
    // Rules and AI together: measured only. Emails from outside senders that scored in between on both
    // (neither alone moves them), and what admins marked them: whether moving such emails would be worth
    // trying. Nothing is moved because of it.
    function togetherCard(d) {
        const t = d.together;
        if (!t) return null;
        const [lo, hi] = t.ai;
        const marked = t.phishing + t.falseAlarms;
        const verdict = !t.count ? 'None in this period.'
            : marked < 10 ? `Too few marked so far to tell (${num(marked)} of ${num(t.count)}): mark them in Email → Review → Suspicious, not moved.`
            : t.phishing >= 0.8 * marked ? `Most of those marked are phishing (${pct(t.phishing / marked)}): moving such emails could be worth trying, in monitor mode first.`
            : t.falseAlarms >= 0.5 * marked ? `Many of those marked are genuine (${pct(t.falseAlarms / marked)}): moving such emails would make false alarms.`
            : `Mixed so far (${pct(t.phishing / marked)} phishing): keep marking them.`;
        return h('section', { class: 'card spaced' }, h('h2', { text: 'Rules and AI together (measured only)' }),
            h('div', { class: 'sub', text: `Emails from outside senders with a rules score of ${t.rules[0]} to under ${t.rules[1]} and an AI score of ${pct(lo)} to under ${pct(hi)}: each in between, so neither alone moves them, and they are recorded as suspicious. Nothing is moved because of this count.` }),
            h('div', { class: 'grid kpis' }, kpi('In between on both', num(t.count), `last ${days} days`), kpi('Marked phishing', num(t.phishing), 'by an admin'),
                kpi('Marked false alarm', num(t.falseAlarms), 'by an admin'), kpi('Not reviewed', num(t.unreviewed), 'yet')),
            h('p', { class: 'small muted', text: verdict }));
    }

    // --- Model health: examples for retraining the model (off until an admin allows it in Settings) ----
    function trainingCard(d) {
        const title = h('h2', { text: 'Examples for retraining the model' });
        const intro = h('div', { class: 'sub', text: `The emails an admin confirmed as phishing in the last ${days} days (and, if you tick it, the false alarms), one per campaign, newest first, up to 100, as training examples for the AI model. Each is read from Gmail when you download, with the people in it taken out. The file is the only copy: nothing is stored, and Activity notes who downloaded it.` });
        const guide = h('p', { class: 'small muted', text: 'Before the file goes anywhere, follow docs/RETRAINING.md: check every example (words marked ⟦like this⟧ may be names), run tools/check-training-file.js, then train.' });
        if (!d.trainingExport) return h('section', { class: 'card spaced' }, title, intro, h('p', { class: 'small muted', text: 'Off. A dashboard admin can allow it in Settings → Retraining.' }));
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
                    n('not-english') ? `${num(n('not-english'))} not in English left out (the model reads English only).` : '',
                    n('not-reached') ? `${num(n('not-reached'))} more not reached: choose a shorter period for the older ones.` : ''].filter(Boolean).join(' ');
                toast('Downloaded. Check it before it goes anywhere.');
            } catch (e) { result.textContent = `Couldn't make the file: ${e.message}`; }
            finally { btn.disabled = false; btn.textContent = 'Download for retraining'; acting--; }
        });
        return h('section', { class: 'card spaced' }, title, intro,
            h('label', { class: 'switch' }, fa, h('span', { text: 'Include false alarms' })), warn,
            h('div', { class: 'actions' }, btn), result, guide);
    }

    // --- Settings, in pages (a menu on the left): Policy, Allowlist, Mailboxes, Weekly summary, Retraining, About
    async function settingsData(query = '') { const d = await api(`/api/settings${query}`); showMode(d.mode); return d; }
    const kvRow = (k, v) => [h('dt', { text: k }), v instanceof Node ? h('dd', {}, v) : h('dd', { text: v })];
    async function settings() {   // Policy
        const d = await settingsData();
        const allowed = ((d.policy && d.policy.allowDomains && d.policy.allowDomains.value) || d.allowDomains || []).length;
        const addresses = d.policy && d.policy.allowAddresses ? d.policy.allowAddresses.value.length : d.allowAddresses;
        return [h('h1', { text: 'Policy' }), h('p', { class: 'sub', text: 'What is moved to Spam, and when. The settings below can be changed here, each change confirmed with the Google Cloud project ID; the rest is set when the service is deployed (deploy/settings.env, docs/DEPLOY.md).' }),
            policyCard(d, POLICY_ROWS, 'Policy', 'Each change needs the Google Cloud project ID, applies within 30 seconds, and is noted in Status → Activity → What admins did. When deploy/settings.env says something else, deploy/install.sh (and upgrade.sh) asks which to keep, and writes the answer into settings.env.'),
            h('section', { class: 'card spaced' }, h('h2', { text: 'How it decides' }), h('dl', { class: 'kv' },
                kvRow('Moved: sender outside', d.moveOnRules ? `either one is enough: the AI scores ${pct(d.aiThreshold)} or more, or the rules flag it (a rules score of 5 or more). The AI score needs no rule, link check or other sign to agree.`
                    : `when the AI scores ${pct(d.aiThreshold)} or more (MOVE_ON_RULES is off: the rules alone don't move mail).`),
                kvRow('Moved: sender inside', d.aiMovesInside ? (d.moveOnRules ? `as for outside senders, either one is enough: the AI scores ${pct(d.aiThreshold)} or more, or the rules flag it (5 or more). "AI alone moves inside mail" is on (Settings → Policy): the AI score alone moves a colleague's email too.`
                        : `when the AI scores ${pct(d.aiThreshold)} or more ("AI alone moves inside mail" is on; MOVE_ON_RULES is off: the rules alone don't move mail).`)
                    : d.moveOnRules ? `only when the rules flag it (a rules score of 5 or more: its links, its headers and the rest), as they do for a staff account taken over. ${d.aiScansInside ? `The AI reads it too (Settings → Policy), but its score alone doesn't move it, even at ${pct(d.aiThreshold)} or more ("AI alone moves inside mail" is off): it is recorded as suspicious.` : 'The AI doesn\'t read it (Settings → Policy, "AI on inside mail": off).'}`
                    : 'never (the AI score alone doesn\'t move inside mail: "AI alone moves inside mail" is off; and MOVE_ON_RULES is off).'),
                kvRow('Inside or outside', `inside: the From address is in your own domains (${(d.orgDomains || []).join(', ') || 'ORG_DOMAINS'}) and Gmail's DMARC check passed for it. Anything else is outside, a forged staff address too. DMARC only decides this (and whether an allowlisted sender counts): an outside sender doesn't have to pass or fail it. A failed DMARC check is also one of the rules' signs (2 or 3 points), never required.`),
                kvRow('Suspicious, not moved', `a rules score of 3 or more, or an AI score of ${pct(d.aiSuspicious || 0.65)} or more, that doesn't move it${d.aiMovesInside ? '' : ' (an inside sender\'s high AI score included)'}: recorded for review (Email → Review → Suspicious, not moved).`),
                kvRow('The rules', 'the rule checks add up signs: dangerous or brand-new links, a look-alike or impersonated sender, forged headers, a failed sender check, requests for passwords, codes or money, a new outside sender. 3 is amber, 5 is flagged. The AI score is separate.'),
                kvRow('Campaign pause', `After ${num(d.campaignHoldAfter)} copies of one campaign are moved on weaker evidence, moving its other copies pauses until you confirm it as phishing or dismiss it as a false alarm; until then they stay in the Inbox, like any email not moved. Strong evidence never pauses (CAMPAIGN_HOLD_AFTER)`),
                kvRow('Alerts', d.alertEmail ? `Emailed to ${d.alertEmail} by Cloud Monitoring` : 'Shown in Status → Activity; not emailed (ALERT_EMAIL, deploy/install.sh)'),
                kvRow('Never moved', allowed || addresses ? `the allowlist: ${num(allowed)} domain${allowed === 1 ? '' : 's'} and ${num(addresses)} address${addresses === 1 ? '' : 'es'} (Settings → Allowlist)` : 'nothing allowlisted (Settings → Allowlist)'),
                kvRow('Label on moved mail', d.movedLabel)))];
    }
    async function allowlist() {
        const d = await settingsData();
        return [h('h1', { text: 'Allowlist' }), h('p', { class: 'sub', text: 'Senders whose mail is never moved or marked suspicious, whatever the checks find, as long as Gmail\'s DMARC check passes for them (a forged address is judged like any other). Each change needs the Google Cloud project ID, and is noted in Status → Activity → What admins did.' }),
            h('div', { class: 'alert warning' }, h('div', {}, h('b', { text: 'Add only senders you trust. ' }), 'If one of their accounts is taken over, the phishing it sends isn\'t caught. Your own domains can\'t be added: a staff account taken over would never be moved. Single addresses in them can.')),
            policyCard(d, ALLOW_ROWS, 'Allowlisted senders', 'A change applies within 30 seconds and is noted in Status → Activity. When deploy/settings.env (ALLOW_DOMAINS, ALLOW_ADDRESSES) says something else, deploy/install.sh asks which to keep, and writes the answer into settings.env.')];
    }
    async function mailboxes() {
        const d = await settingsData('?mailboxes=1');   // (only this page lists them)
        return [h('h1', { text: 'Mailboxes' }), h('p', { class: 'sub', text: 'Who is watched, and whether Gmail\'s notifications arrive for each. The pilot group and unit are set when the service is deployed (deploy/settings.env).' }),
            h('section', { class: 'card' }, h('dl', { class: 'kv' },
                kvRow('Organization', d.orgDomains.join(', ') || '–'),
                kvRow('Mailboxes watched', `${num(d.watched)}${[...(d.pilotGroups || []).map(g => `group ${g}`), d.pilotOu ? `unit ${d.pilotOu}` : ''].filter(Boolean).map(x => ` (${x})`).join('')}`))),
            h('section', { class: 'card spaced' }, h('h2', { text: 'Mailboxes watched' }),
                renewBar(d.renew),
                h('div', { class: 'sub', text: 'When Gmail last said each mailbox changed. "None yet" for a mailbox that does get mail means its notifications don\'t arrive. Status → Activity says, after each daily re-read of the group, how many people it found and why any were left out.' }),
                d.mailboxes && d.mailboxes.length < d.watched ? h('div', { class: 'small muted', text: `The first ${num(d.mailboxes.length)} of ${num(d.watched)}, by address.` }) : null,
                d.mailboxes && d.mailboxes.length
                    ? dataTable([{ name: 'Mailbox', get: m => m.email }, { name: 'Last notification', get: m => (m.lastNotification ? when(m.lastNotification) : 'None yet') }, { name: 'Watch renews by', get: m => (m.watchExpiration ? when(m.watchExpiration) : '–') }], d.mailboxes)
                    : h('div', { class: 'empty', text: 'None: run the spruce-renew-watches job (docs/INSTALL.md, step 7).' }))];
    }
    async function summary() {
        const d = await settingsData();
        return [h('h1', { text: 'Weekly summary' }), digestCard(d)];
    }
    async function retraining() {
        const d = await settingsData();
        return [h('h1', { text: 'Retraining' }), trainingSettingCard(d)];
    }
    // --- Settings → Safe Browsing (0.5.23): the API key (tested, kept in Secret Manager, never shown again),
    // and on or off. Each change needs the project ID, as the policy does.
    // A small form under a button: the project ID, then confirm; posts body() with it to path.
    function confirmForm(label, path, body, done, note = null) {
        const err = h('div', { class: 'policy-error', role: 'alert' });
        const project = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'project-id', 'aria-label': 'Google Cloud project ID' });
        const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, label);
        const box = h('div', { class: 'policy-form sb-form', hidden: true }, note,
            h('label', { class: 'project' }, h('span', { text: 'Google Cloud project ID, to confirm' }), project),
            h('div', { class: 'actions' }, go, h('button', { class: 'btn', type: 'button', onclick: () => { box.hidden = true; opener.hidden = false; } }, 'Cancel')), err);
        const opener = h('button', { class: 'btn', type: 'button', onclick: () => { box.hidden = false; opener.hidden = true; project.focus(); } }, label);
        project.addEventListener('input', () => { go.disabled = !project.value.trim(); });
        go.addEventListener('click', async () => {
            err.textContent = ''; go.disabled = true; acting++;
            try { const out = await api(path, { method: 'POST', body: Object.assign(body(), { projectId: project.value }) }); toast(done(out)); render(); }
            catch (e) { err.textContent = e.message; go.disabled = false; }
            finally { acting--; }
        });
        return h('div', {}, opener, box);
    }
    async function safeBrowsingPage() {
        const d = await settingsData();
        const sb = d.safeBrowsing || {};
        const hl = sb.health;
        const keyText = sb.saved ? `Saved by ${sb.saved.by}, ${when(sb.saved.at)}. It is kept in Secret Manager and never shown here again.`
            : !sb.available ? (sb.envKey ? 'From the service\'s settings (SAFE_BROWSING_KEY). Upgrade from Cloud Shell once (bash deploy/update.sh (or, from an unzipped new version, bash deploy/upgrade.sh)) to manage the key here instead.' : 'Can\'t be saved here yet: upgrade from Cloud Shell once (bash deploy/update.sh (or, from an unzipped new version, bash deploy/upgrade.sh)); it sets up Secret Manager for the key.')
            : sb.envKey ? 'None saved here; the key from the service\'s settings (SAFE_BROWSING_KEY) is used.' : 'None saved.';
        const lookups = !sb.on ? 'Off: links aren\'t sent to Google.'
            : !sb.working ? 'On, but no key can be used: links aren\'t looked up with Google.'
            : hl && !hl.ok ? `Google refused the last lookup (${when(hl.at)}): ${hl.error}. Links aren't looked up with Google until the key works again.`
            : hl ? `Working: Google answered at ${when(hl.at)}.` : 'On: no lookup yet.';
        const bad = sb.on && (!sb.working || (hl && !hl.ok));
        const switchForm = sb.on
            ? confirmForm('Turn off', '/api/policy', () => ({ key: 'safeBrowsing', value: false }), () => 'Safe Browsing is off: links are no longer sent to Google (within 30 seconds everywhere).')
            : sb.saved || sb.envKey ? confirmForm('Turn on', '/api/policy', () => ({ key: 'safeBrowsing', value: true }), () => 'Safe Browsing is on: links are looked up with Google too (within 30 seconds everywhere).') : h('div', { class: 'small muted', text: 'Save a key below first.' });
        // The key: a password field (never kept, never shown back); tested with Google, then saved.
        const keyInput = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'AIza…', 'aria-label': 'Safe Browsing API key', 'data-lpignore': 'true', 'data-1p-ignore': 'true' });
        const turnOn = h('input', { type: 'checkbox', checked: !sb.on });
        const project = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'project-id', 'aria-label': 'Google Cloud project ID' });
        const err = h('div', { class: 'policy-error', role: 'alert' });
        const save = h('button', { class: 'btn primary', type: 'button', disabled: true }, sb.saved ? 'Test and replace the key' : 'Test and save the key');
        const ready = () => { save.disabled = !keyInput.value.trim() || !project.value.trim(); };
        keyInput.addEventListener('input', ready); project.addEventListener('input', ready);
        save.addEventListener('click', async () => {
            err.textContent = ''; save.disabled = true; acting++;
            const apiKey = keyInput.value;
            keyInput.value = '';                                  // (not left in the page)
            try {
                const out = await api('/api/safe-browsing/key', { method: 'POST', body: { apiKey, projectId: project.value, turnOn: !sb.on && turnOn.checked } });
                toast(`${out.tested ? 'Google accepted the key. ' : ''}It is saved in Secret Manager${out.turnedOn ? ', and Safe Browsing is on' : ''}.`);
                render();
            } catch (e) { err.textContent = e.message; ready(); }
            finally { acting--; }
        });
        const keyCard = sb.available ? h('section', { class: 'card spaced' }, h('h2', { text: sb.saved ? 'Replace the API key' : 'Add the API key' }),
            h('div', { class: 'sub', text: 'Paste the key. It is tried with Google first (a lookup of Google\'s own test address, nothing from anyone\'s mail); only a key that works is saved, in Secret Manager. It is never kept in the dashboard\'s records, shown here again, or written to the logs. Saving a new key destroys the old one.' }),
            h('div', { class: 'policy-form sb-form' },
                h('label', { class: 'project' }, h('span', { text: 'API key' }), keyInput),
                sb.on ? null : h('label', { class: 'choice' }, turnOn, h('span', { text: 'Turn Safe Browsing on once the key works' })),
                h('label', { class: 'project' }, h('span', { text: 'Google Cloud project ID, to confirm' }), project),
                d.demoProjectId ? h('div', { class: 'small muted', text: `Demo mode: the project ID is ${d.demoProjectId}; any well-formed key is accepted, and nothing is sent to Google.` }) : null,
                h('div', { class: 'actions' }, save), err),
            sb.saved ? h('div', { class: 'spaced-top' }, h('h3', { text: 'Remove the key' }),
                h('div', { class: 'small muted', text: 'Turns Safe Browsing off and destroys every copy of the key in Secret Manager. Delete the key in the Google Cloud console too (APIs & Services → Credentials) if it isn\'t used anywhere else.' }),
                confirmForm('Remove the key', '/api/safe-browsing/remove', () => ({}), () => 'The key was removed, and Safe Browsing is off.')) : null) : null;
        const link = (text, href) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', text });
        return [h('h1', { text: 'Google Safe Browsing' }),
            h('p', { class: 'sub', text: 'An extra check of the links in each email against Google\'s list of phishing, malware and unwanted-software pages, the list Chrome and Gmail use. Off by default. It needs a free API key from your Google Cloud project.' }),
            bad ? h('div', { class: 'alert critical', role: 'alert' }, alertIcon('Alert'), h('div', { class: 'grow' }, h('b', { text: 'Safe Browsing is on, but it isn\'t working. ' }), lookups)) : null,
            // Optional, and what it adds (0.5.23).
            h('section', { class: 'card optional-note' }, h('h2', { text: 'Optional: the service works without it' }),
                h('div', { class: 'sub', text: 'S.P.R.U.C.E doesn\'t need Safe Browsing to protect your mail. Without it, every email still gets the rule checks, the AI model, Cloudflare\'s security check of each link\'s site and the sender\'s domain, the five phishing lists downloaded daily, and the site-age check. Turned on, it adds:' }),
                h('ul', { class: 'benefits' },
                    h('li', {}, h('b', { text: 'Google\'s own list. ' }), 'The phishing, malware and unwanted-software pages Chrome and Gmail warn about, updated continuously by Google, far larger than the free lists.'),
                    h('li', {}, h('b', { text: 'Single pages on good sites. ' }), 'It checks each link\'s full address, so it can flag one phishing page on a hacked school or business website, or on a free page builder (Google Sites, Weebly, Firebase…), without condemning the whole site. A check of the site alone can\'t do that.'),
                    h('li', {}, h('b', { text: 'Malware downloads. ' }), 'Links to infected files and fake updates, which the phishing lists mostly don\'t cover.'),
                    h('li', {}, h('b', { text: 'A second opinion. ' }), 'A link Google lists is dangerous (it counts toward moving the email); when Cloudflare and the lists miss a brand-new page, Google may already have it.')),
                h('div', { class: 'small muted', text: 'What it doesn\'t change: phishing through real Google Docs, Drive, Classroom or DocuSign links, which the sender, Reply-To and directory checks catch. Costs: none (free for non-commercial use); each link\'s address is sent to Google (below).' })),
            h('section', { class: 'card spaced' }, h('h2', { text: 'Status' }), h('dl', { class: 'kv' },
                kvRow('Safe Browsing', sb.on ? 'On: the links in each email are also looked up with Google' : 'Off'),
                kvRow('API key', keyText),
                kvRow('Lookups', lookups),
                kvRow('Changes', 'Each needs the Google Cloud project ID, applies everywhere within 30 seconds, and is noted in Status → Activity → What admins did. Google refusing the key is an alert: the admins are emailed.')),
                h('div', { class: 'actions' }, switchForm)),
            keyCard,
            h('section', { class: 'card spaced' }, h('h2', { text: 'Getting a key' }),
                h('ol', { class: 'steps' },
                    h('li', {}, 'In the ', link('Google Cloud console', 'https://console.cloud.google.com/'), ', choose this service\'s project (the project ID you type here).'),
                    h('li', {}, 'Enable the ', link('Safe Browsing API', 'https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com'), ' (deploy/install.sh does it from 0.5.23 on).'),
                    h('li', {}, 'In ', link('APIs & Services → Credentials', 'https://console.cloud.google.com/apis/credentials'), ', click Create credentials → API key.'),
                    h('li', {}, 'Edit the new key: name it "SPRUCE Safe Browsing"; Application restrictions: None (the service has no fixed address); API restrictions: Restrict key → Safe Browsing API. Save.'),
                    h('li', {}, 'Click Show key, copy it, and paste it above.'))),
            h('section', { class: 'card spaced' }, h('h2', { text: 'What is sent to Google' }), h('dl', { class: 'kv' },
                kvRow('Sent', 'The address of each link in an email (up to 500 per lookup), without the part after "#"; for one-time links (password resets, sign-in and unsubscribe links), without the query either, so their codes never leave the district.'),
                kvRow('Not sent', 'The email\'s text, subject, sender, recipients or attachments, and nothing about who received it.'),
                kvRow('Remembered', 'Google\'s answers, 30 minutes for a clean link and a day for a listed one, so a campaign\'s copies cost one lookup.'),
                kvRow('What it decides', 'A link Google lists is dangerous. One it doesn\'t list isn\'t "safe" by that alone, and a lookup that fails leaves the link "not checked", never safe.'),
                kvRow('Terms', 'The Safe Browsing API (v4 Lookup) is free for non-commercial use, as a school district protecting its own mail is. Google\'s terms apply to the key\'s project.')))];
    }
    async function about(q) {
        const d = await settingsData();
        const yes = (b) => (b ? 'Yes' : 'No');
        const lists = d.lists || [];
        const missed = lists.filter(l => l.missed);
        // A list's name, with the red alert icon and what happened when it missed its download.
        const listName = (l) => {
            if (!l.missed) return l.name;
            const what = l.missed === 'failed'
                ? `Missed its download${l.failures > 1 ? ` ${num(l.failures)} times` : ''} since ${when(l.failedSince)}: ${l.error}. ${l.updated ? `The copy from ${when(l.updated)} is still used.` : 'It has no copy yet, so it isn\'t used.'}`
                : `Not updated since ${when(l.updated)}: the daily download isn't happening (Status shows the hourly job). Its copy is still used.`;
            return h('div', {}, h('div', { class: 'list-name' }, alertIcon(`Alert: ${l.name} missed its download`), h('b', { text: l.name })), h('div', { class: 'small list-problem', text: what }));
        };
        const recheck = h('button', { class: missed.length ? 'btn primary' : 'btn', type: 'button',
            onclick: postButton('/api/lists/recheck', () => ({}), (o) => {
                const f = o.feeds || [], got = f.filter(r => r.count != null).length, bad = f.filter(r => r.error);
                return bad.length ? `Still missing: ${bad.map(r => `${r.name} (${r.error})`).join('; ')}.` : got ? `Downloaded ${num(got)} list${got === 1 ? '' : 's'}; every list is up to date.` : 'Every list is up to date (downloaded within the day).';
            }) }, 'Re-check the lists now');
        const listsCard = h('section', { class: `card spaced${missed.length ? ' has-alert' : ''}`, id: 'lists' },
            h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: 'Phishing lists' }),
                h('div', { class: 'sub', text: 'Downloaded once a day for the whole organization and matched here; nothing about an email is sent. A list that misses its download keeps its previous copy and is tried again every 3 hours.' })), d.checks && d.checks.phishingLists ? recheck : null),
            missed.length ? h('div', { class: 'alert critical', role: 'alert' }, alertIcon('Alert'), h('div', { class: 'grow' }, h('b', { text: `${missed.length === 1 ? '1 list' : `${num(missed.length)} lists`} missed ${missed.length === 1 ? 'its' : 'their'} download (highlighted below).` }),
                ' Re-check downloads them again now; the alert was emailed to the admins.')) : null,
            lists.length ? dataTable([{ name: 'List', get: listName }, { name: 'Kind', get: l => (({ url: 'phishing links', domain: 'phishing sites', address: 'scam senders' })[l.kind] || l.kind) + (l.confidence === 'report' ? ' (reports: a caution)' : '') },
                { name: 'Entries', num: true, get: l => num(l.count) }, { name: 'Updated', get: l => (l.updated ? when(l.updated) : 'not yet') },
                { name: 'Last download', get: l => (l.lastAttempt ? `${when(l.lastAttempt)}: ${l.error ? 'failed' : 'OK'}` : '—') }], lists, l => (l.missed ? 'row-alert' : ''))
                : h('div', { class: 'empty', text: d.checks && d.checks.phishingLists ? 'Not downloaded yet: the hourly job downloads them within the hour.' : 'The phishing lists are off (PHISHING_LISTS=off).' }));
        if (q && q.get && q.get('show') === 'lists') setTimeout(() => { if (listsCard.isConnected) listsCard.scrollIntoView({ block: 'start' }); }, 0);
        return [h('h1', { text: 'About' }), h('p', { class: 'sub', text: 'What this service runs, what it keeps, and what it looks up.' }),
            h('section', { class: 'card' }, h('h2', { text: 'Version and records' }), h('dl', { class: 'kv' },
                kvRow('Version', d.version || ''),
                kvRow('Model', `${d.model.name} ${d.model.version}`),
                kvRow('Engine', d.engine && d.engine.extensionVersion ? `S.P.R.U.C.E+ ${d.engine.extensionVersion} (${d.engine.commit || ''})` : 'bundled'),
                kvRow('Records kept', `${d.retentionDays} days`),
                kvRow('Subjects stored', yes(d.storeSubjects)),
                kvRow('AI quotes stored', yes(d.storeAiQuotes)))),
            h('section', { class: 'card spaced' }, h('h2', { text: 'Network checks' }), h('div', { class: 'sub', text: 'Lookups made for every email, besides the offline checks. A lookup that fails leaves a link "not checked", never "safe".' }),
                h('dl', { class: 'kv' },
                    kvRow('Cloudflare Security', d.checks && d.checks.cloudflare ? 'On: link sites and sender domains' : 'Off'),
                    kvRow('Google Safe Browsing', h('span', {}, d.checks && d.checks.safeBrowsing ? 'On: links (no #part; one-time links without their query)' : d.safeBrowsing && d.safeBrowsing.on ? 'On, but no key can be used' : 'Off', ' (', h('a', { href: '#/safebrowsing', text: 'Settings → Safe Browsing' }), ')')),
                    kvRow('Phishing lists', d.checks && d.checks.phishingLists ? (missed.length ? h('span', {}, alertIcon('Alert'), ` On; ${num(missed.length)} missed ${missed.length === 1 ? 'its' : 'their'} download (below)`) : 'On: downloaded once a day, matched here (below)') : 'Off'),
                    kvRow('Site age', d.checks && d.checks.siteAge ? 'On: up to 3 unfamiliar link sites and the sender\'s domain' : 'Off'),
                    kvRow('Short links', 'Not looked up (no outside unshortening service)'))),
            listsCard];
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
        return acting > 0 || pageBusy() || popupOpen() || !tip().hidden || (a && a !== v && v.contains(a))
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
    // Activity (0.5.29): its own period, up to how long it is kept (AUDIT_DAYS, a year by default), a kind,
    // words to look for, and all of it as CSV for an audit (recorded under What admins did).
    async function activity(params) {
        const kind = params.get('kind') || '', words = params.get('q') || '';
        const period = Number(params.get('days')) || 30;
        const d = await api(`/api/activity?${q({ days: String(period), kind, q: words })}`);
        const nav = (patch) => go(`#/activity?${q(Object.assign({ days: String(period), kind, q: words }, patch))}`);
        const sel = h('select', { 'aria-label': 'Kind' }, [['', 'Everything'], ['alert', 'Alerts (problems, emailed)'], ['admin', 'What admins did'], ['error', 'Errors and gaps'], ['watch', 'Watching mailboxes']]
            .map(([v, l]) => h('option', { value: v, text: l, selected: v === kind })));
        sel.addEventListener('change', () => nav({ kind: sel.value }));
        const spans = [7, 30, 90, 180, 365, d.maxDays].filter((x, i, a) => x && x <= d.maxDays && a.indexOf(x) === i);
        const per = h('select', { 'aria-label': 'Period' }, spans.map(x => h('option', { value: String(x), text: x === d.maxDays && x !== 365 ? `Last ${x} days (all kept)` : `Last ${x} days`, selected: x === d.days })));
        per.addEventListener('change', () => nav({ days: per.value }));
        const find = h('input', { type: 'search', value: words, placeholder: 'Look for an admin, a mailbox, a word…', 'aria-label': 'Look for', autocomplete: 'off', spellcheck: 'false' });
        find.addEventListener('keydown', (e) => { if (e.key === 'Enter') nav({ q: find.value.trim() }); });
        const csv = MEMORY ? null : h('a', { class: 'btn', href: `/api/activity.csv?${q({ days: String(d.days), kind, q: words })}`, download: '' }, 'Download CSV');
        return [h('h1', { text: 'Activity' }), h('p', { class: 'sub', text: `Alerts, what admins did, errors and the watching of mailboxes, newest first. Kept ${d.maxDays} days (AUDIT_DAYS); the email records themselves are kept as long as Settings → Policy says.` }),
            h('div', { class: 'toolbar' }, sel, per, find, csv),
            d.total > d.events.length ? h('div', { class: 'small muted', text: `The newest ${num(d.events.length)} of ${num(d.total)} shown; Download CSV has them all (downloading it is noted under What admins did).` }) : null,
            // An alert (a problem the admins were emailed about) in red; an admin's own change is never one (0.5.28).
            h('section', { class: 'card' }, d.events.length ? h('ul', { class: 'events' }, d.events.map(e => {
                const alerted = e.alert && !e.adminAction;
                return h('li', { class: alerted ? 'alerted' : '' }, h('time', { text: `${when(e.at)}${alerted ? ' · alert, emailed to the admins' : ''}` }), ' ', e.text);
            }))
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
            r.campaignsOverHold.length ? h('section', { class: 'card spaced' }, h('h2', { text: 'Campaigns whose moving would have paused' }),
                h('div', { class: 'sub', text: `More than ${r.holdAfter} copies on weaker evidence: in enforce mode, moving the rest would pause for your decision (they'd stay in the Inbox meanwhile).` }),
                dataTable([{ name: 'Campaign', get: c => h('a', { href: `#/messages?${q({ campaign: c.campaign })}`, text: c.label }) }, { name: 'Copies', num: true, get: c => num(c.count) }], r.campaignsOverHold)) : null];
    }

    // --- Review: the emails nobody has reviewed, one at a time (F, P, N) ----------------------------------
    // Two queues, each worked through one email at a time: moved or "would move" (oldest first), and
    // suspicious emails that weren't moved (newest first: still in the Inbox). In enforce mode, Phishing
    // also moves an email that is still in the Inbox to Spam.
    let reviewStates = {}, reviewKeys = null;
    const QUEUES = {
        moved: { label: 'Moved or would move', what: 'moved or "would move" emails', order: 'oldest first', no: 'False alarm', noDone: 'Marked as a false alarm.' },
        suspicious: { label: 'Suspicious, not moved', what: 'suspicious emails not moved', order: 'newest first', no: 'Not phishing', noDone: 'Marked as not phishing.' }
    };
    const phishedText = (moved) => moved === 'moved' ? 'Confirmed as phishing, and moved to Spam.'
        : moved === 'gone' ? 'Confirmed as phishing. It isn\'t in the Inbox any more, so nothing was moved.' : 'Confirmed as phishing.';
    // Each item is one email with all its copies (a campaign: the same email to many people), decided at once.
    // "Look again" (restart) loads the queue again once, then leaves the address, so Next isn't undone.
    async function review(params) {
        const queue = params.get('queue') === 'suspicious' ? 'suspicious' : 'moved', Q = QUEUES[queue];
        const plain = queue === 'moved' ? '#/review' : `#/review?queue=${queue}`;
        let st = reviewStates[queue];
        if (!st || params.get('restart') || st.days !== days) {
            const d = await api(`/api/review?${q({ days: String(days), queue })}`);
            const groups = d.groups || (d.keys || []).map(k => ({ keys: [k], users: [], senders: [], count: 1 }));
            st = reviewStates[queue] = { groups, i: 0, done: 0, days, counts: d.counts || {} };
            for (const [k, other] of Object.entries(reviewStates)) if (k !== queue && other.days === days && d.counts) other.counts = d.counts;
            if (params.get('restart')) { if (MEMORY) memRoute = plain; else history.replaceState(null, '', plain); }
        }
        reviewKeys = null;
        const emailsLeft = (o) => o.groups.slice(o.i).reduce((a, g) => a + g.keys.length, 0);
        const left = (k) => { const o = reviewStates[k]; return o && o.days === days && o.groups ? emailsLeft(o) : (st.counts[k] || 0); };
        const head = [h('h1', { text: 'Review' }),
            h('div', { class: 'queue-switch', role: 'group', 'aria-label': 'Which emails to review' }, Object.entries(QUEUES).map(([k, x]) =>
                h('a', { class: `btn${k === queue ? ' primary' : ''}`, href: k === 'moved' ? '#/review' : `#/review?queue=${k}`, 'aria-current': k === queue ? 'page' : null }, `${x.label} (${num(left(k))})`))),
            queue === 'suspicious' ? h('p', { class: 'sub', text: `Suspicious: the checks found signs (a rules score of 3 or more) or the AI scored it at least the suspicious line, but not enough to move it, so it is still in the Inbox. Marking them is the best way to see what the move rules miss, and what retraining needs (Status → Model health).` }) : null];
        if (st.i >= st.groups.length) {
            return [...head, h('div', { class: 'alert good', role: 'status' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '✅' }),
                h('div', { class: 'grow' }, h('b', { text: 'Nothing left to review.' }), ` ${num(st.done)} reviewed now; every ${Q.what} of the last ${days} days has been looked at.`)),
                h('div', { class: 'actions' }, queue === 'moved' ? h('a', { class: 'btn', href: '#/readiness' }, 'See Readiness') : h('a', { class: 'btn', href: '#/health' }, 'See Model health'),
                    h('a', { class: 'btn', href: `#/review?${q(queue === 'moved' ? { restart: '1' } : { queue, restart: '1' })}` }, 'Look again'))];
        }
        const g = st.groups[st.i];
        const same = new URLSearchParams(queue === 'moved' ? {} : { queue });   // (the same queue, not restarted)
        // The copy shown: the first one nobody has reviewed meanwhile (another admin, or Messages).
        let m, mode;
        while (g.keys.length) {
            try { ({ message: m, mode } = await api(`/api/message?${q({ key: g.keys[0] })}`)); } catch (e) { g.keys.shift(); m = null; continue; }
            if (m.markedBy) { g.keys.shift(); m = null; continue; }
            break;
        }
        if (!m) { st.i++; return review(same); }
        const key = g.keys[0], n = g.keys.length, many = n > 1;
        const moves = mode === 'enforce' && m.state === 'inbox' && m.action !== 'move';
        const decide = async (falseAlarm) => {
            acting++;
            try {
                let msg;
                if (!many) {
                    // Moved only when the button said so (the mode can change meanwhile, on another admin's screen).
                    const out = await api('/api/mark', { method: 'POST', body: { key, falseAlarm, move: !falseAlarm && moves } });
                    msg = falseAlarm ? Q.noDone : phishedText(out.moved);
                } else {
                    const out = await api('/api/bulk', { method: 'POST', body: { keys: g.keys, action: falseAlarm ? 'false-alarm' : 'phishing' } });
                    msg = falseAlarm ? `${Q.noDone.replace(/\.$/, '')}: ${num(out.done)} copies.`
                        : `Confirmed as phishing: ${num(out.done)} copies${out.moved ? `, ${num(out.moved)} moved to Spam` : ''}.`;
                    if (out.failed) msg += ` ${num(out.failed)} couldn't be marked.`;
                }
                st.done += n; st.i++; toast(msg); render();
            } catch (e) { toast(`Couldn't do that: ${e.message}`); } finally { acting--; }
        };
        const next = () => { st.i++; render(); };
        reviewKeys = { f: () => decide(true), p: () => decide(false), n: next, r: () => rescanEmail(key) };
        const all = many ? ` (all ${num(n)})` : '';
        const people = h('div', { class: 'card review-people' },
            h('div', {}, h('b', { text: many ? `This email went to ${num(g.users.length || n)} people: ` : 'Sent to: ' }), shortList(g.users.length ? g.users : [m.user].filter(Boolean), `Who received "${m.subject || 'this email'}"`, { describe: (k) => `${num(k)} people in your organization received a copy${n > 1 ? `; ${num(n)} copies wait for review` : ''}.` })),
            g.senders.length > 1 ? h('div', {}, h('b', { text: `From ${num(g.senders.length)} addresses: ` }), shortList(g.senders, 'Who sent it', { describe: (k) => `The copies came from ${num(k)} sender addresses.` })) : null,
            many ? h('div', { class: 'small muted' }, `One decision covers every copy. `, g.campaign ? h('a', { href: `#/messages?${q({ campaign: g.campaign })}`, text: 'See every copy in Messages' }) : null) : null);
        return [...head,
            h('p', { class: 'sub', text: `${num(st.i + 1)} of ${num(st.groups.length)} to review (${num(emailsLeft(st))} ${Q.what} nobody has reviewed, last ${days} days, ${Q.order}; copies of one email together). Keys: F ${Q.no.toLowerCase()}, P phishing${moves ? ' (moves it to Spam)' : ''}, N next, R re-scan with today's model.` }),
            h('div', { class: 'review-bar card' },
                h('button', { class: 'btn', type: 'button', onclick: () => decide(true) }, h('kbd', { text: 'F' }), ` ${Q.no}${all}`),
                h('button', { class: 'btn', type: 'button', onclick: () => decide(false) }, h('kbd', { text: 'P' }), moves ? ` Phishing: move to Spam${all}` : ` Phishing${all}`),
                h('button', { class: 'btn', type: 'button', onclick: next }, h('kbd', { text: 'N' }), ' Next, undecided'),
                rescanButton(m, 'btn review-rescan'),
                !moves && m.state === 'inbox' && mode !== 'enforce' ? h('span', { class: 'muted small', text: 'Monitor mode: nothing is moved.' }) : null),
            people,
            ...[].concat(emailView(m, { inReview: true, mode }))];
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

    // --- Settings → Update: the approved versions (google_service_main), their changes, and the button ----
    // The button needs the agreement, the project ID and the admin's own email address; it asks the
    // spruce-update job to rebuild and redeploy both services (src/update.js, deploy/cloud-update.sh).
    async function updatePage(q) {
        const demoManual = !!(q && q.get && q.get('manual'));
        const d = await api(`/api/update${demoManual ? '?manual=1' : ''}`);
        const n = d.newest;
        const out = [h('h1', { text: 'Update' }), h('p', { class: 'sub', text: 'The approved versions, from google_service_main, and what changed in them. A version that changes only the service is installed from here; one that changes the installation itself (permissions, jobs, settings) from Cloud Shell, with bash deploy/update.sh. Each version names its AI model: the update downloads that model from TinyPhishLLM, the model\'s own repository, and uses it only if every file matches.' })];
        // The AI model: each version pins one commit of TinyPhishLLM (its own public repository), which the
        // image build downloads and checks (SHA-256).
        // The repositories are links (a new tab): the model's to TinyPhishLLM (its commit to that commit), the
        // approved versions' to google_service_main. Only GitHub addresses of the expected shape are linked.
        const ghLink = (url, text) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/commit\/[0-9a-f]{40})?$/.test(String(url || ''))
            ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text }) : text);
        const modelText = (v) => {
            if (!v || !v.model) return 'unknown';
            const s = v.modelSource;
            if (!s) return `phish-tiny ${v.model}`;
            return [ghLink(s.repository, `phish-tiny ${v.model}, from ${s.repository.replace(/^https:\/\/github\.com\//, '')}`),
                ' (commit ', ghLink(`${s.repository}/commit/${s.commit}`, s.commit.slice(0, 7)), ')'];
        };
        const kvNode = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
        out.push(h('section', { class: 'card' }, h('dl', { class: 'kv' },
            kvRow('Installed', d.installed.version),
            kvNode('Its AI model', modelText(d.installed)),
            kvRow('Installation level', `${d.installed.installLevel}${d.installed.levelFrom === 'cloud-run' ? ' (read from Cloud Run)' : ''}: what deploy/install.sh last set up. A version with a higher level is installed from Cloud Shell.`),
            kvRow('Newest approved', n ? `${n.version}${n.date ? `, approved ${when(Date.parse(n.date))}` : ''}` : 'unknown'),
            kvNode('Its AI model', n ? modelText(n) : '–'),
            kvNode('From', n && /^[\w.-]+\/[\w.-]+$/.test(String(n.repo || '')) ? ghLink(`https://github.com/${n.repo}`, n.repo) : (n ? n.repo : '–')))));
        const st = d.progress;
        if (st && st.phase) {
            const at = st.at ? when(st.at) : '';
            const box = { requested: ['warning', '⏳', `An update to ${st.version} was asked for by ${st.by}, ${at}.`, 'Cloud Build starts within a minute; building and deploying takes about 10 minutes. This page shows the new version when it is done (reload it if it doesn\'t).'],
                building: ['warning', '⏳', `Updating to ${st.version} (asked for by ${st.by}, ${at}).`, 'Building and deploying takes about 10 minutes. Mail keeps being checked meanwhile.'],
                done: ['good', '✅', `Updated from ${st.from} to ${st.version}, ${at} (asked for by ${st.by}).`, ''],
                failed: ['critical', '⛔', `The update to ${st.version} failed, ${at}.`, `${st.message || ''}. Cloud Build's history (tag spruce-update) has the log.`],
                stalled: ['critical', '⛔', `The update to ${st.version} asked for ${at} didn't finish.`, 'Cloud Build\'s history (tag spruce-update) says why. Nothing changed unless a deploy stopped half-way (then bash deploy/rollback.sh goes back).'] }[
                ['requested', 'building'].includes(st.phase) && !d.running ? 'stalled' : st.phase];
            if (box) out.push(h('div', { class: `alert ${box[0]}`, role: 'status' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: box[1] }),
                h('div', { class: 'grow' }, h('b', { text: box[2] }), box[3] ? ` ${box[3]}` : '')));
        }
        // A manual install waiting (0.5.24): what and why, the steps, and the form shown with the button off.
        const m = d.manualInstall;
        if (m) {
            const link = (text, href) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', text });
            out.push(h('section', { class: 'card spaced manual-install', role: 'alert' },
                h('div', { class: 'manual-head' }, alertIcon('Manual install required'), h('h2', { text: `Manual install required: ${m.version}` })),
                h('p', { text: `${m.version} changes the installation itself (new permissions, jobs or settings): it needs installation level ${m.needs}, and this installation is at level ${m.installedLevel}. The dashboard can't make those changes, so it can't install it.` }),
                h('p', {}, h('b', { text: 'Until it is installed from Cloud Shell, no update is installed from this page: ' }), `not ${m.version}, and not any version after it. The Update button stays off, and the service keeps running ${d.installed.version} meanwhile.`),
                h('ol', { class: 'steps' },
                    h('li', {}, 'Open ', link('Cloud Shell', 'https://shell.cloud.google.com/?show=terminal'), ', signed in as a project owner.'),
                    h('li', {}, 'Go to the folder you installed or last upgraded from (the one with deploy/settings.env).'),
                    h('li', {}, 'Run ', h('code', { text: m.command }), ' ', copyButton(m.command, 'command', 'Copy'), '. It downloads the newest approved version, shows what changes and asks before changing anything, then runs deploy/install.sh.'),
                    h('li', {}, 'When it is done, this page installs updates again by itself (within 10 minutes).')),
                h('div', { class: 'small muted', text: `${m.since ? `Waiting since ${when(m.since)}. ` : ''}The admins were sent an alert. Read what's new below first: the entry for ${m.version} says what it sets up.` })));
            out.push(updateForm(d, { locked: true }));
        } else if (d.canUpdate) out.push(updateForm(d));
        else if (d.why) out.push(h('div', { class: `alert ${n && !d.newer.length ? 'good' : 'warning'}` }, h('div', { text: d.why })));
        if (d.demo) out.push(h('div', { class: 'small muted' }, 'Demo mode: ', demoManual ? h('a', { href: '#/update', text: 'show the made-up version that installs from here' }) : h('a', { href: '#/update?manual=1', text: 'show a made-up version that needs a manual install' }), '.'));
        const entry = (c) => h('article', { class: 'release' }, h('h3', { text: `${c.version}: ${c.title}` }), markdown(c.body));
        out.push(h('section', { class: 'card spaced' }, h('h2', { text: d.newer.length ? `What's new since ${d.installed.version}` : 'What\'s new' }),
            d.newer.length ? d.newer.map(entry) : h('div', { class: 'empty', text: n ? 'Nothing newer than the version installed.' : 'The approved versions couldn\'t be read.' }),
            d.changelog.length ? h('details', { class: 'changelog' }, h('summary', { text: `The whole changelog (the last ${d.changelog.length} versions)` }), d.changelog.map(entry)) : null));
        return out;
    }
    // locked: a manual install is waiting (0.5.24): the form is shown, everything in it off, saying why.
    function updateForm(d, { locked = false } = {}) {
        const to = d.newest.version;
        const agree = h('input', { type: 'checkbox' });
        const project = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'project-id', 'aria-label': 'Google Cloud project ID' });
        const email = h('input', { type: 'email', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'you@your-domain', 'aria-label': 'Your email address' });
        const err = h('div', { class: 'policy-error', role: 'alert' });
        const go = h('button', { class: 'btn primary', type: 'button' }, `Update to ${to}`);
        const ready = () => { go.disabled = locked || !(agree.checked && project.value.trim() && email.value.trim()); };
        for (const el of [agree, project, email]) { el.addEventListener('input', ready); el.addEventListener('change', ready); }
        if (locked) { for (const el of [agree, project, email]) el.disabled = true; go.textContent = `Update to ${to}: manual install required`; go.title = 'Install it from Cloud Shell first (above).'; }
        ready();
        pageBusy = () => !locked && (agree.checked || !!project.value || !!email.value);
        go.addEventListener('click', async () => {
            err.textContent = ''; go.disabled = true; acting++;
            try {
                const o = await api('/api/update', { method: 'POST', body: { agree: agree.checked, projectId: project.value, email: email.value, version: to } });
                toast(o.started && o.started.demo ? 'Demo mode: nothing was updated.' : `Update to ${to} started: about 10 minutes.`);
                pageBusy = () => false; render();
            } catch (e) { err.textContent = e.message; ready(); }
            finally { acting--; }
        });
        return h('section', { class: `card spaced${locked ? ' locked' : ''}`, 'aria-disabled': locked ? 'true' : null }, h('h2', { text: `Update to ${to}` }),
            locked ? h('div', { class: 'alert warning' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '🔒' }), h('div', { class: 'grow', text: `Off until ${to} is installed from Cloud Shell (Manual install required, above).` })) : null,
            h('div', { class: 'policy-form update-form' },
                h('label', { class: 'choice' }, agree, h('span', { text: `I agree: both services are rebuilt from ${to} and redeployed, with their settings as they are. Mail keeps being checked meanwhile (about 10 minutes). In Cloud Shell, bash deploy/rollback.sh goes back to the version before.` })),
                h('label', { class: 'project' }, h('span', { text: 'Google Cloud project ID, to confirm' }), project),
                h('label', { class: 'project' }, h('span', { text: 'Your email address (the one you are signed in with), to confirm' }), email),
                d.demo ? h('div', { class: 'small muted', text: 'Demo mode: the project ID is demo-project, and you are signed in as demo-admin@example.org.' }) : null,
                h('div', { class: 'actions' }, go), err));
    }
    // A changelog entry's Markdown, as page elements (text only, never HTML): paragraphs, lists (nested by
    // indentation), tables, code blocks, **bold** and `code`.
    function inlineMd(text) {
        const out = [], re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
        let last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) out.push(text.slice(last, m.index));
            out.push(m[0].startsWith('**') ? h('b', { text: m[0].slice(2, -2) }) : h('code', { text: m[0].slice(1, -1) }));
            last = re.lastIndex;
        }
        if (last < text.length) out.push(text.slice(last));
        return out;
    }
    function markdown(text) {
        const root = h('div', { class: 'md' }), lines = String(text || '').split('\n');
        let stack = [], para = null, i = 0;
        const lastLi = () => (stack.length ? stack[stack.length - 1].last : null);
        while (i < lines.length) {
            const line = lines[i], indent = /^ */.exec(line)[0].length;
            if (!line.trim()) { para = null; i++; continue; }
            if (/^\s*```/.test(line)) {
                const code = []; i++;
                while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
                i++; ((indent && lastLi()) || root).append(h('pre', { text: code.join('\n') })); para = null; continue;
            }
            if (/^\s*\|/.test(line)) {
                const rows = [];
                while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
                const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
                const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells);
                const t = h('table', { class: 'md-table' }, h('thead', {}, h('tr', {}, (body[0] || []).map(c => h('th', {}, inlineMd(c))))),
                    h('tbody', {}, body.slice(1).map(r => h('tr', {}, r.map(c => h('td', {}, inlineMd(c)))))));
                ((indent && lastLi()) || root).append(h('div', { class: 'table-wrap' }, t)); para = null; continue;
            }
            const li = /^( *)- (.*)$/.exec(line);
            if (li) {
                while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
                let top = stack[stack.length - 1];
                if (!top || top.indent < indent) { const ul = h('ul'); ((top && top.last) || root).append(ul); top = { indent, ul, last: null }; stack.push(top); }
                top.last = h('li', {}, inlineMd(li[2])); top.ul.append(top.last); para = null; i++; continue;
            }
            if (indent && lastLi()) { lastLi().append(' ', ...inlineMd(line.trim())); i++; continue; }
            stack = [];
            if (!para) { para = h('p'); root.append(para); para.append(...inlineMd(line.trim())); } else para.append(' ', ...inlineMd(line.trim()));
            i++;
        }
        return root;
    }

    // --- Settings: the policy, changed here with the project ID ---------------------------------------------
    // Mode, the AI lines, the brake, the time zone and how long records are kept. Each Change opens a form under its row; it
    // needs the project ID, and switching to enforce mode the agreement too. Live updates wait while a form
    // is open. deploy/install.sh asks which to keep when settings.env says otherwise (deploy/dashboard-policy.sh).
    const POLICY_ROWS = [
        { key: 'mode', label: 'Mode', show: (v) => (v === 'enforce' ? 'Enforce: emails the policy flags are moved to Spam' : 'Monitor: emails are checked and recorded, nothing is moved') },
        { key: 'aiThreshold', label: 'AI move threshold', show: (v, d) => (d.aiMovesInside ? `${pct(v)}: an email the AI scores this high or higher is moved on the AI score alone, whatever the rules find, from any sender, inside the organization too ("AI alone moves inside mail" is on)`
            : `${pct(v)}: an email from outside the organization that the AI scores this high or higher is moved on the AI score alone, whatever the rules find. From inside (your domains, DMARC passing), the AI score alone doesn't move it ("AI alone moves inside mail" is off): it is recorded as suspicious, and only the rules can move it`) },
        { key: 'aiSuspicious', label: 'AI suspicious line', show: (v) => `${pct(v)}: an email the AI scores this high or higher, but not moved, is recorded as suspicious for review` },
        { key: 'aiScansInside', label: 'AI on inside mail', show: (v, d) => (v || d.aiMovesInside ? `On: the AI also reads mail from inside the organization (your domains, Gmail's DMARC check passing)${d.aiMovesInside && !v ? ', because "AI alone moves inside mail" is on and needs it' : d.aiMovesInside ? '; its score alone can move it ("AI alone moves inside mail" is on)' : '; its score can make it suspicious, never move it on its own'}`
            : 'Off: mail from inside the organization (your domains, Gmail\'s DMARC check passing) isn\'t read by the AI. The rule checks read it as any email: its links, its headers and the rest; a forged inside address (DMARC not passing) is outside mail, and the AI reads it') },
        { key: 'aiMovesInside', label: 'AI alone moves inside mail', show: (v, d) => (v ? `On: an email from inside the organization that the AI scores ${pct(d.aiThreshold)} or more is ${d.mode === 'enforce' ? 'moved to Spam' : 'recorded as "would move" (monitor mode)'} on the AI score alone, as outside mail is, whatever the rules find. The AI reads inside mail for it`
            : 'Off: the AI score alone never moves mail from inside the organization (your domains, Gmail\'s DMARC check passing); the rules still can (a staff account taken over), and a forged inside address is outside mail') },
        { key: 'suspiciousLabel', label: 'Suspicious label', show: (v, d) => (v ? `On: an email that is suspicious but not moved gets the label ${d.suspiciousLabelName || 'SPRUCE/Suspicious'} in its mailbox, so its reader sees it (in monitor mode too). Nothing is moved by it`
            : 'Off: suspicious emails that aren\'t moved stay in the Inbox unmarked; only the dashboard lists them (Email → Review)') },
        { key: 'recheck', label: 'Re-check delivered mail', show: (v, d) => (v ? `On: when a phishing list adds a site or sender that an email of the last ${num(d.recheckDays || 7)} days has, every copy still in an Inbox is checked again in full and ${d.mode === 'enforce' ? 'moved to Spam' : 'recorded as "would move" (monitor mode)'} if the checks now say so; suspicious mail is also looked at again an hour and a day after it arrived. Email → Re-checked lists what was found`
            : 'Off: mail is checked once, when it arrives. Nothing is kept to find it again') },
        { key: 'brakePerHour', label: 'Brake (whole domain)', show: (v, d) => (v ? `${num(v)} moves an hour, then moving stops everywhere until an admin resumes` : `Automatic: ${num(d.brakeLimit)} moves an hour now (half the watched mailboxes, at least 100), then moving stops until an admin resumes`) },
        { key: 'timeZone', label: 'Time zone', show: (v) => `${v || 'UTC'}: the dashboard's days (the charts and daily counts), the weekly summary, and the nightly jobs` },
        { key: 'retentionDays', label: 'Records kept', show: (v) => `${num(v)} days: each email's record is deleted ${num(v)} days after it arrived, the oldest first` }
    ];
    const entries = (l, none) => {
        const list = l || [];
        if (!list.length) return h('div', { text: none });
        return h('div', {}, h('ul', { class: 'entries' }, list.slice(0, 30).map(x => h('li', { text: x }))), list.length > 30 ? h('div', { class: 'small muted', text: `and ${num(list.length - 30)} more (Change shows them all)` }) : null);
    };
    const ALLOW_ROWS = [
        { key: 'allowDomains', label: 'Domains', show: (v) => entries(v, 'None. Mail from any domain is checked.') },
        { key: 'allowAddresses', label: 'Addresses', show: (v) => entries(v, 'None.') }
    ];
    const ENV_NAME = { mode: 'MODE', aiThreshold: 'AI_MOVE_THRESHOLD', aiSuspicious: 'AI_SUSPICIOUS_THRESHOLD', aiScansInside: 'AI_SCANS_INSIDE', aiMovesInside: 'AI_MOVES_INSIDE', safeBrowsing: 'SAFE_BROWSING', suspiciousLabel: 'SUSPICIOUS_LABEL', recheck: 'RECHECK', brakePerHour: 'BRAKE_PER_HOUR', timeZone: 'TIME_ZONE', allowDomains: 'ALLOW_DOMAINS', allowAddresses: 'ALLOW_ADDRESSES', retentionDays: 'RETENTION_DAYS' };
    function policyCard(d, ROWS, title, sub) {
        const P = d.policy || {};
        let openKey = null;
        pageBusy = () => !!openKey;
        const short = (key, v) => (Array.isArray(v) ? (v.length ? `${num(v.length)} entr${v.length === 1 ? 'y' : 'ies'}` : 'none')
            : key === 'mode' ? v : key === 'aiScansInside' || key === 'aiMovesInside' || key === 'suspiciousLabel' || key === 'recheck' ? (v ? 'on' : 'off') : key === 'aiThreshold' || key === 'aiSuspicious' ? pct(v) : key === 'brakePerHour' ? (v ? `${num(v)} an hour` : 'automatic') : key === 'retentionDays' ? `${num(v)} days` : v);
        const source = (key) => {
            const p = P[key] || {};
            if (p.changed) return `Changed here by ${p.changed.by}, ${when(p.changed.at)}. settings.env (${ENV_NAME[key]}) says ${short(key, p.env)}.`;
            if (p.replaced) return `From settings.env (${ENV_NAME[key]}). It replaced ${short(key, p.replaced.value)}, set here by ${p.replaced.by}.`;
            // (install.sh doesn't pass these two: off unless changed here, or set in the services' environment)
            if (key === 'aiScansInside' || key === 'aiMovesInside' || key === 'suspiciousLabel') return p.env ? `On in the services' environment (${ENV_NAME[key]}).` : `Off: the default (${ENV_NAME[key]}).`;
            if (key === 'recheck') return p.env ? `On: the default (${ENV_NAME[key]}).` : `Off in the services' environment (${ENV_NAME[key]}=false).`;
            return `From settings.env (${ENV_NAME[key]}).`;
        };
        const rows = ROWS.map(r => {
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
                    h('div', { class: 'policy-value' }, (() => { const v = r.show(value, d); return v instanceof Node ? v : h('div', { text: v }); })(), h('div', { class: 'small muted', text: source(r.key) })),
                    d.projectKnown ? button : null),
                slot);
        });
        const box = h('section', { class: 'card spaced' }, h('h2', { text: title }),
            h('div', { class: 'sub', text: sub }),
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
            const floor = Math.max(51, Math.round((d.aiSuspicious || 0.65) * 100));
            const input = h('input', { type: 'number', min: floor, max: 100, step: 1, value: String(Math.round(value * 100)), 'aria-label': 'AI move threshold in percent', class: 'num-input' });
            read = () => Number(input.value) / 100;
            extra = [h('label', { class: 'inline' }, input, h('span', { text: '%' })), h('div', { class: 'small muted', text: `From the suspicious line (${floor}%) to 100%. Higher moves fewer emails on the AI score alone. Status → Model health shows how often moves on the AI score were undone.` })];
        } else if (key === 'aiSuspicious') {
            const ceiling = Math.round((d.aiThreshold || 0.9) * 100);
            const input = h('input', { type: 'number', min: 50, max: ceiling, step: 1, value: String(Math.round(value * 100)), 'aria-label': 'AI suspicious line in percent', class: 'num-input' });
            read = () => Number(input.value) / 100;
            extra = [h('label', { class: 'inline' }, input, h('span', { text: '%' })), h('div', { class: 'small muted', text: `From 50% to the move threshold (${ceiling}%). Lower records more emails for review (Email → Review), higher fewer; nothing more or less is moved. Below the line, and with a rules score under 3, an email isn't recorded at all.` })];
        } else if (key === 'aiScansInside') {
            const radio = (v, label) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'policy-inside', value: v ? 'on' : 'off', checked: !!value === v }), h('span', { text: label }));
            const choices = h('div', { class: 'choices' }, radio(false, 'Off: the rule checks alone read inside mail (links, headers, the rest)'), radio(true, 'On: the AI reads inside mail too'));
            read = () => choices.querySelector('input:checked').value === 'on';
            extra = [choices, h('div', { class: 'small muted', text: `Inside: your domains, with Gmail's DMARC check passing. On, the AI's score of an inside email is shown and can make it suspicious; ${d.aiMovesInside ? 'and it can move it ("AI alone moves inside mail" is on). Off has no effect while that is on: it needs the AI to read inside mail' : 'it doesn\'t move it on its own ("AI alone moves inside mail", below, is off)'}.` })];
        } else if (key === 'aiMovesInside') {
            const radio = (v, label) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'policy-moves-inside', value: v ? 'on' : 'off', checked: !!value === v }), h('span', { text: label }));
            const choices = h('div', { class: 'choices' }, radio(false, 'Off: only the rules move mail from inside (the cautious default)'), radio(true, `On: the AI score alone (${pct(d.aiThreshold)} or more) moves mail from inside too`));
            agreeBox = h('div', { class: 'agree', hidden: true },
                h('div', { class: 'alert warning' }, h('div', {}, h('b', { text: 'The AI alone would move your colleagues\' email. ' }), `From the moment you save, an email from inside the organization that the AI scores ${pct(d.aiThreshold)} or more is ${d.mode === 'enforce' ? 'moved to Spam' : 'recorded as "would move" (monitor mode: moved once you switch to enforce)'}, even when no rule, link check or other sign agrees. A false alarm by the AI on genuine staff mail (a payroll notice, a password reminder from IT) moves it out of the Inbox. The rules already move inside mail that shows real signs (a staff account taken over). The AI reads inside mail for this.`)),
                h('label', { class: 'choice' }, h('input', { type: 'checkbox', onchange: update }), h('span', { text: 'I agree: let the AI score alone move mail from inside the organization.' })));
            choices.addEventListener('change', () => { agreeBox.hidden = !(choices.querySelector('input:checked').value === 'on' && !value); update(); });
            read = () => choices.querySelector('input:checked').value === 'on';
            extra = [choices, agreeBox, h('div', { class: 'small muted', text: 'Inside: your domains, with Gmail\'s DMARC check passing; a forged staff address is outside mail, and the AI can move it either way. Off by default (AI_MOVES_INSIDE).' })];
        } else if (key === 'suspiciousLabel') {
            // (0.5.33) Off by default; visible to the email's reader, never moves anything.
            const radio = (v, label) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'policy-suspicious-label', value: v ? 'on' : 'off', checked: !!value === v }), h('span', { text: label }));
            const choices = h('div', { class: 'choices' }, radio(false, 'Off: suspicious emails stay in the Inbox as they arrived (the default)'), radio(true, `On: they get the label ${d.suspiciousLabelName || 'SPRUCE/Suspicious'}, which their reader sees`));
            read = () => choices.querySelector('input:checked').value === 'on';
            extra = [choices, h('div', { class: 'small muted', text: 'Only emails that are suspicious but not moved (Email → Review → Suspicious, not moved) get it, in monitor mode too; nothing is moved by it. Marking one a false alarm takes the label off. Turning it off labels no more; the ones labeled keep it.' })];
        } else if (key === 'recheck') {
            // (0.5.35) On by default; follows the mode and the brakes like any move.
            const radio = (v, label) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'policy-recheck', value: v ? 'on' : 'off', checked: !!value === v }), h('span', { text: label }));
            const choices = h('div', { class: 'choices' }, radio(true, 'On: delivered mail is checked again when a list adds one of its sites or senders (the default)'), radio(false, 'Off: mail is checked once, when it arrives'));
            read = () => choices.querySelector('input:checked').value === 'on';
            extra = [choices, h('div', { class: 'small muted', text: `Each email left in the Inbox keeps short one-way hashes of its link sites and sender (never readable, never shown) for ${num(d.recheckDays || 7)} days of looking (RECHECK_DAYS). A re-check is a full check, with the mode and the brakes as on arrival; an email its reader already archived or deleted, or one an admin released or marked, is never moved. Turning it off keeps no more hashes.` })];
        } else if (key === 'brakePerHour') {
            const auto = h('input', { type: 'radio', name: 'policy-brake', value: 'auto', checked: !value });
            const fixed = h('input', { type: 'radio', name: 'policy-brake', value: 'fixed', checked: !!value });
            const n = h('input', { type: 'number', min: 10, max: 100000, step: 1, value: String(value || d.brakeLimit || 100), 'aria-label': 'Moves an hour', class: 'num-input' });
            n.addEventListener('focus', () => { fixed.checked = true; });
            read = () => (auto.checked ? 0 : Number(n.value));
            extra = [h('div', { class: 'choices' }, h('label', { class: 'choice' }, auto, h('span', { text: 'Automatic: half the watched mailboxes, at least 100' })),
                h('label', { class: 'choice inline-choice' }, fixed, h('span', { text: 'A fixed limit:' }), n, h('span', { text: 'moves an hour' }))),
                h('div', { class: 'small muted', text: 'After this many moves in one hour, moving stops everywhere until an admin resumes (Overview). Strong evidence still counts toward it.' })];
        } else if (key === 'allowDomains' || key === 'allowAddresses') {
            const ta = h('textarea', { rows: 8, spellcheck: 'false', autocapitalize: 'off', 'aria-label': key === 'allowDomains' ? 'Allowlisted domains, one per line' : 'Allowlisted addresses, one per line' });
            ta.value = (value || []).join('\n');
            read = () => ta.value;
            extra = [ta, h('div', { class: 'small muted', text: key === 'allowDomains' ? 'One domain per line, for example vendor.example; its subdomains count too. Not your own domains.' : 'One address per line, for example billing@vendor.example. Addresses in your own domains can be added.' })];
        } else if (key === 'retentionDays') {
            const input = h('input', { type: 'number', min: 14, max: 365, step: 1, value: String(value), 'aria-label': 'Days records are kept', class: 'num-input' });
            const note = h('div', { class: 'small muted' });
            const say = () => {
                const n = Math.round(Number(input.value));
                note.textContent = !(n >= 14 && n <= 365) ? 'From 14 to 365 days.'
                    : n < value ? `Records older than ${n} days are deleted over the next hours, the oldest first. They can't be brought back.`
                    : n > value ? `Records saved from now on are kept ${n} days. Those already saved keep their date (${value} days after they arrived).`
                    : 'Each record is deleted on its own date, that many days after its email arrived: the oldest go first, never all at once.';
            };
            input.addEventListener('input', say); say();
            read = () => Number(input.value);
            extra = [h('label', { class: 'inline' }, input, h('span', { text: 'days' })), note,
                h('div', { class: 'small muted', text: 'From 14 to 365. The dashboard shows up to 90 days. Keeping longer costs a little more storage: at 10,000 mailboxes, about $0.50 a month for 35 days and $6–7 for a year (docs/COSTS.md).' })];
        } else if (key === 'timeZone') {
            let zones = [];
            try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { /* an older browser: typed in */ }
            const input = zones.length ? h('select', { 'aria-label': 'Time zone' }, (zones.includes(value) ? zones : [value, ...zones]).map(z => h('option', { value: z, selected: z === value, text: z })))
                : h('input', { type: 'text', value, 'aria-label': 'Time zone', placeholder: 'America/New_York' });
            read = () => input.value;
            extra = [input, h('div', { class: 'small muted', text: 'The dashboard\'s days and the weekly summary use it at once (days already counted keep the day they were counted on). The nightly jobs move to it the next time deploy/install.sh runs.' })];
        }
        project.addEventListener('input', update); update();
        save.addEventListener('click', async () => {
            err.textContent = ''; save.disabled = true; acting++;
            try {
                const out = await api('/api/policy', { method: 'POST', body: { key, value: read(), projectId: project.value, agree: !!(agreeBox && agreeBox.querySelector('input').checked) } });
                toast(out.changed && out.changed.unchanged ? 'That is already the setting: nothing changed.' : 'Changed. It applies everywhere within 30 seconds.');
                if (key === 'retentionDays' && out.changed) { fitRanges(out.changed.value); $('#foot').textContent = $('#foot').textContent.replace(/deleted after \d+ days/, `deleted after ${out.changed.value} days`); }
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
            document.title = p.total ? `(${p.total}) S.P.R.U.C.E Mail Protection Service` : 'S.P.R.U.C.E Mail Protection Service';
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
                setTimeout(() => { if (/mailboxes/.test(currentHash())) render({ quiet: true }); }, 10000);
            } catch (err) { toast(`Couldn't do that: ${err.message}`); b.disabled = false; }
            finally { acting--; }
        } }, 'Update group membership now') : null;
        return h('div', { class: 'renew' }, button, status);
    }

    // --- Email → Re-checked (0.5.35) -----------------------------------------------------------------
    // Emails already delivered and found to be phishing (or suspicious) later: when a phishing list added one
    // of their sites or senders, or on a second look an hour or a day after they arrived. One card per
    // campaign, with every copy: who got it, when, whether they had opened it, a link clicked (Link clicks),
    // and what was done.
    async function rechecked() {
        const d = await api(`/api/rechecked?days=${days}`);
        const cl = d.clickLogs || {};
        const outcomeOf = (c) => {
            if (c.released) return ['Moved back to the Inbox', 'released'];
            if (c.rechecked) return {
                moved: [`Moved to Spam ${c.movedAt ? when(c.movedAt) : ''}`.trim(), 'moved'], 'would-move': ['Would be moved (monitor mode)', 'would'],
                held: ['Left in the Inbox (a brake)', 'would'], 'not-in-inbox': [`Had already left the Inbox (${WHERE[c.where] || c.where})`, 'inbox'], flag: ['Suspicious, left in the Inbox', 'flag']
            }[c.outcome] || [c.outcome, ''];
            return c.state === 'moved' ? [`Moved to Spam on arrival ${c.movedAt ? when(c.movedAt) : ''}`.trim(), 'moved'] : c.action === 'would-move' ? ['Would move (on arrival)', 'would'] : ['Suspicious on arrival', 'flag'];
        };
        const openedOf = (c) => (c.opened === true ? (c.openedAt ? `Yes, ${when(c.openedAt)}` : 'Yes') : c.opened === false ? (c.rechecked ? 'No (when re-checked)' : 'No') : c.rechecked ? '–' : 'Not known (moved on arrival)');
        const clickedOf = (c) => (c.clicked === true ? h('b', { class: 'bad-text', text: c.clickedAt ? `Yes, ${when(c.clickedAt)}` : 'Yes' })
            : c.clicksCheckedAt ? `None found (checked ${when(c.clicksCheckedAt)})` : !c.rechecked ? '–' : cl.on ? 'Not checked yet' : h('a', { href: '#/clicks', text: 'Not checked (Link clicks is off)' }));
        const group = (g) => h('section', { class: `card recheck-group${g.phishing ? ' bad' : ''}` },
            h('div', { class: 'card-head' },
                h('div', {}, h('h2', {}, g.phishing ? alertIcon('Phishing found after delivery') : null, ` ${g.subject || g.label || '(subject not stored)'}`),
                    h('div', { class: 'sub', text: `From ${g.sender && g.sender.name ? `${g.sender.name} <${g.sender.address}>` : (g.sender && g.sender.address) || 'an unknown sender'}` })),
                h('a', { href: `#/messages?${q({ campaign: g.campaign })}`, text: 'Open the campaign' })),
            h('p', { class: 'small' }, h('b', { text: `${g.reasons.join('; ')}. ` }), `First delivered ${when(g.firstReceived)}; re-checked ${when(g.lastRecheck)}.`),
            h('div', { class: 'grid kpis recheck-kpis' },
                kpi('People', num(g.people), `${num(g.rechecked)} re-checked`),
                kpi('Moved to Spam', num(g.moved), !g.moved && d.mode !== 'enforce' ? 'monitor mode: nothing moved' : ''),
                kpi('Opened', num(g.opened), 'before it was moved'),
                kpi('Link clicked', cl.on ? num(g.clicked) : '–', cl.on ? `Gmail's logs, ${num(g.clicksChecked)} checked` : 'Link clicks is off')),
            clickTable([
                { name: 'Recipient', get: c => c.user },
                { name: 'Delivered', get: c => when(c.receivedAt) },
                { name: 'Opened', get: c => openedOf(c) },
                { name: 'Link clicked', get: c => clickedOf(c) },
                { name: 'Re-checked', get: c => (c.recheckAt ? when(c.recheckAt) : '–') },
                { name: 'What happened', get: c => pill(outcomeOf(c)) }
            ], g.copies, c => go(`#/message?${q({ key: c.key })}`), 'No copies.', c => (c.clicked ? 'row-alert' : '')));
        const seen = d.groups.length ? postButton('/api/rechecked/seen', () => ({}), () => 'Marked as seen: the banners on Overview and Messages are gone until something new is found.') : null;
        return [h('h1', { text: 'Re-checked mail' }),
            h('p', { class: 'sub', text: 'Emails already delivered to an Inbox and found later to be phishing or suspicious: when a phishing list added one of their sites or senders, or on a second look an hour and a day after they arrived. Each is checked again in full, and moved as it would have been on arrival.' }),
            h('section', { class: 'card' }, h('dl', { class: 'kv' },
                kvRow('Re-checking', d.recheck ? `On (Settings → Policy): emails of the last ${num(d.recheckDays)} days are looked for when a list adds one of their sites or senders.` : 'Off (Settings → Policy): mail is checked once, when it arrives.'),
                kvRow('Link clicks', h('span', {}, cl.on ? `On: Gmail's logs are read (as ${cl.admin}) for who opened each email and clicked a link in it. ` : 'Off: whether each email had been opened comes from Gmail\'s unread mark when it was re-checked; clicks aren\'t known. ', h('a', { href: '#/clicks', text: 'Settings → Link clicks' }))),
                d.queued ? kvRow('Waiting', `${num(d.queued)} emails to be checked again at the next hourly run.`) : null,
                d.seenAt ? kvRow('Last marked seen', when(d.seenAt)) : null),
                seen ? h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: seen }, 'Mark all as seen')) : null),
            d.groups.length ? d.groups.map(group) : h('section', { class: 'card' }, h('div', { class: 'empty', text: `Nothing was found after delivery in the last ${days} days.` }))];
    }

    // --- Status → Look-alikes (0.5.36) -----------------------------------------------------------------
    // Domains made to pass for yours, found by the look-alike watch, and an admin's mark on each.
    async function lookalikes() {
        const d = await api('/api/lookalikes');
        const STATUS = { new: ['New: a strong sign in mail', 'moved'], threat: ['A threat: a strong sign', 'moved'], baseline: ['There before the watch: a small sign', 'would'],
            ours: ['The district\'s own: no sign', 'inbox'], harmless: ['Someone else\'s, harmless: no sign', 'inbox'] };
        const mark = (e) => {
            const choices = [['ours', 'It\'s ours'], ['harmless', 'Harmless'], ['threat', 'A threat'], ['watch', 'Watch as found']].filter(([k]) => k !== e.status && !(k === 'watch' && (e.status === 'new' || e.status === 'baseline')));
            const sel = h('select', { 'aria-label': `Mark ${e.domain}` }, choices.map(([k, l]) => h('option', { value: k, text: l })));
            return h('div', { class: 'mark-lookalike' }, sel, confirmForm('Mark', '/api/lookalikes/mark', () => ({ domain: e.domain, status: sel.value }), (o) => `${o.entry.domain}: ${(STATUS[o.entry.status] || [o.entry.status])[0]}.`));
        };
        const pass = !d.on ? 'Off (LOOKALIKE_WATCH=off).' : !d.candidates ? 'Starting: the first names are asked at the next hourly run.'
            : `${num(d.candidates)} look-alike names of ${d.orgDomains.join(', ')} are asked of Cloudflare's public DNS once a day, about 80 an hour. ${d.cursor < d.candidates ? `This pass: ${num(d.cursor)} of ${num(d.candidates)} asked.` : `Last full pass ${when(d.lastPassAt)}.`}${d.baselineDone ? '' : ' The first pass takes stock: what exists already is listed without an alert.'}`;
        const fresh = d.found.filter(e => e.status === 'new' && !e.gone);
        return [h('h1', { text: 'Look-alike domains' }),
            h('p', { class: 'sub', text: 'Domains made to pass for yours (a letter left out or swapped, another ending, "-k12" or "schools" added…), found when they are registered: payroll and vendor fraud start with one. Mail from them, replies to them and links to them count as signs.' }),
            fresh.length ? h('div', { class: 'alert critical', role: 'alert' }, alertIcon('Alert'), h('div', { class: 'grow' }, h('b', { text: `${fresh.length === 1 ? 'A new look-alike was' : `${num(fresh.length)} new look-alikes were`} registered: ${fresh.map(e => e.domain).join(', ')}.` }),
                ` Mail from ${fresh.length === 1 ? 'it' : 'them'} is a strong sign. If the district registered ${fresh.length === 1 ? 'it' : 'one'} itself, mark it "It's ours".`)) : null,
            h('section', { class: 'card' }, h('dl', { class: 'kv' },
                kvRow('The watch', pass),
                kvRow('How it counts', 'New (registered since the watch began, or in the last 30 days) or marked a threat: the sender\'s domain 5, the reply address 5, a link 4 (strong evidence). There before the watch: 3, 3, 2. The district\'s own, or harmless: nothing.'),
                kvRow('What is sent', 'Only the look-alike names, to Cloudflare\'s public resolver (cloudflare-dns.com); a registry\'s date for each one found (RDAP). Nothing about any email.'))),
            h('section', { class: 'card' }, h('h2', { text: `Found (${num(d.found.length)})` }),
                d.found.length ? dataTable([
                    { name: 'Domain', get: e => h('span', { class: 'list-name' }, e.status === 'new' && !e.gone ? alertIcon('New') : null, e.domain) },
                    { name: 'Found', get: e => when(e.first) },
                    { name: 'Registered', get: e => (typeof e.ageDays === 'number' ? `${num(e.ageDays)} day${e.ageDays === 1 ? '' : 's'} before it was found` : 'not known') },
                    { name: 'Mail servers', get: e => (e.mx ? 'Yes' : 'No') },
                    { name: 'Website', get: e => (e.web ? 'Yes' : 'No') },
                    { name: 'Counts as', get: e => (e.gone ? `Gone (no longer registered, ${when(e.gone)})` : h('div', {}, pill(STATUS[e.status] || [e.status, '']), e.by ? h('div', { class: 'small muted', text: `marked by ${e.by}, ${when(e.at)}` }) : null)) },
                    { name: '', get: e => (e.gone ? null : mark(e)) }
                ], d.found, e => (e.status === 'new' && !e.gone ? 'row-alert' : '')) : h('div', { class: 'empty', text: d.candidates ? 'None of the look-alike names exists.' : 'Nothing asked yet.' })),
            d.demoProjectId ? h('p', { class: 'small muted', text: `Demo mode: the project ID is ${d.demoProjectId}.` }) : null];
    }

    // --- Settings → Link clicks (0.5.35; optional, off by default) ---------------------------------------
    async function clicksPage() {
        const d = await api('/api/clicks');
        const cl = d.clickLogs || {}, hl = d.health, t = d.test;
        const admin = h('input', { type: 'email', autocomplete: 'off', spellcheck: 'false', value: cl.admin || d.directoryAdmin || '', placeholder: 'admin@your-district.org', 'aria-label': 'Admin account' });
        const testOut = h('div', { class: 'small', role: 'status' });
        const testBtn = h('button', { class: 'btn', type: 'button' }, 'Test');
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true; testOut.textContent = 'Reading the last day of this admin\'s own Gmail log…';
            try {
                const o = await api('/api/clicks/test', { method: 'POST', body: { admin: admin.value } });
                testOut.textContent = !o.ok ? `Google refused: ${o.error}` : !o.events ? 'Google answered, with no events for the last day (no mail read, or this edition has no Gmail logs in the Reports API).'
                    : o.named ? `Working: ${num(o.events)} events in the last day, ${num(o.named)} naming their email. Clicks can be matched to emails.` : `Google answered with ${num(o.events)} events, but none names its email: clicks can't be matched to emails in this domain.`;
            } catch (e) { testOut.textContent = `Couldn't test: ${e.message}`; }
            finally { testBtn.disabled = false; }
        });
        const status = !cl.on ? 'Off' : hl && !hl.ok ? `On, but Gmail's logs couldn't be read (${when(hl.at)}): ${hl.error}` : hl ? `On: last read ${when(hl.at)} (${num(hl.checked)} emails).` : 'On: nothing to read yet (no re-checked mail).';
        const sw = cl.on ? confirmForm('Turn off', '/api/clicks', () => ({ on: false }), () => 'Link clicks is off: Gmail\'s logs are no longer read.')
            : confirmForm('Turn on', '/api/clicks', () => ({ on: true, admin: admin.value }), () => 'Link clicks is on: Gmail\'s logs are read for the re-checked mail.', h('div', { class: 'small muted', text: 'The admin account above is the one whose rights read the logs.' }));
        return [h('h1', { text: 'Link clicks' }),
            h('p', { class: 'sub', text: 'Who opened an email found to be phishing after it was delivered, and who clicked a link in it, from Gmail\'s own logs. Off by default.' }),
            (cl.on && hl && !hl.ok) ? h('div', { class: 'alert critical', role: 'alert' }, alertIcon('Alert'), h('div', { class: 'grow' }, h('b', { text: 'Link clicks is on, but Gmail\'s logs can\'t be read. ' }), hl.error)) : null,
            h('section', { class: 'card optional-note' }, h('h2', { text: 'Optional: the service works without it' }),
                h('div', { class: 'sub', text: 'Re-checking delivered mail doesn\'t need it. Without it, Email → Re-checked still lists who got each email and whether it had been opened (Gmail\'s unread mark when it was re-checked). Turned on, it adds, for each re-checked email:' }),
                h('ul', { class: 'benefits' },
                    h('li', {}, h('b', { text: 'A link clicked. ' }), 'Whether each person clicked a link in it (or in an attachment\'s preview), and when: the people whose password may have been given away. A click found is an alert: the admins are emailed.'),
                    h('li', {}, h('b', { text: 'When it was opened. ' }), 'The time each person first opened it, not only whether it was read.')),
                h('div', { class: 'small muted', text: 'Gmail\'s logs can take a few hours to show a click: each email is looked at again every 3 hours, 4 times. Nothing is sent outside Google; only the re-checked emails\' own events are kept on their records.' })),
            h('section', { class: 'card spaced' }, h('h2', { text: 'Status' }), h('dl', { class: 'kv' },
                kvRow('Link clicks', status),
                kvRow('Logs read as', cl.admin || 'not set'),
                t ? kvRow('Last test', t.ok ? `${when(t.at)} by ${t.by}: ${num(t.events)} events, ${num(t.named)} naming their email.` : `${when(t.at)} by ${t.by}: refused (${t.error}).`) : null,
                cl.by ? kvRow('Changed', `${cl.on ? 'Turned on' : 'Turned off'} by ${cl.by}, ${when(cl.at)}.`) : null),
                h('div', { class: 'policy-form sb-form' },
                    h('label', { class: 'project' }, h('span', { text: 'Admin account (Reports privilege)' }), admin),
                    h('div', { class: 'actions' }, testBtn), testOut,
                    d.demoProjectId ? h('div', { class: 'small muted', text: `Demo mode: the project ID is ${d.demoProjectId}; made-up logs are read.` }) : null),
                h('div', { class: 'actions' }, sw)),
            h('section', { class: 'card spaced' }, h('h2', { text: 'What it needs' }),
                h('ol', { class: 'steps' },
                    h('li', {}, h('b', { text: 'A Google Workspace edition with Gmail logs in the Reports API ' }), '(Gmail log events, not in every edition). To check: Admin console → Reporting → Audit and investigation → Gmail log events; if it is there and shows events, the logs exist. The Test button above says what Google answers.'),
                    h('li', {}, h('b', { text: 'One more scope on the service\'s domain-wide delegation: ' }), h('code', { text: 'https://www.googleapis.com/auth/admin.reports.audit.readonly' }), '. Admin console → Security → Access and data control → API controls → Manage Domain Wide Delegation → the service\'s client ID → Edit, add it to the line, Authorize (docs/INSTALL.md, "Link clicks").'),
                    h('li', {}, h('b', { text: 'An admin account with the Reports privilege ' }), '(a super admin has it), typed above: the service reads the logs with its rights. It reads only; nothing is changed.'),
                    h('li', {}, 'Test, then Turn on (with the project ID). Changes are noted in Status → Activity → What admins did.')))];
    }

    // --- Routing ---------------------------------------------------------------------------------
    const ROUTES = { overview, review, campaigns, users, messages, message, check, rechecked, lookalikes, health, readiness, activity, status, settings, allowlist, mailboxes, summary, retraining, safebrowsing: safeBrowsingPage, clicks: clicksPage, update: updatePage, about };
    // The top tabs: Overview, Email, Status, Settings. Email and Status each have a menu on the left; the
    // pages keep their own addresses (#/review, #/health…), so links to them still work. An email's page
    // and "Check an email" belong to Messages.
    const SECTIONS = {
        email: { label: 'Email', pages: [['review', 'Review'], ['campaigns', 'Campaigns'], ['messages', 'Messages'], ['rechecked', 'Re-checked'], ['users', 'Users']] },
        status: { label: 'Status', pages: [['status', 'Service status'], ['health', 'Model health'], ['readiness', 'Readiness'], ['lookalikes', 'Look-alikes'], ['activity', 'Activity']] },
        settings: { label: 'Settings', pages: [['settings', 'Policy'], ['allowlist', 'Allowlist'], ['mailboxes', 'Mailboxes'], ['summary', 'Weekly summary'], ['retraining', 'Retraining'], ['safebrowsing', 'Safe Browsing'], ['clicks', 'Link clicks'], ['update', 'Update'], ['about', 'About']] }
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

    // The period buttons, within how long records are kept (Settings → Policy): with 35 days, Last 90 days
    // becomes Last 35 days.
    function fitRanges(keep) {
        const k = Math.round(Number(keep));
        if (!(k > 0)) return;
        const buttons = [...document.querySelectorAll('.range')];
        buttons.forEach(b => { if (!b.dataset.wanted) b.dataset.wanted = b.dataset.days; });
        let shown = false;
        for (const b of buttons) {
            const want = Number(b.dataset.wanted);
            b.hidden = shown && want > k;
            if (!b.hidden) { b.dataset.days = String(Math.min(want, k)); b.textContent = `Last ${Math.min(want, k)} days`; }
            if (want >= k) shown = true;
        }
        const allowed = buttons.filter(b => !b.hidden).map(b => Number(b.dataset.days));
        if (!allowed.includes(days)) days = allowed.filter(n => n <= days).pop() || allowed[0];
        for (const b of buttons) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
    }
    async function boot() {
        for (const b of document.querySelectorAll('.range')) b.addEventListener('click', () => { days = Number(b.dataset.days); try { localStorage.setItem('spruce.days', String(days)); } catch (e) { /* not kept */ } render(); });
        if (MEMORY) document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="#/"]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });
        else window.addEventListener('hashchange', render);
        window.addEventListener('scroll', hideTip, { passive: true });
        // The review queue's keys (not while typing, nor with Ctrl, Alt or Cmd).
        document.addEventListener('keydown', (e) => {
            if (!reviewKeys || !/^#\/?review/.test(currentHash()) || e.ctrlKey || e.metaKey || e.altKey || acting || popupOpen()) return;
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
            fitRanges(st.retentionDays);
            if (st.demo) $('.top-right').prepend(h('span', { class: 'demo-flag', text: 'DEMO · made-up data' }));
            $('#foot').textContent = `Checks and AI model from S.P.R.U.C.E+ (${st.model.name} ${st.model.version}). Records keep the sender, subject and the checks' findings, never email bodies, and are deleted after ${st.retentionDays} days.`;
        } catch (e) { /* the view shows the error */ }
        render();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
