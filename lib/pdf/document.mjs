/* The PDF/X-4 document shell: page boxes, output intent, metadata, marks.
 *
 * Everything in here is the part of a press file that has nothing to do with
 * the card and everything to do with whether the press can use it. The caller
 * hands over artwork already drawn; this file decides where the trim is, what
 * colour space the document is in, and what the RIP is told about both.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfBuilder, Content, num, scalar, str } from './writer.mjs';
import { refuse } from './refusal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PT_PER_MM = 72 / 25.4;
const mm = v => v * PT_PER_MM;

/* Room outside the bleed box for trim marks. Marks inside the bleed are a
   common mistake and a real one: the bleed exists so the artwork survives the
   guillotine wandering, and a mark printed in it lands on the card when the
   guillotine wanders the other way. */
export const MARK_MARGIN = 5;
const MARK_OFFSET = 0.5;      // clear of the bleed box before the mark starts
const MARK_LENGTH = 4;

/* PRD §7 and Technical Design §6.1: FOGRA39 is the assumed condition until a
   Dhaka press confirms its own. This is a default, not a measurement — the
   press capability record is where a real profile goes once one is obtained,
   and swapping this file is the whole of that change on this side. */
const ICC_PATH = path.join(ROOT, 'assets/icc/ISOcoated_v2_eci.icc');
const OUTPUT_CONDITION = 'Coated FOGRA39 (ISO 12647-2:2004)';

/* Read once and Flate-compressed once. The profile is 1.8 MB and identical in
   every file this writer produces, so compressing it per render was most of
   the render — Technical Design §7.2 budgets 40 ms for a print composition
   and deflating this alone cost twice that. */
let _icc = null, _iccZ = null;
function iccProfile() {
  if (_icc) return _icc;
  try { _icc = fs.readFileSync(ICC_PATH); }
  catch {
    refuse('icc_missing',
      `The FOGRA39 output profile is not vendored at assets/icc/ISOcoated_v2_eci.icc. A PDF/X-4 ` +
      `without an embedded output intent is not a PDF/X-4, and a press that colour-manages against ` +
      `an assumed profile is guessing.`);
  }
  if (_icc.subarray(36, 40).toString('latin1') !== 'acsp' || _icc.subarray(16, 20).toString('latin1') !== 'CMYK')
    refuse('icc_invalid', 'assets/icc/ISOcoated_v2_eci.icc is not a CMYK ICC profile.');
  return _icc;
}

/** Page boxes in millimetres, measured from the top-left of the media box. */
export function docGeometry(fmt) {
  const b = fmt.bleed, m = MARK_MARGIN;
  return {
    bleed: b, mark: m,
    mediaW: fmt.w + 2 * b + 2 * m, mediaH: fmt.h + 2 * b + 2 * m,
    trimX: m + b, trimY: m + b, trimW: fmt.w, trimH: fmt.h,
    bleedX: m, bleedY: m, bleedW: fmt.w + 2 * b, bleedH: fmt.h + 2 * b
  };
}

/* Millimetres, y down from the top-left of the media box, into PDF points
   with the origin bottom-left. Every drawing in this file works in the first
   frame and never has to think about the second. */
const FLIP = g => `${scalar(PT_PER_MM)} 0 0 ${scalar(-PT_PER_MM)} 0 ${scalar(mm(g.mediaH))} cm`;

const box = (x, y, w, h, H) => `[${num(mm(x))} ${num(mm(H - y - h))} ${num(mm(x + w))} ${num(mm(H - y))}]`;

/** Corner trim marks, in the /All separation so they appear on every plate
 *  and give the press something to register against. */
function trimMarks(g) {
  const c = new Content();
  c.push('/CSAll CS').push('1 SCN').lineWidth(0.1);
  const x0 = g.trimX, x1 = g.trimX + g.trimW, y0 = g.trimY, y1 = g.trimY + g.trimH;
  const out = g.bleed + MARK_OFFSET;
  for (const [x, sx] of [[x0, -1], [x1, 1]])
    for (const [y, sy] of [[y0, -1], [y1, 1]]) {
      c.moveTo(x + sx * out, y).lineTo(x + sx * (out + MARK_LENGTH), y);
      c.moveTo(x, y + sy * out).lineTo(x, y + sy * (out + MARK_LENGTH));
    }
  return c.stroke().toString();
}

