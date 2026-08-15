/* Take an uploaded card apart, and apply bounded edits to the result.
 *
 * Two things this endpoint is careful about, both because it accepts files
 * from strangers.
 *
 * It never trusts the declared content type. `sniff()` reads the magic bytes,
 * and the reader that runs is chosen from what the file actually is — a
 * content-type header is a claim by the uploader, and dispatching a parser on
 * a claim is the standard way a file endpoint goes wrong.
 *
 * And it refuses rather than guesses. Every failure carries a named code and a
 * sentence saying what the customer can do instead, because "we could not read
 * your card" with no next step is where someone gives up and goes back to the
 * shop.
 */
import { handler, ok, ERR, readJson, idempotencyKey } from '../../lib/http.mjs';
import { destructure, sniff } from '../../lib/ingest/index.mjs';
import { applyPartOps, previewOf, coloursFor, familiesFor, sizeRangeFor } from '../../lib/ingest/edit.mjs';
import { PART_OPS } from '../../lib/ingest/contract.mjs';

/* Base64 is 4 characters per 3 bytes, so the JSON body limit has to be a third
   larger than the file limit it is protecting. */
const MAX_BODY = 12 * 1024 * 1024;

const capability = () => ({
  service: 'destructure',
  reads: ['image/svg+xml', 'application/pdf', 'image/png', 'image/jpeg'],
  operations: Object.keys(PART_OPS),
  /* Stated rather than implied, because a customer who uploads a photograph
     and gets no text back deserves to have been told first. */
  cannotYet: {
    raster: 'text and fonts cannot be read out of a PNG or JPEG — there is no OCR here, and guessing at the words would not be caught until the cards were printed',
    pdfOutlined: 'a PDF whose type has been converted to outlines contains no text to recover, only shapes and colours',
    geometry: 'a part can be restyled but not repositioned — where things sit is the composer\'s decision, which is what keeps the output printable'
  }
});

export default handler('destructure', async (req) => {
  if (req.method === 'GET') return ok(capability());
  if (req.method !== 'POST') return ERR.badRequest('Send the file as a POST.');

  const [body, bad] = await readJson(req, MAX_BODY);
  if (bad) return bad;

  /* ── apply edits to parts the client already holds ── */
  if (Array.isArray(body.ops)) {
    if (!body.parts || !Array.isArray(body.parts.parts))
      return ERR.badRequest('Send the decomposed card along with the operations.', { field: 'parts' });
    if (body.ops.length > 64)
      return ERR.badRequest('That is more changes than one request should carry.', { field: 'ops' });

    const r = applyPartOps(body.parts, body.ops);
    if (!r.ok) return ERR.unprocessable(r.refusal.reason, {
      field: 'ops', alternatives: r.refusal.alternatives,
      applied: r.applied.length,
      remediationText: r.refusal.alternatives?.length
        ? 'Try one of the alternatives listed.' : 'Undo the last change.'
    });
    return ok({ parts: r.parts, applied: r.applied.length, preview: strip(r.preview) });
  }

  /* ── options for one part, so the editor never offers what will be refused ── */
  if (body.optionsFor) {
    if (!body.parts) return ERR.badRequest('Send the decomposed card too.', { field: 'parts' });
    const part = body.parts.parts.find(p => p.id === body.optionsFor);
    if (!part) return ERR.notFound('No part with that id on this card.');
    return ok({
      colours: coloursFor(body.parts, part),
      families: familiesFor(part),
      size: sizeRangeFor(part)
    });
  }

  /* ── the upload itself ── */
  const b64 = typeof body.file === 'string' ? body.file : null;
  if (!b64) return ERR.badRequest('Attach the card as base64 in `file`.', { field: 'file' });

  let bytes;
  try { bytes = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64'); }
  catch { return ERR.badRequest('That file did not decode.', { field: 'file' }); }
  if (!bytes.length) return ERR.badRequest('That file is empty.', { field: 'file' });

  const kind = sniff(bytes);
  if (!kind) return ERR.unprocessable('That file is not an SVG, PDF, PNG or JPEG.', {
    field: 'file',
    remediationText: 'Ask whoever made the card for the original file — an SVG or a PDF reads best.'
  });

  let parts;
  try {
    parts = destructure(bytes, { filename: String(body.filename || '').slice(0, 200), mime: body.mime, bytes: bytes.length });
  } catch (err) {
    /* A reader that could not read is not a server fault, and the code it
       throws is more useful to the screen than a generic 500. */
    return ERR.unprocessable(err.message || 'That card could not be taken apart.', {
      code: err.code || 'unreadable', field: 'file',
      remediationText: err.remediationText ||
        'Type the content into the brief instead — the palette and the feel can still come from this file.'
    });
  }

  const preview = previewOf(parts);
  return ok({ parts, preview: strip(preview), kind });
});

/* The composed geometry is large and the client does not need it — the SVG is
   what it draws. Sending both doubles the payload on a metered connection for
   nothing (Master PRD §3.1: the real device is a mid-range phone on data). */
const strip = (p) => !p ? null : p.ok
  ? { ok: true, svg: p.svg, findings: p.findings, blocking: p.blocking,
      advisory: p.advisory, passed: p.passed, design: p.design, content: p.content }
  : { ok: false, reason: p.reason, alternatives: p.alternatives };

export const config = { path: '/api/destructure' };
