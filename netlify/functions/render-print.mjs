/* The press file.
 *
 * Everything else in this product can be redone. A run of 500 cards cannot —
 * once the plates are cut and the sheet is printed, a defect in this file is
 * paper in a bin and a customer who trusted us. So this endpoint is written
 * around refusal rather than around output: it composes the design on the
 * server, runs the engine's own preflight against that composition, and only
 * writes bytes when nothing blocking came back. Technical Design §6.3 gives
 * no override on a blocking finding, and there is no query parameter here
 * that adds one.
 *
 * The file it produces carries no fonts (PRD §7 — outlined, never embedded),
 * no RGB, no transparency and no timestamp. That last one is not fussiness:
 * a print render is cached by spec hash forever (§7.1), so the same design
 * has to keep producing the same bytes, and a clock in the file would make
 * every re-order a different document.
 */
import { handler, ok, ERR, fail, readJson, db, CODE_RE } from '../../lib/http.mjs';
import { engine } from '../../lib/engine-node.mjs';
import { renderPrintPDF, PrintRefusal, specialsFor, vendoredFamilies } from '../../lib/pdf/index.mjs';

/* What the screen should offer the customer next, per refusal. The error
   envelope carries `remediation` precisely so the UI does not have to keep a
   parallel table of what each failure means (lib/http.mjs). */
const REMEDIATION = {
  preflight_blocking:            'Go back to Validate and clear the blocking findings.',
  layout_eliminated:             'Choose another concept — this content does not fit this composition.',
  tac_exceeded:                  'Choose a lighter palette.',
  outside_safe_area:             'Shorten the named field, or choose a concept with more room for it.',
  glyph_collision:               'Shorten the named field, or choose another concept.',
  bangla_broken_cluster:         'Retype the Bangla text named in the message — it is not a syllable the script forms.',
  bangla_no_gsub:                'Choose another Bangla type system: this face carries no shaping rules at all.',
  bangla_no_bengali_script:      'Choose another Bangla type system: this face carries no Bengali shaping rules.',
  bangla_no_shaping_lookups:     'Choose another Bangla type system: this face registers Bengali but ships no rules for it.',
  bangla_unreadable_lookup:      'Choose another Bangla type system, and report this face — its layout tables are not fully readable.',
  logo_not_supported:            'Export without the logo and send the mark to the press separately.',
  finish_crosses_trim_clearance: 'Drop this finish, or choose a concept whose mark sits further inside the trim.',
  choke_consumes_plate:          'Enlarge the mark, or drop this finish.',
  glyph_missing:                 'Remove the unsupported character, or choose another type system.',
  icc_missing:                   'This deploy is incomplete — report it rather than working around it.',
  icc_invalid:                   'This deploy is incomplete — report it rather than working around it.'
};

const pdfHeaders = (filename, extra = {}) => ({
  'content-type': 'application/pdf',
  'content-disposition': `attachment; filename="${filename}"`,
  'cache-control': 'no-store',
  ...extra
});

/* A saved design is loaded exactly the way `designs.mjs` stores it: the short
   code is the name of an immutable spec, so the file this returns for a code
   today is the file it returns for that code in a year. */
async function specForCode(code) {
  const sql = db();
  if (!sql) return [null, ERR.unavailable()];
  const rows = await sql`SELECT spec_json FROM design_specs WHERE short_code = ${code} LIMIT 1`;
  if (!rows.length) return [null, ERR.notFound('No saved design with that code.')];
  return [rows[0].spec_json, null];
}

/** The spec has to name records the library actually holds. Composing against
 *  a missing id throws somewhere deep instead of saying which field is wrong,
 *  and "which field" is the whole content of a useful error. */
function validateSpec(E, spec) {
  if (!spec || typeof spec !== 'object') return 'A spec or a shortCode is required.';
  const checks = [
    ['format', E.FORMATS], ['type', E.TYPE_SYSTEMS], ['palette', E.PALETTES], ['layout', E.LAYOUTS]
  ];
  for (const [field, library] of checks)
    if (!library.some(r => r.id === spec[field])) return `spec.${field} is not a library id: ${spec[field]}`;
  if (!spec.content || typeof spec.content !== 'object') return 'spec.content is required.';
  return null;
}

