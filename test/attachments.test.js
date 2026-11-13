'use strict';
// 0.5.34: attachments and pictures, read in the service. Every file here is made up, built in the test: QR
// codes (PNG, JPEG, in a PDF, in a Word file), web pages and SVG pictures, archives. No real email or file.
const test = require('node:test');
const assert = require('node:assert');
const QR = require('qrcode');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const { zipSync, strToU8 } = require('fflate');
const { readAttachments, kindOf, LIMITS } = require('../src/engine/attachments');
const { readMessage } = require('../src/engine/mime');
const { analyze } = require('../src/engine/analyze');
const { createFakeIntel } = require('../src/demo/fake-intel');

const ORG = 'maple-schools.example', USER = `reader@${ORG}`;
const qrPng = (text, width = 260) => QR.toBuffer(text, { width, margin: 2 });
async function qrJpeg(text) {
    const p = PNG.sync.read(await qrPng(text, 300));
    return jpeg.encode({ data: p.data, width: p.width, height: p.height }, 90).data;
}
async function qrPdf(text, link) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const img = await doc.embedPng(await qrPng(text, 300));
    page.drawImage(img, { x: 150, y: 350, width: 300, height: 300 });
    page.drawText('Scan to review your payroll update', { x: 150, y: 720, size: 14 });
    if (link) {
        const a = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [150, 700, 450, 740], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(link) } }));
        page.node.set(PDFName.of('Annots'), doc.context.obj([a]));
    }
    return Buffer.from(await doc.save());
}
async function docx({ link, qr, macros = false } = {}) {
    const files = {
        '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
        'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Please review the attached schedule.</w:t></w:r></w:p></w:body></w:document>`),
        'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0"?><Relationships>${link ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${link}" TargetMode="External"/>` : ''}</Relationships>`)
    };
    if (qr) files['word/media/image1.png'] = new Uint8Array(await qrPng(qr));
    if (macros) files['word/vbaProject.bin'] = new Uint8Array([1, 2, 3]);
    return Buffer.from(zipSync(files));
}
const file = (name, content, type = '', inline = false) => ({ name, type, size: content.length, content: Buffer.from(content), inline });
const kinds = (r) => r.signals.map(s => [s.kind, s.weight]);
const hosts = (r) => r.links.map(l => new URL(l.href).hostname);

