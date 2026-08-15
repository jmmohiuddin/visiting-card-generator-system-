/* Enhance a card someone already has.
 *
 * Takes either a file to read or an already-decomposed card, reports what could
 * be done to it in two tiers, and applies the repairs plus whichever
 * improvements the customer accepted.
 *
 * The response always separates the two tiers, and the screen must keep them
 * separate. A customer who is attached to their card will accept being told it
 * would be guillotined; they will not accept a tool that replaced their
 * typeface and filed it under "fixes".
 */
import { handler, ok, ERR, readJson } from '../../lib/http.mjs';
import { destructure, sniff } from '../../lib/ingest/index.mjs';
import { plan, enhance, TIER } from '../../lib/enhance/index.mjs';

const MAX_BODY = 12 * 1024 * 1024;

const capability = () => ({
  service: 'enhance',
  reads: ['image/svg+xml', 'application/pdf', 'image/png', 'image/jpeg'],
  tiers: [TIER.repair, TIER.improve],
  cannotYet: {
    raster: 'a PNG or JPEG yields its colours, its size and its resolution — not its words; nothing here guesses at text',
    redesign: 'this does not produce a different card, it produces the same card able to print. For a different card, run a brief.'
  }
});

export default handler('enhance', async (req) => {
  if (req.method === 'GET') return ok(capability());
  if (req.method !== 'POST') return ERR.badRequest('Send the card as a POST.');

  const [body, bad] = await readJson(req, MAX_BODY);
  if (bad) return bad;

  /* Either the caller sends a file, or it sends parts it already holds from a
     previous call. The second path is what makes accepting and declining
     improvements interactive without re-uploading and re-parsing each time. */
  let parts = body.parts && Array.isArray(body.parts.parts) ? body.parts : null;

  if (!parts) {
    const b64 = typeof body.file === 'string' ? body.file : null;
    if (!b64) return ERR.badRequest('Attach the card as base64 in `file`, or send `parts` from a previous read.',
      { field: 'file' });
    let bytes;
    try { bytes = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64'); }
    catch { return ERR.badRequest('That file did not decode.', { field: 'file' }); }
    if (!bytes.length) return ERR.badRequest('That file is empty.', { field: 'file' });
    if (!sniff(bytes)) return ERR.unprocessable('That file is not an SVG, PDF, PNG or JPEG.', {
      field: 'file',
      remediationText: 'Ask whoever made the card for the original file — an SVG or a PDF reads best.'
    });
    try {
      parts = destructure(bytes, { filename: String(body.filename || '').slice(0, 200),
                                   mime: body.mime, bytes: bytes.length });
    } catch (err) {
      return ERR.unprocessable(err.message || 'That card could not be read.', {
        code: err.code || 'unreadable', field: 'file',
        remediationText: err.remediationText ||
          'Type the content into the brief instead — the palette and the feel can still come from this file.'
      });
    }
  }

  /* A plan with nothing applied, so the screen can show the choice before the
     customer has made it. */
  if (body.planOnly) return ok({ parts, plan: plan(parts) });

  const accept = Array.isArray(body.accept) ? body.accept.filter(x => typeof x === 'string') : [];
  const result = enhance(parts, { accept, declineAll: body.declineAll === true });

  if (!result.ok) {
    /* The content genuinely does not fit any layout at a legible size. That is
       the constraint-conflict case the product already answers with three
       costed options, and the answer here is the same — not a worse card. */
    return ERR.unprocessable(result.reason, {
      code: 'no_layout_fits', alternatives: result.alternatives,
      applied: result.applied, plan: result.plan,
      remediationText: 'Shorten the longest line, move the qualifications to the back, or try portrait.'
    });
  }

  return ok({
    parts,
    plan: plan(parts),
    applied: result.applied,
    declined: result.declined,
    svg: result.svg,
    findings: result.findings,
    blocking: result.blocking, advisory: result.advisory, passed: result.passed,
    before: result.before, after: result.after,
    design: result.design, content: result.content
  });
});

export const config = { path: '/api/enhance' };
