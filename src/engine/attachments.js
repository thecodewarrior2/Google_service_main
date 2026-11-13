'use strict';
// Attachments and pictures, read in the service (0.5.34). Before, only their names and types were seen.
//
// - QR codes ("quishing": a QR code hides its link from every link check) in pictures (PNG, JPEG; attached,
//   or inline in the email), in PDFs and in Word, Excel and PowerPoint files. Each code's link is checked like
//   any link in the email (security services, phishing lists, site age, look-alikes).
// - Links in PDFs (link annotations and written-out addresses) and in Office files (hyperlinks).
// - Web pages and SVG pictures sent as files: a page asking for a password, a script that builds the page
//   from hidden data or sends the reader elsewhere ("HTML smuggling"), an SVG with a script or a form. Their
//   links are checked too.
// - The file itself: a double extension ("Invoice.pdf.html"), a program, script, shortcut or disk image, an
//   archive or PDF that needs a password (nothing can check inside), a document with macros.
//
// Nothing is stored: the files are read in memory and dropped; the record keeps what was found (a host, a
// sign), never a file. Limits keep a large or crafted file from costing much: LIMITS below, a time budget per
// email, and at most HEAVY_AT_ONCE files decoded at a time per instance.
const LIMITS = {
    files: 12,                     // attachments and inline pictures read per email
    fileBytes: 15 * 1024 * 1024,   // a bigger file is skipped (Gmail allows 25 MB per email)
    pdfPages: 5,
    pdfImages: 12,
    imagePixels: 24e6,             // a bigger picture is skipped (24 megapixels)
    qrSide: 1600,                  // pictures are scaled down to this before looking for a QR code
    zipEntries: 400,
    zipBytes: 40 * 1024 * 1024,    // unpacked, for an Office file
    htmlBytes: 2 * 1024 * 1024,
    budgetMs: 10000
};
const HEAVY_AT_ONCE = 2;

let pdfjs = null;
const loadPdfjs = async () => (pdfjs = pdfjs || await import('pdfjs-dist/legacy/build/pdf.mjs'));

// At most HEAVY_AT_ONCE decodes at a time on this instance (memory: a 24-megapixel picture is ~100 MB).
let running = 0;
const waiting = [];
async function heavy(fn) {
    if (running >= HEAVY_AT_ONCE) await new Promise(r => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; const next = waiting.shift(); if (next) next(); }
}

const extOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const RISKY_EXT = new Set(['exe', 'scr', 'com', 'pif', 'lnk', 'iso', 'img', 'vhd', 'vhdx', 'hta', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'bat', 'cmd', 'msi', 'msix', 'jar', 'cpl', 'reg', 'xll', 'iqy', 'one', 'url', 'appx', 'application', 'msc', 'library-ms', 'search-ms']);
const PAGE_EXT = new Set(['html', 'htm', 'shtml', 'xhtml', 'mht', 'mhtml']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm', 'txt', 'rtf', 'csv', 'jpg', 'jpeg', 'png', 'gif', 'zip', 'odt', 'eml']);

// What a file is, by its content first (a name can lie), then its type and name.
function kindOf(f) {
    const b = f.content || Buffer.alloc(0), type = String(f.type || '').toLowerCase(), ext = extOf(f.name);
    if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    const head = b.slice(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return ['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm'].includes(ext) ? 'office' : 'zip';
    if (type === 'image/svg+xml' || ext === 'svg' || /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head)) return 'svg';
    if (type === 'text/html' || PAGE_EXT.has(ext) || /^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|<form[\s>])/.test(head)) return 'html';
    if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
    return 'other';
}

// A QR code in a picture's pixels (RGBA), or null. Big pictures are scaled down first (codes survive it).
function qrIn(rgba, width, height) {
    const jsQR = require('jsqr');
    const scale = Math.max(width, height) > LIMITS.qrSide ? LIMITS.qrSide / Math.max(width, height) : 1;
    let data = rgba, w = width, h = height;
    if (scale < 1) {
        w = Math.max(1, Math.round(width * scale)); h = Math.max(1, Math.round(height * scale));
        data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
            const sy = Math.min(height - 1, Math.floor(y / scale));
            for (let x = 0; x < w; x++) {
                const sx = Math.min(width - 1, Math.floor(x / scale)), s = (sy * width + sx) * 4, d = (y * w + x) * 4;
                data[d] = rgba[s]; data[d + 1] = rgba[s + 1]; data[d + 2] = rgba[s + 2]; data[d + 3] = 255;
            }
        }
    }
    const code = jsQR(data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data), w, h, { inversionAttempts: 'attemptBoth' });
    return code && code.data ? String(code.data).slice(0, 4096) : null;
}
function decodeImage(kind, buf) {
    if (kind === 'png') { const p = require('pngjs').PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data }; }
    if (kind === 'jpeg') return require('jpeg-js').decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: LIMITS.imagePixels / 1e6, maxMemoryUsageInMB: 512 });
    return null;
}
function qrInImage(kind, buf) {
    const img = decodeImage(kind, buf);
    if (!img || img.width * img.height > LIMITS.imagePixels) return null;
    return qrIn(img.data, img.width, img.height);
}