function xmp({ title, docId, creator }) {
  /* No dc:date, no xmp:CreateDate. A timestamp would make two renders of one
     spec two different files, and Technical Design §7.1 caches print renders
     by spec hash forever — the file IS the identity. A validator that wants a
     creation date will flag its absence; a validator that wants a stable
     render will get one. `renderPrintPDF` takes an explicit `createdAt` for
     callers who need the stamp and can give up the determinism. */
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>${creator}</xmp:CreatorTool>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${creator}</pdf:Producer>
   <pdf:Trapped>False</pdf:Trapped>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
   <xmpMM:DocumentID>uuid:${docId}</xmpMM:DocumentID>
   <xmpMM:InstanceID>uuid:${docId}</xmpMM:InstanceID>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
   <pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Write one PDF/X-4 page. `art` is a content stream already drawn in
 *  millimetres with the origin at the top-left of the TRIM and y running
 *  down — the frame the composer's geometry is already in, so no element has
 *  to be translated by hand, and the caller can inspect what it painted
 *  before this turns it into a file somebody prints.
 *
 *  `spot`, when given, adds a named Separation colour space as `/CSSpot`,
 *  which is how a finish plate declares its colorant. */
export function writePdf({ fmt, title, subject, docId, creator, art, spot = null, createdAt = null }) {
  const g = docGeometry(fmt);
  const pdf = new PdfBuilder();

  const tint = pdf.obj('<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 1 1 1] /N 1 >>');
  const csAll = pdf.obj(`[/Separation /All /DeviceCMYK ${tint} 0 R]`);
  let csSpot = null;
  if (spot) {
    const f = pdf.obj(`<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [${spot.alternate.map(num).join(' ')}] /N 1 >>`);
    csSpot = pdf.obj(`[/Separation /${spot.name} /DeviceCMYK ${f} 0 R]`);
  }
  /* Overprint off, explicitly, on every plate this writer produces.
     Technical Design §6.1 requires it for the separations, and leaving it to
     the RIP's default on the composite is the kind of assumption that comes
     back as a black panel printing over the colour beneath it. */
  const gsOff = pdf.dict({ Type: '/ExtGState', OP: 'false', op: 'false', OPM: '0' });

  const body =
    `/GSOff gs\n` +
    `q\n${FLIP(g)}\n1 0 0 1 ${num(g.trimX)} ${num(g.trimY)} cm\n${art.toString()}Q\n` +
    `q\n${FLIP(g)}\n${trimMarks(g)}Q\n`;

  const content = pdf.stream({}, body);
  const resources = pdf.dict({
    ProcSet: '[/PDF]',
    ExtGState: `<< /GSOff ${gsOff} 0 R >>`,
    ColorSpace: `<< /CSAll ${csAll} 0 R${csSpot ? ` /CSSpot ${csSpot} 0 R` : ''} >>`
  });

  const pagesRef = pdf.reserve();
  const page = pdf.dict({
    Type: '/Page', Parent: `${pagesRef} 0 R`,
    MediaBox: box(0, 0, g.mediaW, g.mediaH, g.mediaH),
    BleedBox: box(g.bleedX, g.bleedY, g.bleedW, g.bleedH, g.mediaH),
    TrimBox: box(g.trimX, g.trimY, g.trimW, g.trimH, g.mediaH),
    Contents: `${content} 0 R`, Resources: `${resources} 0 R`
  });
  pdf.put(pagesRef, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);

  if (!_iccZ) _iccZ = zlib.deflateSync(iccProfile(), { level: 9 });
  const icc = pdf.stream({ N: 4, Filter: '/FlateDecode' }, _iccZ);
  const intent = pdf.dict({
    Type: '/OutputIntent', S: '/GTS_PDFX',
    OutputConditionIdentifier: str('FOGRA39'),
    OutputCondition: str(OUTPUT_CONDITION),
    RegistryName: str('http://www.color.org'),
    Info: str('ISO Coated v2 (ECI) — assumed default; replace per press once a profile is confirmed'),
    DestOutputProfile: `${icc} 0 R`
  });
  const meta = pdf.stream({ Type: '/Metadata', Subtype: '/XML' },
    xmp({ title, docId, creator }), { compress: false });

  const root = pdf.dict({
    Type: '/Catalog', Pages: `${pagesRef} 0 R`,
    OutputIntents: `[${intent} 0 R]`, Metadata: `${meta} 0 R`
  });
  /* /Subject is where the press instruction goes, because it is the one
     field every reader shows in Document Properties without being asked. A
     Nilkhet operator opening this file should be able to read the trim, the
     bleed, the ink ceiling and the die off the screen rather than the email
     that carried it. */
  const infoEntries = {
    Title: str(title), Creator: str(creator), Producer: str(creator),
    Trapped: '/False', GTS_PDFXVersion: str('PDF/X-4')
  };
  if (subject) infoEntries.Subject = str(subject);
  if (createdAt) { infoEntries.CreationDate = str(createdAt); infoEntries.ModDate = str(createdAt); }
  const info = pdf.dict(infoEntries);

  return pdf.build({ root, info });
}