export default handler('render-print', async (req) => {
  const E = engine();

  /* A GET is what `assets/ui-order.js` probes with to find out whether this
     build has a print writer at all. Answering with the writer's actual
     capabilities is more useful than a bare 405, and it is the honest place
     to state what it cannot do rather than letting a customer find out at
     the moment they press Export. */
  if (req.method === 'GET')
    return ok({
      writer: 'PDF/X-4:2010, DeviceCMYK, fonts outlined',
      bleedMm: 3, safeMm: 4,
      outputIntent: 'FOGRA39 (ISO Coated v2, ECI) — assumed default until a press confirms its own',
      tacLimit: { coated: 300, uncoated: 280 },
      separations: ['foil_gold', 'spot_uv', 'emboss'],
      fonts: vendoredFamilies(),
      /* Bangla has moved out of `cannotYet`. It is shaped through the font's
         own GSUB and GPOS and checked glyph for glyph against headless
         Chromium in tests/shaping.test.mjs, so leaving it here would be the
         same kind of lie the refusal was written to avoid — just pointing the
         other way. `canNow` states it rather than letting a missing key be
         read as an oversight. */
      canNow: {
        bangla: 'Bangla is shaped and outlined: conjuncts (যুক্তাক্ষর), reph, ra-phala and ya-phala, ' +
                'the pre-base vowel signs and the two-part matras ো and ৌ, in all four vendored Bangla ' +
                'families. Text that is not a well-formed syllable is still refused by name.'
      },
      cannotYet: {
        logos: 'Uploaded logos are refused: vector import and verified-300dpi CMYK raster placement ' +
               'are not built.',
        latinKerning: 'Latin runs are outlined without kerning, as they always have been. A browser ' +
                      'kerns them, so a Latin line measures a few tenths of a percent narrower on ' +
                      'screen than on the plate; the writer re-measures and reports that drift.'
      }
    });

  if (req.method !== 'POST')
    return fail(405, 'method_not_allowed', 'Post a shortCode or a spec to build a print file.');

  const [body, bad] = await readJson(req);
  if (bad) return bad;

  let spec = body.spec, label = 'card';
  if (!spec) {
    const code = String(body.shortCode || '').trim();
    if (!CODE_RE.test(code)) return ERR.badRequest('Provide a saved design shortCode, or a spec.');
    const [loaded, err] = await specForCode(code);
    if (err) return err;
    spec = loaded;
    label = code;
  } else if (spec.share && CODE_RE.test(String(spec.share.code || ''))) {
    label = spec.share.code;
  }

  const invalid = validateSpec(E, spec);
  if (invalid) return ERR.badRequest(invalid, { field: invalid.split(' ')[0] });

  /* ── The export gate ───────────────────────────────────────────────────
     PRD §9 gives the free tier unlimited briefs, six concepts and a
     watermarked preview, and withholds exactly two things: the print file and
     the print run. The screen already refuses, but a screen is a suggestion —
     this endpoint is where the file actually exists, so this is where the
     refusal has to be true.

     It is gated on the spec hash rather than on the account, because §9's
     model is transaction-led: a file pack buys the design in front of you,
     not a month of access to every design you own. That is also why the
     refusal names a price rather than a plan. */
  {
    const sql = db();
    const { assertEntitled } = await import('../../lib/entitlements.mjs');
    const { actorFrom } = await import('../../lib/entitlements.mjs');
    const actor = await actorFrom(req, sql, body.owner).catch(() => ({}));
    const gate = await assertEntitled(sql, 'export', {
      specHash: E.specHash(spec), shortCode: label !== 'card' ? label : null,
      userId: actor.userId ?? null, ownerKey: actor.ownerKey ?? null
    });

    /* Fail closed, but only where the gate means something.

       A deploy with no database cannot take a payment either — orders and
       quotes both answer 503 there — so there is no paywall on it to bypass.
       Refusing every export on such a deploy protects no revenue and breaks
       the two cases that actually use one: local development and CI. A first
       version of this gate refused unconditionally and turned nine of A1's
       endpoint assertions red, which is the honest signal that "always refuse"
       was the wrong reading rather than a test problem.

       Where a database IS configured, the paywall is real and the refusal is
       real with it — including when the entitlement row cannot be read, since
       an unreadable entitlement is not an entitlement. */
    if (!gate.ok && gate.entitlement?.unreadable !== 'no_database') return gate.refusal;
  }

  const finishes = Array.isArray(body.finishes) ? body.finishes.map(String).slice(0, 8) : [];
  const stock = body.stock === 'uncoated' ? 'uncoated' : 'coated';
  const part = String(body.part || 'composite');

  let out;
  try {
    out = renderPrintPDF(spec, { finishes, stock });
  } catch (err) {
    if (!(err instanceof PrintRefusal)) throw err;
    /* 422, not 400. The request was well formed; the design is not printable.
       That distinction is what lets the screen show a preflight panel instead
       of a "bad request" it cannot act on. */
    return fail(422, err.code, err.message, {
      remediation: REMEDIATION[err.code] || 'Change the design and try again.',
      findings: err.findings
    });
  }

  const available = out.separations.map(s => s.kind);
  const shared = {
    'x-cardworks-engine': out.engineVersion,
    'x-cardworks-separations': available.join(',') || 'none',
    'x-cardworks-trim-mm': out.document.trimMm.join('x'),
    'x-cardworks-tac': `${out.document.tacUsed}/${out.document.tacLimit}`
  };

  if (part !== 'composite') {
    const plate = out.separations.find(s => s.kind === part);
    if (!plate) return ERR.notFound(
      `This design has no ${part} plate.` +
      (available.length ? ` It carries: ${available.join(', ')}.` : ' No special finish was requested.'));
    return new Response(plate.bytes, { status: 200, headers: pdfHeaders(
      `cardworks_${label}_${plate.kind}.pdf`,
      { ...shared, 'x-cardworks-plate-area-pct': String(plate.areaPct),
        'x-cardworks-choke-mm': String(plate.chokeMm) }) });
  }

  /* The funnel's far end. PRD §5.3 measures median brief-to-export, and this
     is the only place that knows an export actually completed rather than
     being asked for — a refusal above never reaches here, which is exactly
     the distinction the median is supposed to draw.

     Emitted only for the composite. A customer downloading three separation
     plates has exported once, and counting each plate would inflate the
     numerator of every rate built on it. */
  try {
    const { record } = await import('../../lib/metrics.mjs');
    const sql = db();
    if (sql) await record(sql, 'export.completed', {
      shortCode: body.shortCode || null,
      briefKey: typeof body.briefKey === 'string' ? body.briefKey : null,
      durationMs: body.briefStartedMs && Number.isFinite(Number(body.briefStartedMs))
        ? Date.now() - Number(body.briefStartedMs) : null,
      meta: { format: spec.format, plates: available.length }
    });
  } catch (e) { console.error('metric emit failed:', e && e.message); }

  return new Response(out.composite, { status: 200, headers: pdfHeaders(
    `cardworks_${label}_print.pdf`,
    { ...shared, 'x-cardworks-width-drift-pct': String(out.drift.worstDeltaPct) }) });
});

export const config = { path: '/api/render-print' };