// A pdf.js image (kind 1: 1-bit grey, 2: RGB, 3: RGBA) as RGBA.
function pdfImageRgba(im) {
    const n = im.width * im.height;
    if (!im.data || !n || n > LIMITS.imagePixels) return null;
    if (im.kind === 3) return im.data;
    const out = new Uint8ClampedArray(n * 4);
    if (im.kind === 2) { for (let j = 0, k = 0; k < out.length; j += 3, k += 4) { out[k] = im.data[j]; out[k + 1] = im.data[j + 1]; out[k + 2] = im.data[j + 2]; out[k + 3] = 255; } return out; }
    if (im.kind === 1) {
        const rowBytes = (im.width + 7) >> 3;
        for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
            const v = (im.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0, k = (y * im.width + x) * 4;
            out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = 255;
        }
        return out;
    }
    return null;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'()\\]{4,2000}/gi;

async function readPdf(f, out, deadline) {
    const lib = await loadPdfjs();
    let pdf;
    try {
        pdf = await lib.getDocument({ data: new Uint8Array(f.content), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
    } catch (e) {
        if (e && e.name === 'PasswordException') out.sign('encrypted-pdf', 2, `The PDF ${f.name} needs a password to open, so nothing inside it can be checked. Sending the password in the email is a way to get malware or a phishing page past filters.`);
        return;
    }
    try {
        // JavaScript in a PDF (opening, or a document action): rare in a real one.
        let js = null;
        try { js = await pdf.getJSActions(); } catch (e) { js = null; }
        if (js && Object.keys(js).length) out.sign('pdf-script', 2, `The PDF ${f.name} runs a script when it is opened.`);
        for (let n = 1; n <= Math.min(pdf.numPages, LIMITS.pdfPages) && Date.now() < deadline; n++) {
            const page = await pdf.getPage(n);
            for (const a of await page.getAnnotations().catch(() => [])) if (a && a.url) out.link(a.url, `a link in ${f.name}`);
            const text = await page.getTextContent().catch(() => ({ items: [] }));
            for (const m of text.items.map(i => i.str || '').join(' ').match(URL_IN_TEXT) || []) out.link(m, `an address written in ${f.name}`);
            const ops = await page.getOperatorList().catch(() => null);
            if (!ops) continue;
            let images = 0;
            for (let i = 0; i < ops.fnArray.length && images < LIMITS.pdfImages && Date.now() < deadline; i++) {
                const fn = ops.fnArray[i];
                let im = null;
                if (fn === lib.OPS.paintImageXObject) {
                    const name = ops.argsArray[i][0];
                    // (pdf.js: a page's own images, or shared ones, named "g_…")
                    const objs = String(name).startsWith('g_') ? page.commonObjs : page.objs;
                    im = await new Promise((res) => { const t = setTimeout(() => res(null), 3000); try { objs.get(name, (v) => { clearTimeout(t); res(v); }); } catch (e) { clearTimeout(t); res(null); } });
                } else if (fn === lib.OPS.paintInlineImageXObject) im = ops.argsArray[i][0];
                if (!im) continue;
                images++;
                const rgba = pdfImageRgba(im);
                const code = rgba ? qrIn(rgba, im.width, im.height) : null;
                if (code) out.qr(code, `a QR code in ${f.name} (page ${n})`);
            }
        }
    } finally { try { await pdf.destroy(); } catch (e) { /* gone */ } }
}

function readOffice(f, out) {
    const { unzipSync } = require('fflate');
    let total = 0, count = 0, macros = false;
    const want = (n) => /(^|\/)_rels\/[^/]*\.rels$/.test(n) || /^word\/document\.xml$/.test(n) || /^(word|xl|ppt)\/media\/[^/]+\.(png|jpe?g)$/i.test(n);
    let files;
    try {
        files = unzipSync(new Uint8Array(f.content), { filter: (e) => {
            count++;
            if (/vbaProject\.bin$/i.test(e.name)) macros = true;
            if (count > LIMITS.zipEntries || !want(e.name)) return false;
            total += e.originalSize || 0;
            return total <= LIMITS.zipBytes && (e.originalSize || 0) <= LIMITS.fileBytes;
        } });
    } catch (e) { return; }
    if (macros || /m$/.test(extOf(f.name))) out.sign('macro-document', 2, `The file ${f.name} has macros (programs inside a document): a common way to deliver malware.`);
    for (const [name, data] of Object.entries(files)) {
        if (/\.rels$/.test(name)) {
            const xml = Buffer.from(data).toString('utf8');
            for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
                const tag = m[0];
                if (!/TargetMode="External"/i.test(tag)) continue;
                const t = (/Target="([^"]+)"/i.exec(tag) || [])[1];
                if (t && /^https?:/i.test(t)) out.link(t.replace(/&amp;/g, '&'), `a link in ${f.name}`);
            }
        } else if (/document\.xml$/.test(name)) {
            const xml = Buffer.from(data).toString('utf8');
            for (const m of xml.matchAll(/HYPERLINK\s+(?:&quot;|")(https?:[^"&]+)/gi)) out.link(m[1], `a link in ${f.name}`);
        } else {
            const kind = /\.png$/i.test(name) ? 'png' : 'jpeg';
            try { const code = qrInImage(kind, Buffer.from(data)); if (code) out.qr(code, `a QR code in ${f.name}`); } catch (e) { /* not a picture */ }
        }
    }
}

