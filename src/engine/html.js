'use strict';
// An email's HTML, read the way the extension reads an opened email, but without a browser: the text a
// person sees, its links, and how it hides text (the extension's emailLayout, content.js).
//
// There is no rendered page here, so "hidden" means hidden by the email's OWN markup: display:none,
// visibility:hidden, opacity 0, a font under 2px, collapsed max-height with overflow hidden, the hidden
// attribute, and <head>/<style>/<script>/<noscript>/<template>. That catches what spam and phishing
// actually use (inline styles, because webmail drops style sheets), but not tricks that need layout
// (text the same color as its background, text pushed off-screen by a style sheet).
const { parseDocument } = require('htmlparser2');

const GAP_PX = 1000;              // an empty spacer this tall (by its own size) is a "large blank gap"
const FILLER_MIN = 200;           // characters after the gap that make it filler
const PICTURE_MIN_PX = 100;       // pictures this wide or more count as content (not tracking pixels)
const MAX_TEXT = 20000;
const SKIP_TAGS = new Set(['head', 'style', 'script', 'noscript', 'template', 'title', 'meta', 'link', 'object', 'iframe']);
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'center', 'blockquote', 'section', 'article', 'header', 'footer', 'hr', 'ul', 'ol']);
const QUOTE_CLASSES = /\b(gmail_quote|gmail_quote_container|gmail_extra|yahoo_quoted|moz-cite-prefix)\b/;

function styleOf(el) {
    const out = {};
    for (const part of String((el.attribs && el.attribs.style) || '').split(';')) {
        const i = part.indexOf(':');
        if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, '');
    }
    return out;
}
const px = (v) => { const m = /^(\d+(?:\.\d+)?)\s*(px)?$/.exec(String(v || '').trim()); return m ? parseFloat(m[1]) : NaN; };

function hiddenByOwnMarkup(el) {
    if (!el.attribs) return false;
    if ('hidden' in el.attribs) return true;
    const s = styleOf(el);
    if (s.display === 'none' || s.visibility === 'hidden') return true;
    if (s.opacity !== undefined && parseFloat(s.opacity) < 0.05) return true;
    if (s['font-size'] !== undefined && px(s['font-size']) < 2) return true;
    if ((px(s['max-height']) === 0 || px(s.height) === 0) && s.overflow === 'hidden') return true;
    return false;
}
function heightPx(el) {
    const s = styleOf(el);
    const h = px(s.height);
    if (Number.isFinite(h)) return h;
    return px(el.attribs && el.attribs.height);
}
function widthPx(el) {
    const a = px(el.attribs && el.attribs.width);
    if (Number.isFinite(a)) return a;
    return px(styleOf(el).width);
}
const textOf = (node) => {
    if (node.type === 'text') return node.data;
    if (!node.children) return '';
    return node.children.map(textOf).join('');
};
const hasMedia = (node) => !!node.children && node.children.some(c => (c.type === 'tag' && ['img', 'video', 'svg', 'canvas', 'iframe'].includes(c.name)) || hasMedia(c));
const decode = (s) => String(s || '').replace(/ /g, ' ');

// Reads the HTML. Returns { visibleText, hiddenText, preheader, layout: [...], links: [{ text, href }],
// pictures, quotedText }.
function readHtml(html) {
    const doc = parseDocument(String(html || ''), { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
    let visible = '', hidden = '', quoted = '', afterGap = 0, gapSeen = false, preheader = '', pictures = 0;
    const links = [];
    const push = (where, t) => {
        if (where === 'visible') { if (visible.length < MAX_TEXT) visible += t; }
        else if (where === 'hidden') { if (hidden.length < MAX_TEXT) hidden += t; }
        else if (quoted.length < MAX_TEXT) quoted += t;
    };
    function walk(node, state) {
        if (node.type === 'text') {
            const t = decode(node.data);
            if (!t.trim()) { if (state.where === 'visible' && !gapSeen) push('visible', ' '); return; }
            if (gapSeen && state.where === 'visible') { afterGap += t.trim().length; return; }
            push(state.where, t);
            return;
        }
        if (node.type !== 'tag' && node.type !== 'root' && node.type !== 'script' && node.type !== 'style') return;
        const name = node.name || '';
        if (node.type === 'script' || node.type === 'style' || SKIP_TAGS.has(name)) return;
        let where = state.where;
        if (where === 'visible' && hiddenByOwnMarkup(node)) {
            where = 'hidden';
            const t = textOf(node).replace(/\s+/g, ' ').trim();
            if (!preheader && t.length >= 10 && t.length <= 300 && !visible.trim()) preheader = t;
        }
        if (where !== 'hidden' && (name === 'blockquote' || QUOTE_CLASSES.test((node.attribs && node.attribs.class) || ''))) where = 'quoted';
        // An empty spacer at least GAP_PX tall: everything after it is out of the reader's sight.
        if (where === 'visible' && !gapSeen && name && heightPx(node) >= GAP_PX && !textOf(node).trim() && !hasMedia(node)) { gapSeen = true; return; }
        if (name === 'img') {
            const w = widthPx(node), h = px(node.attribs && node.attribs.height);
            const pixel = (Number.isFinite(w) && w <= 3) || (Number.isFinite(h) && h <= 3);
            if (where === 'visible' && !gapSeen && !pixel && (!Number.isFinite(w) || w >= PICTURE_MIN_PX)) pictures++;
        }
        if (name === 'a' && node.attribs && node.attribs.href && where !== 'quoted') {
            const alt = [];
            (function imgs(n) { for (const c of n.children || []) { if (c.type === 'tag' && c.name === 'img' && c.attribs && c.attribs.alt) alt.push(c.attribs.alt); imgs(c); } })(node);
            links.push({ text: (textOf(node).replace(/\s+/g, ' ').trim() || alt.join(' ')).slice(0, 2000), href: node.attribs.href.trim().slice(0, 8192), hidden: where === 'hidden', afterGap: gapSeen });
        }
        const block = BLOCK_TAGS.has(name);
        if (block && where === 'visible' && !gapSeen) push('visible', '\n');
        for (const c of node.children || []) walk(c, { where });
        if (block && where === 'visible' && !gapSeen) push('visible', '\n');
        if (name === 'td' && where === 'visible' && !gapSeen) push('visible', ' ');
    }
    walk(doc, { where: 'visible' });
    const clean = (t) => t.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    let visibleText = clean(visible);
    const layout = [];
    if (gapSeen && afterGap >= FILLER_MIN) layout.push('text after a large blank gap');
    if (visibleText.replace(/\s+/g, '').length < 60 && pictures > 0) {
        layout.push('images only');
        if (preheader) visibleText = `${preheader}\n${visibleText}`.trim();
    }
    return { visibleText, hiddenText: clean(hidden), quotedText: clean(quoted), preheader, layout, links, pictures };
}

module.exports = { readHtml, hiddenByOwnMarkup, GAP_PX, FILLER_MIN };