test('what a file is: by its content first (a name can lie)', async () => {
    assert.equal(kindOf(file('photo.jpg', await qrPng('x'))), 'png');
    assert.equal(kindOf(file('scan.pdf', '%PDF-1.7\n...')), 'pdf');
    assert.equal(kindOf(file('Invoice.pdf', '<!DOCTYPE html><html><body>pay</body></html>')), 'html');
    assert.equal(kindOf(file('logo.png', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
    assert.equal(kindOf(file('report.docx', await docx())), 'office');
});

test('QR codes in pictures: PNG and JPEG, attached or inside the email; its link is checked; a QR code from outside is a small sign', async () => {
    const r = await readAttachments([file('scan.png', await qrPng('https://qr-png.example/login')), file('', await qrJpeg('https://qr-jpeg.example/a'), 'image/jpeg', true)], { outside: true });
    assert.deepEqual(hosts(r).sort(), ['qr-jpeg.example', 'qr-png.example']);
    assert.deepEqual(r.links.map(l => l.from).sort(), ['a QR code in a picture in the email', 'a QR code in scan.png']);
    assert.deepEqual(kinds(r), [['qr-code', 1]]);
    assert.match(r.signals[0].text, /It has 2 QR codes/);
    const inside = await readAttachments([file('scan.png', await qrPng('https://qr-png.example/login'))], { outside: false });
    assert.deepEqual(kinds(inside), [], 'from a colleague: the link is still checked, no sign for the code itself');
    assert.equal(inside.links.length, 1);
    const plain = await readAttachments([file('photo.png', PNG.sync.write(Object.assign(new PNG({ width: 50, height: 50 }), { data: Buffer.alloc(50 * 50 * 4, 200) })))]);
    assert.deepEqual([plain.links, plain.signals], [[], []], 'a picture without a code: nothing');
});

test('PDFs: a QR code in a picture on a page, a link, and an address written out', async () => {
    const r = await readAttachments([file('Payroll.pdf', await qrPdf('https://pdf-qr.example/verify?id=7', 'https://pdf-link.example/a'), 'application/pdf')]);
    assert.deepEqual(hosts(r).sort(), ['pdf-link.example', 'pdf-qr.example']);
    assert.ok(r.links.some(l => l.from === 'a QR code in Payroll.pdf (page 1)'));
    assert.ok(r.found.some(f => f.what === 'a QR code in Payroll.pdf (page 1): pdf-qr.example'));
});

test('Office files: hyperlinks, a QR code in a picture, macros', async () => {
    const r = await readAttachments([file('Schedule.docm', await docx({ link: 'https://docx-link.example/x', qr: 'https://docx-qr.example/y', macros: true }))]);
    assert.deepEqual(hosts(r).sort(), ['docx-link.example', 'docx-qr.example']);
    assert.ok(kinds(r).some(([k, w]) => k === 'macro-document' && w === 2));
});

test('web pages sent as files: a sign-in form (5), a page that builds itself or redirects (4), any other (1, outside only); their links checked', async () => {
    const login = await readAttachments([file('Voicemail.html', '<html><body><form action="https://form-post.example/collect"><input name="u"><input type="password" name="p"></form></body></html>', 'text/html')]);
    assert.deepEqual(kinds(login), [['attachment-login-form', 5]]);
    assert.deepEqual(hosts(login), ['form-post.example']);
    const smuggle = await readAttachments([file('Remittance.htm', `<html><script>document.write(atob("${Buffer.from('<p>hi</p>').toString('base64')}"));</script></html>`)]);
    assert.deepEqual(kinds(smuggle), [['attachment-script', 4]]);
    const redirect = await readAttachments([file('doc.html', '<html><head><meta http-equiv="refresh" content="0;url=https://redirect-to.example/p"></head></html>')]);
    assert.deepEqual([kinds(redirect), hosts(redirect)], [[['attachment-script', 4]], ['redirect-to.example']]);
    const plain = await readAttachments([file('menu.html', '<html><body><p>Lunch menu</p><a href="https://cafeteria.example/menu">menu</a></body></html>')]);
    assert.deepEqual(kinds(plain), [['html-attachment', 1]]);
    assert.deepEqual(kinds(await readAttachments([file('menu.html', '<html><body><p>Lunch menu</p></body></html>')], { outside: false })), []);
});

test('SVG pictures with a script or a form (4); a plain one is nothing', async () => {
    const bad = await readAttachments([file('fax.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>window.location="https://svg-go.example/x"</script></svg>', 'image/svg+xml')]);
    assert.deepEqual(kinds(bad), [['svg-active', 4]]);
    assert.deepEqual(hosts(bad), ['svg-go.example']);
    const fine = await readAttachments([file('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>')]);
    assert.deepEqual(kinds(fine), []);
});

test('the file itself: a double extension, a program or disk image, an archive needing a password or holding a page', async () => {
    assert.deepEqual(kinds(await readAttachments([file('Invoice.pdf.html', '<html><p>x</p></html>')])).map(k => k[0]), ['double-extension', 'html-attachment']);
    assert.deepEqual(kinds(await readAttachments([file('setup.iso', 'not really')])), [['risky-attachment', 3]]);
    // A zip whose entry is marked as needing a password (the flag set in its central directory), and one holding a page.
    const z = Buffer.from(zipSync({ 'notes.txt': strToU8('hello') }));
    const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt16LE(z.readUInt16LE(cd + 8) | 1, cd + 8);
    assert.deepEqual(kinds(await readAttachments([file('scan.zip', z)])), [['encrypted-archive', 2]]);
    const page = Buffer.from(zipSync({ 'docs/Invoice.html': strToU8('<html></html>') }));
    assert.deepEqual(kinds(await readAttachments([file('docs.zip', page)])), [['archive-risky-file', 3]]);
});

test('limits: a file over the size limit is skipped; at most LIMITS.files files are read', async () => {
    const before = LIMITS.fileBytes;
    LIMITS.fileBytes = 1000;
    try {
        const r = await readAttachments([file('big.png', await qrPng('https://too-big.example/x', 400))]);
        assert.deepEqual([r.links.length, r.skipped], [0, 1]);
    } finally { LIMITS.fileBytes = before; }
    const many = await Promise.all(Array.from({ length: LIMITS.files + 3 }, (_, i) => qrPng(`https://many-${i}.example/`, 120)));
    const r = await readAttachments(many.map((b, i) => file(`q${i}.png`, b)));
    assert.equal(r.links.length, LIMITS.files);
});

test('in the checks: a QR code in a PDF leading to a listed phishing site makes the email dangerous; the record keeps what was found, never the file', async () => {
    const b = 'b_att';
    const raw = Buffer.from([
        'From: "Payroll Office" <payroll@pay-portal-notice.example>', `To: ${USER}`, 'Subject: Action needed: payroll update', 'Message-ID: <att1@pay-portal-notice.example>',
        'Authentication-Results: mx.google.com; dkim=pass header.i=@pay-portal-notice.example; spf=pass; dmarc=pass header.from=pay-portal-notice.example',
        'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
        `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', 'Please scan the code in the attached document to confirm your payroll details.', '',
        `--${b}`, 'Content-Type: application/pdf; name="Payroll.pdf"', 'Content-Disposition: attachment; filename="Payroll.pdf"', 'Content-Transfer-Encoding: base64', '',
        (await qrPdf('https://maple-schools-payroll.example/login')).toString('base64').replace(/.{76}/g, '$&\r\n'), '',
        `--${b}--`, ''].join('\r\n'));
    const facts = await readMessage(raw);
    assert.equal(facts.attachmentFiles.length, 1);
    const r = await analyze(facts, { mailbox: USER, orgDomains: [ORG], intel: createFakeIntel() });
    assert.ok(r.signals.some(s => s.kind === 'dangerous-links'), JSON.stringify(r.signals.map(s => [s.kind, s.weight])));
    assert.ok(r.signals.some(s => s.kind === 'qr-code'));
    assert.equal(r.status, 'flagged');
    assert.ok(r.links.some(l => l.from === 'a QR code in Payroll.pdf (page 1)' && /maple-schools-payroll\.example/.test(l.url)));
    assert.ok(r.attachmentFindings.some(f => f.name === 'Payroll.pdf' && /maple-schools-payroll\.example/.test(f.what)));
    assert.ok(!JSON.stringify(r).includes('%PDF'), 'no file content in the answer');
});

test('a PDF whose picture is a JPEG (how scanners save them): its QR code is read too', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const img = await doc.embedJpg(await qrJpeg('https://pdf-jpeg-qr.example/scan'));
    page.drawImage(img, { x: 100, y: 300, width: 300, height: 300 });
    const r = await readAttachments([file('Scan_0042.pdf', Buffer.from(await doc.save()))]);
    assert.deepEqual(hosts(r), ['pdf-jpeg-qr.example']);
});