// A web page or SVG sent as a file: its forms, scripts, redirects and links.
function readPage(f, out, svg) {
    const htmlparser2 = require('htmlparser2');
    const text = f.content.slice(0, LIMITS.htmlBytes).toString('utf8');
    let password = false, form = false, script = '', active = false, redirect = null, inScript = false;
    const parser = new htmlparser2.Parser({
        onopentag(name, attrs) {
            const n = name.toLowerCase();
            const href = attrs.href || attrs['xlink:href'] || '';
            if (n === 'form') { form = true; if (attrs.action) out.link(attrs.action, `the form in ${f.name}`); }
            if (n === 'input' && String(attrs.type || '').toLowerCase() === 'password') password = true;
            if (n === 'a' && /^https?:/i.test(href)) out.link(href, `a link in ${f.name}`);
            if ((n === 'iframe' || n === 'embed' || n === 'object') && /^https?:/i.test(attrs.src || attrs.data || '')) out.link(attrs.src || attrs.data, `a frame in ${f.name}`);
            if (n === 'meta' && /refresh/i.test(attrs['http-equiv'] || '')) { const u = (/url\s*=\s*['"]?([^'";\s]+)/i.exec(attrs.content || '') || [])[1]; if (u) { redirect = u; out.link(u, `the redirect in ${f.name}`); } }
            if (svg && (n === 'script' || n === 'foreignobject' || Object.keys(attrs).some(a => /^on[a-z]+$/i.test(a)))) active = true;
        },
        ontext(t) { if (inScript && script.length < 400000) script += t.slice(0, 200000); },
        onopentagname(name) { inScript = name.toLowerCase() === 'script'; },
        onclosetag(name) { if (name.toLowerCase() === 'script') inScript = false; }
    }, { decodeEntities: true, lowerCaseTags: true, xmlMode: false });
    parser.write(text); parser.end();
    for (const m of script.match(URL_IN_TEXT) || []) out.link(m, `a script in ${f.name}`);
    // A script that builds the page from hidden data, or sends the reader elsewhere.
    const builds = /\b(atob|unescape|fromCharCode|decodeURIComponent)\s*\(|document\.write\s*\(|\.innerHTML\s*=|new\s+Blob\s*\(|createObjectURL/.test(script) || /[A-Za-z0-9+/=]{2000,}/.test(script);
    const sends = /\b(window\.|document\.|self\.|top\.)?location(\.href)?\s*=|location\.(replace|assign)\s*\(|window\.open\s*\(/.test(script);
    const name = f.name || (svg ? 'an SVG picture' : 'a web page');
    if (svg) {
        if (active || form || password) out.sign('svg-active', 4, `The SVG picture ${name} contains a script or a form: real pictures don't. Opening it can show a sign-in page or send the reader to one.`);
    } else if (password) {
        out.sign('attachment-login-form', 5, `The attached web page ${name} asks for a password. A sign-in page sent as a file is a phishing trick: it never comes from a real sign-in.`);
    } else if (builds || sends || redirect) {
        out.sign('attachment-script', 4, `The attached web page ${name} ${builds ? 'builds itself from hidden data when opened' : 'sends whoever opens it to another site'}: a way to sneak a phishing page past filters.`);
    } else out.sign('html-attachment', 1, `A web page sent as a file (${name}): unusual in real mail.`);
}

// A plain zip: entries that need a password, and what is inside (no unpacking).
function readZip(f, out) {
    const b = f.content;
    let encrypted = false, risky = null, seen = 0;
    for (let i = 0; i + 46 <= b.length && seen < LIMITS.zipEntries; i++) {
        if (b.readUInt32LE(i) !== 0x02014b50) continue;   // central directory entry
        seen++;
        if (b.readUInt16LE(i + 8) & 1) encrypted = true;
        const nameLen = b.readUInt16LE(i + 28);
        const inner = b.slice(i + 46, i + 46 + nameLen).toString('utf8');
        const ext = extOf(inner);
        if (!risky && (RISKY_EXT.has(ext) || PAGE_EXT.has(ext))) risky = inner.split('/').pop();
        i += 45 + nameLen;
    }
    if (encrypted) out.sign('encrypted-archive', 2, `The archive ${f.name} needs a password, so nothing inside it can be checked: a common way to get malware past filters.`);
    if (risky) out.sign('archive-risky-file', 3, `The archive ${f.name} holds ${risky}, a program, script or web page.`);
}

// files: [{ name, type, size, content: Buffer, inline }]. ctx: { outside } (an outside sender; a forged inside
// address counts as outside). { links: [{ href, text, from }], signals, found: [{ name, what }], skipped }
async function readAttachments(files, { outside = true, budgetMs = LIMITS.budgetMs } = {}) {
    const deadline = Date.now() + budgetMs;
    const links = [], signals = [], found = [], seenLinks = new Set(), seenSigns = new Set();
    let skipped = 0, qrs = 0;
    for (const f of (files || []).slice(0, LIMITS.files)) {
        const name = String(f.name || '').slice(0, 120) || (f.inline ? 'a picture in the email' : 'an attachment');
        const ext = extOf(f.name);
        const out = {
            link(u, from) {
                const url = String(u || '').trim().slice(0, 8192);
                if (!/^https?:\/\//i.test(url) || seenLinks.has(url) || links.length >= 60) return;
                seenLinks.add(url); links.push({ href: url, text: '', from });
                found.push({ name, what: `${from}: ${hostOf(url)}` });
            },
            qr(code, from) {
                qrs++;
                if (/^https?:\/\//i.test(code)) this.link(code, from);
                else found.push({ name, what: `${from}: ${code.slice(0, 80)}` });
            },
            sign(kind, weight, text) { if (!seenSigns.has(kind)) { seenSigns.add(kind); signals.push({ weight, kind, text }); found.push({ name, what: text }); } }
        };
        // The name, whatever is inside.
        const parts = String(f.name || '').toLowerCase().split('.');
        if (parts.length >= 3 && DOC_EXT.has(parts[parts.length - 2]) && (RISKY_EXT.has(ext) || PAGE_EXT.has(ext) || ext === 'svg'))
            out.sign('double-extension', 3, `The attachment ${name} pretends to be a ${parts[parts.length - 2].toUpperCase()} but is a ${ext.toUpperCase()} file.`);
        else if (RISKY_EXT.has(ext)) out.sign('risky-attachment', 3, `The attachment ${name} is a program, script, shortcut or disk image (.${ext}): real mail rarely sends one.`);
        const buf = f.content;
        if (!buf || !buf.length) continue;
        if (buf.length > LIMITS.fileBytes || Date.now() > deadline) { skipped++; continue; }
        const kind = kindOf(f);
        try {
            if (kind === 'png' || kind === 'jpeg') {
                const code = await heavy(async () => qrInImage(kind, buf));
                if (code) out.qr(code, f.inline ? 'a QR code in a picture in the email' : `a QR code in ${name}`);
            } else if (kind === 'pdf') await heavy(() => readPdf(Object.assign({}, f, { name }), out, deadline));
            else if (kind === 'office') await heavy(async () => readOffice(Object.assign({}, f, { name }), out));
            else if (kind === 'html') readPage(Object.assign({}, f, { name }), out, false);
            else if (kind === 'svg') readPage(Object.assign({}, f, { name }), out, true);
            else if (kind === 'zip') readZip(Object.assign({}, f, { name }), out);
        } catch (e) { skipped++; }
    }
    // A QR code from outside is a sign on its own (small): its link is judged like the others.
    if (qrs && outside) signals.push({ weight: 1, kind: 'qr-code', text: `It has ${qrs === 1 ? 'a QR code' : `${qrs} QR codes`}: a QR code hides its link from the reader (and from most checks) until a phone opens it.` });
    if (!outside) for (let i = signals.length - 1; i >= 0; i--) if (signals[i].kind === 'html-attachment') signals.splice(i, 1);
    return { links, signals, found: found.slice(0, 20), skipped };
}

module.exports = { readAttachments, kindOf, qrIn, LIMITS };
