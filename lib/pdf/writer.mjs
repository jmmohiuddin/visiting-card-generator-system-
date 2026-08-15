/* The PDF file itself — objects, streams, the cross-reference table.
 *
 * There is no PDF library in this dependency tree on purpose. A press file has
 * to be a pure function of the spec so the golden-file suite in Technical
 * Design §11 can fail CI on any geometry drift, and the usual writers stamp a
 * creation date and a random /ID into every file, which makes two runs of the
 * same design two different documents. Everything here is content-derived:
 * the /ID is a hash of the bytes that precede the trailer, and no clock is
 * read anywhere. The cost is that this file has to know the format; the
 * benefit is that "the same spec always yields the same bytes" is a property
 * the suite can actually assert.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/** PDF numbers, rounded once and formatted identically every time. Trailing
 *  zeros are trimmed so the content stream stays readable to whoever at the
 *  press opens it in a text editor — which, in this market, happens. */
export function num(n) {
  if (!Number.isFinite(n)) throw new Error(`refusing to write a non-finite number into a press file: ${n}`);
  let s = (Math.round(n * 1e4) / 1e4).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/* A scale factor multiplies every coordinate under it, so it is the one
   number in the file that cannot be rounded to the drawing's tolerance:
   72/25.4 truncated to four places is a 1.6 ppm error on the whole page.
   Coordinates get `num`; matrices get this. */
export function scalar(n) { return String(+n.toPrecision(15)); }

/** A PDF text string. Non-ASCII goes out as UTF-16BE hex, which every reader
 *  since 1.4 understands and which avoids guessing at PDFDocEncoding. */
export function str(s) {
  const v = String(s);
  if (/^[\x20-\x7e]*$/.test(v)) return '(' + v.replace(/([\\()])/g, '\\$1') + ')';
  const buf = Buffer.from('\uFEFF' + v, 'utf16le').swap16();
  return '<' + buf.toString('hex') + '>';
}

/** A PDF name. `/` and whitespace are escaped as #xx, per the 1.2 rules. */
export function name(s) {
  return '/' + String(s).replace(/[^\x21-\x7e]|[#()<>\[\]{}\/%]/g, c => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

export class PdfBuilder {
  constructor() { this.objects = []; }

  /** Reserve an object number without writing it yet, for the forward
   *  references a page tree needs. */
  reserve() { this.objects.push(null); return this.objects.length; }

  put(ref, body) { this.objects[ref - 1] = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'latin1'); return ref; }

  obj(body) { return this.put(this.reserve(), body); }

  /** A stream object. Content streams are left uncompressed — they are a few
   *  kilobytes and being able to read the drawing operators is worth more
   *  than the saving. The ICC profile, at 1.8 MB, is not. */
  stream(dict, payload, { compress = false } = {}) {
    let data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'latin1');
    const entries = { ...dict };
    if (compress) { data = zlib.deflateSync(data, { level: 9 }); entries.Filter = '/FlateDecode'; }
    entries.Length = data.length;
    const head = Buffer.from('<< ' + Object.entries(entries).map(([k, v]) => `/${k} ${v}`).join(' ') + ' >>\nstream\n', 'latin1');
    return this.obj(Buffer.concat([head, data, Buffer.from('\nendstream', 'latin1')]));
  }

  dict(entries) {
    return this.obj('<< ' + Object.entries(entries).map(([k, v]) => `/${k} ${v}`).join(' ') + ' >>');
  }

  /** Assemble the file. `/ID` is the SHA-256 of everything up to the trailer,
   *  which gives two files the same identifier exactly when they are the same
   *  file — the property a content-addressed render cache (§7.1) needs. */
  build({ root, info, version = '1.6' }) {
    const parts = [Buffer.from(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
    let offset = parts[0].length;
    const offsets = [];

    for (let i = 0; i < this.objects.length; i++) {
      const body = this.objects[i];
      if (!body) throw new Error(`object ${i + 1} was reserved and never written`);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      offsets.push(offset);
      offset += b.length;
      parts.push(b);
    }

    const startxref = offset;
    let xref = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
    parts.push(Buffer.from(xref, 'latin1'));

    const body = Buffer.concat(parts);
    const id = crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
    const trailer = `trailer\n<< /Size ${this.objects.length + 1} /Root ${root} 0 R /Info ${info} 0 R ` +
                    `/ID [<${id}> <${id}>] >>\nstartxref\n${startxref}\n%%EOF\n`;
    return Buffer.concat([body, Buffer.from(trailer, 'latin1')]);
  }
}

/** A content-stream builder in millimetres with y running down the page, so
 *  the numbers in it line up one-for-one with the composed geometry the
 *  engine produced. The page CTM does the flip; nothing above this line has
 *  to think in points or in PDF's bottom-left origin. */
export class Content {
  constructor() { this.ops = []; }
  push(s) { this.ops.push(s); return this; }

  moveTo(x, y) { return this.push(`${num(x)} ${num(y)} m`); }
  lineTo(x, y) { return this.push(`${num(x)} ${num(y)} l`); }
  curveTo(x1, y1, x2, y2, x3, y3) { return this.push(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x3)} ${num(y3)} c`); }
  close() { return this.push('h'); }
  rect(x, y, w, h) { return this.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`); }

  fillCmyk({ c, m, y, k }) { return this.push(`${num(c)} ${num(m)} ${num(y)} ${num(k)} k`); }
  strokeCmyk({ c, m, y, k }) { return this.push(`${num(c)} ${num(m)} ${num(y)} ${num(k)} K`); }

  fill() { return this.push('f'); }
  fillEvenOdd() { return this.push('f*'); }
  stroke() { return this.push('S'); }
  lineWidth(w) { return this.push(`${num(w)} w`); }
  save() { return this.push('q'); }
  restore() { return this.push('Q'); }

  toString() { return this.ops.join('\n') + '\n'; }
}
