/* The preflight gate — the print-correct guarantee, enforced where it cannot
 * be bypassed.
 *
 * Technical Design §10 item 3 is blunt about the hole this closes: today a
 * client that skips the JS engine, or simply edits the request, reaches the
 * `orders` endpoint with nothing server-side having checked that the design
 * passes. PRD §10 makes Print-Correct Rate the north star of the whole
 * product, and a north star that depends on the customer's browser behaving
 * is not a guarantee, it is a hope.
 *
 * The one thing this file must not do is re-implement preflight. A second
 * copy of the checks would drift from the first, and the drift would present
 * as a card that passed on screen and failed at the press — the exact defect
 * the guarantee exists to prevent. So everything here runs the browser's own
 * `preflight` out of `assets/engine.js` through `lib/engine-node.mjs`, and
 * mirrors the two functions in `assets/ui-shell.js` — `facesFor` and
 * `allFindings` — that decide how front and back findings are assembled and
 * how the required-field check is applied. `tests/engine-parity.test.mjs`
 * exists to fail the moment those mirrors stop agreeing.
 *
 * ── The surface other endpoints use ──────────────────────────────────────
 *
 *   const gate = await assertPrintable(sql, { shortCode });
 *   if (!gate.ok) return gate.refusal;
 *
 * That is the whole adoption cost, and it is deliberately two lines so the
 * orders endpoint and the print renderer gate identically. `assertPrintable`
 * accepts either `{ shortCode }` (the saved design, read from the database)
 * or `{ design, content }` (an unsaved one, for the validate screen), returns
 * `{ ok, report, refusal }`, and never throws for a design that merely fails
 * — a failing design is a 422 with the report attached, not an exception.
 *
 * `buildReport` is the pure half: no database, no clock, safe to call from a
 * test. `assertPrintable` is the half that reads acceptances and writes the
 * report row, and it degrades to the pure half when `sql` is null, which is
 * what lets the parity suite run with no database wired up.
 *
 * ── The severity model (Technical Design §6.3) ───────────────────────────
 *
 * Blocking refuses export outright. Advisory is allowed through only with an
 * explicit acceptance recorded against a named actor and a timestamp —
 * `recordAcceptance` writes that row, and it is the product's defence if a
 * customer later disputes a completed run. Informational carries plate and
 * lead-time consequences and never gates anything.
 *
 * The engine's own findings map straight onto that: `fail` is blocking,
 * `review` is advisory, `pass` is a check that passed. Nothing here promotes
 * or demotes a finding the engine produced — the severity is the engine's
 * verdict, not a second opinion layered on top of it.
 */
import { engine, specFrom, engineVersion } from './engine-node.mjs';
import { ERR } from './http.mjs';

/* The three §6.3 tiers, keyed by the engine's own finding state. `pass` is
   its own bucket rather than being folded into informational, because a
   check that ran and passed is evidence and a lead-time note is not. */
export const SEVERITY = { fail: 'blocking', review: 'advisory', pass: 'pass' };

/* A stable slug per check, matched on the label the engine writes. The label
   itself carries live numbers — "Lowest text contrast 3.2:1 (role)" — so it
   cannot be an identifier, but its opening words are fixed by the source and
   make a reliable discriminator. The code is what a UI groups by and what
   the print writer will branch on; identity for an acceptance is handled
   separately by `findingId`, which hashes the whole finding. */
const CODES = [
  [/^Required field/,                'required-field'],
  [/^Layout eliminated/,             'eliminated'],
  [/safe area$|outside the .* mm safe area/, 'safe-area'],
  [/^All elements inside/,           'safe-area'],
  [/^Elements overlap|^No element overlaps/, 'overlap'],
  [/^Type below the print floor|^Smallest type is/, 'type-floor'],
  [/^Hierarchy is clear|^Weak hierarchy/, 'hierarchy'],
  [/^Lowest text contrast/,          'contrast'],
  [/^Total ink coverage/,            'tac'],
  [/^Type system (covers|has no) Bangla/, 'bangla-coverage'],
  [/^QR module/,                     'qr-module'],
  [/^QR contrast/,                   'qr-contrast'],
  [/^QR link is not active/,         'qr-pending'],
  [/^QR carries a short link/,       'qr-payload'],
  [/^vCard reduced/,                 'qr-reduced'],
  [/^Raster logo/,                   'logo-raster'],
  [/^Dropped to fit/,                'dropped'],
  [/^Contact routes reduced/,        'routes-reduced'],
  [/^Bleed extends/,                 'bleed']
];
const codeFor = (label) => {
  for (const [re, code] of CODES) if (re.test(label)) return code;
  return 'other';
};

/* Identity for an acceptance. The label is stable for a given design because
   the design is pinned by its spec hash, so hashing the finding is enough —
   and hashing it means a finding whose wording changes under a new engine
   version stops matching an old acceptance, which is the correct outcome:
   consent was given to the sentence the customer actually read. */
const findingId = (eng, f) =>
  eng.specHash({ face: f.face || '', code: f.code, label: f.label, note: f.note || '' }).slice(0, 12);

/* ── Reconstructing what the browser would have composed ────────────────── */

/** The design object `currentDesign()` in `assets/ui-shell.js` produces from
 *  a restored session. What `designs.mjs` stores is the session snapshot, and
 *  a snapshot deliberately does not carry `state.gen` — so a design loaded
 *  from a short code takes its layout, palette and type from the saved fields
 *  exactly as the browser does after `restore()`. Mirroring the browser's
 *  restore path rather than its generate path is the point: the short code is
 *  what an order references, so the server must see what a reopened link sees.
 */
export function designFrom(spec) {
  const frontScript = (spec.script === 'bangla' || spec.script === 'bangla-only') ? 'bangla' : null;
  const back = spec.script === 'bangla-only' ? 'back.contact'
             : spec.script === 'latin-only' ? (spec.back === 'back.bangla' ? 'back.contact' : spec.back)
             : spec.back;
  const d = {
    layout: spec.layout, palette: spec.palette, type: spec.type,
    density: spec.density, back, format: spec.format, corner: spec.corner || 0,
    script: frontScript ? 'bangla' : 'latin',
    finishes: Array.isArray(spec.finishes) ? spec.finishes.slice() : []
  };
  /* A typed refinement replaces the design wholesale in the browser rather
     than merging into it, so it does here too. */
  return spec.refine || d;
}

/** `composeForced` from `assets/ui-shell.js`, with the same temporary swap of
 *  the layout record. The swap is how a front is forced into Bangla without
 *  the library carrying a second copy of every layout; restoring it in a
 *  `finally` matters here in a way it does not in a browser tab, because a
 *  warm function instance serves many requests off one loaded engine. */
function composeForced(eng, design, layoutId, content, forceScript, over, share) {
  const L = eng.LAYOUTS.find(l => l.id === layoutId);
  if (!L) throw new Error(`unknown layout: ${layoutId}`);
  const i = eng.LAYOUTS.indexOf(L);
  try {
    if (forceScript) eng.LAYOUTS[i] = { ...L, forceScript };
    return eng.compose(Object.assign(specFrom({ ...design, layout: layoutId }, content, share), over));
  } finally {
    eng.LAYOUTS[i] = L;
  }
}

/** `facesFor` from `assets/ui-shell.js`. Both faces, composed the way the
 *  validate screen composes them. */
export function facesFor(eng, design, content, share) {
  const fs = design.script === 'bangla' ? 'bangla' : null;
  const over = { palette: design.palette, type: design.type, density: design.density, format: design.format };
  const front = composeForced(eng, design, design.layout, content, fs, over, share);
  const back = composeForced(eng, design, design.back, content,
    design.back === 'back.bangla' ? 'bangla' : (fs ? 'latin' : null), over, share);
  return { front, back };
}

/** `allFindings` from `assets/ui-shell.js`. The required-field check lives
 *  here rather than in the engine because it is the only check that spans
 *  both faces — a name carried on the back satisfies it just as well. */
export function allFindings(eng, front, back) {
  const pf = [...eng.preflight(front).map(f => ({ ...f, face: 'Front' })),
              ...eng.preflight(back).map(f => ({ ...f, face: 'Back' }))];
  const present = new Set([...(front?.elements || []), ...(back?.elements || [])]
    .filter(e => e.fit).map(e => e.ref));
  for (const ref in eng.SLOTDEFS) {
    if (!eng.SLOTDEFS[ref].required) continue;
    pf.unshift(present.has(ref)
      ? { s: 'pass', face: 'Card', label: `Required field present: ${ref}`, note: '' }
      : { s: 'fail', face: 'Card', label: `Required field missing from both faces: ${ref}`,
          note: 'choose a back that carries it, or a front layout that has the slot' });
  }
  return pf;
}

/* ── The two bands the browser does not compute ─────────────────────────── */

/* Finish clearance. Technical Design §6.1 widens the safe area for processes
   that cannot hold register as tightly as ink: 5 mm under foil, 6 mm under a
   die-cut. The engine composes to the 4 mm ink figure because it does not
   know what was ordered, and it has no per-element finish map either — there
   is nothing in a composed spec that says "the mark is foiled and the rule is
   not". That missing map is why this reports advisory rather than blocking:
   promoting it would refuse export on designs whose foil never goes near the
   elements named, and a gate that blocks correct work stops being trusted.
   When the library grows a per-element finish assignment this becomes the
   blocking check §6.3 asks for, on real data instead of a guess. */
const CLEARANCE = { foil: 5, emboss: 5, rounded: 6 };

function clearanceFindings(front, back, finishes) {
  const out = [];
  for (const fin of finishes) {
    const need = CLEARANCE[fin];
    if (!need) continue;
    for (const [faceName, c] of [['Front', front], ['Back', back]]) {
      if (!c || c.eliminated) continue;
      const fmt = c.fmt;
      const tight = c.elements.filter(e => e.fit || ['mark', 'mono', 'bigmono', 'qr'].includes(e.kind))
        .filter(e => e.geom.x < need - 0.01 || e.geom.y < need - 0.01 ||
                     e.geom.x + e.geom.w > fmt.w - need + 0.01 ||
                     e.geom.y + e.geom.h > fmt.h - need + 0.01);
      out.push(tight.length
        ? { s: 'review', face: faceName, code: 'finish-clearance',
            label: `${tight.length} element(s) inside the ${need} mm ${fin} clearance`,
            note: `${tight.map(e => e.ref).join(', ')} — ${fin} holds register worse than ink, so anything this close to trim can shift visibly` }
        : { s: 'pass', face: faceName, code: 'finish-clearance',
            label: `All elements clear the ${need} mm ${fin} clearance`, note: '' });
    }
  }
  return out;
}

/* Informational, per §6.3: consequences, never gates. Cost belongs to the
   quotes endpoint, so this deliberately says nothing about money — only the
   plates a finish adds and the days they cost, which is what a customer
   choosing finishes at 11pm actually needs to know. */
const PLATE_FINISHES = { spotuv: 'Spot UV', foil: 'Gold foil', emboss: 'Embossing' };

function leadTimeFindings(finishes) {
  const plates = finishes.filter(f => PLATE_FINISHES[f]).map(f => PLATE_FINISHES[f]);
  if (!plates.length) return [];
  return [{
    s: 'info', face: 'Order', code: 'lead-time',
    label: `${plates.join(' and ')} need${plates.length > 1 ? '' : 's'} a separate plate`,
    note: `Add roughly ${plates.length > 1 ? 3 : 2} working days to the run; the proof is made on the same plate, so the delay lands before approval, not after.`
  }];
}

/* ── The report ─────────────────────────────────────────────────────────── */

/** The canonical subject of a preflight run: everything that changes the
 *  verdict, and nothing that does not. Hashing this rather than the stored
 *  session snapshot is what lets an unsaved design and a saved one be keyed
 *  the same way — the snapshot carries screen and step numbers that have no
 *  bearing on whether the card prints. */
export function subjectOf({ design, content, share, finishes }) {
  return {
    design: {
      layout: design.layout, back: design.back, format: design.format,
      type: design.type, palette: design.palette, density: design.density,
      corner: design.corner || 0, script: design.script
    },
    content, finishes: (finishes || []).slice().sort(),
    share: { origin: share?.origin || 'https://cardworks.bd', code: share?.code || null }
  };
}

/** Run the real checks for this design and classify them. Pure — no database,
 *  no clock, no network — so a caller can run it in a test or in the request
 *  path without caring which. */
export function buildReport({ design, content, share = {}, finishes = [] }) {
  const eng = engine();
  const { front, back } = facesFor(eng, design, content, share);

  const raw = [
    ...allFindings(eng, front, back),
    ...clearanceFindings(front, back, finishes),
    ...leadTimeFindings(finishes)
  ];

  const findings = raw.map(f => {
    const code = f.code || codeFor(f.label);
    const withCode = { ...f, code, severity: f.s === 'info' ? 'informational' : SEVERITY[f.s] };
    return { id: findingId(eng, withCode), ...withCode };
  });

  const n = (sev) => findings.filter(f => f.severity === sev).length;
  const blocking = n('blocking'), advisory = n('advisory');

  return {
    /* The status the `preflight_reports` CHECK constraint already allows.
       Note that these counts are derived from the run that just happened —
       PRD Epic D calls a hardcoded "16 of 19" a defect, and the only way to
       be sure it never becomes one is to never have a constant to drift. */
    status: blocking ? 'blocked' : advisory ? 'advisory' : 'pass',
    blocking, advisory, informational: n('informational'), passed: n('pass'),
    findings,
    specHash: eng.specHash(subjectOf({ design, content, share, finishes })),
    engineVersion: engineVersion(),
    eliminated: [front, back].filter(c => c?.eliminated).map(c => c.eliminated)
  };
}

/* ── Persistence ────────────────────────────────────────────────────────── */

/** Load a saved design and turn it back into the design + content the
 *  browser would have composed. Returns null when the code is unknown. */
export async function loadSubject(sql, shortCode) {
  const rows = await sql`
    SELECT short_code, spec_json FROM design_specs WHERE short_code = ${shortCode} LIMIT 1`;
  if (!rows.length) return null;
  const spec = rows[0].spec_json || {};
  return {
    design: designFrom(spec),
    content: spec.content || {},
    finishes: Array.isArray(spec.finishes) ? spec.finishes : [],
    /* The QR encodes the short link, so a saved design's share code is part
       of what preflight checks — without it the engine correctly reports the
       link as not yet resolving, which is a blocking finding. */
    share: { code: rows[0].short_code },
    shortCode: rows[0].short_code
  };
}

/** Write the report. Best-effort: a design that passes must not be refused
 *  because the audit insert failed, so a write error is logged and swallowed
 *  exactly as `remember()` in `lib/http.mjs` does for idempotency. */
export async function persistReport(sql, report, shortCode = null) {
  if (!sql) return;
  try {
    await sql`
      INSERT INTO preflight_reports (spec_hash, short_code, engine_version, status, blocking, advisory, findings)
      VALUES (${report.specHash}, ${shortCode}, ${report.engineVersion}, ${report.status},
              ${report.blocking}, ${report.advisory}, ${JSON.stringify(report.findings)}::jsonb)`;
  } catch (e) { console.error('preflight report write failed:', e && e.message); }
}

/** The acceptances already on file for this exact design under this exact
 *  engine. Both halves of the key matter: consent is to a specific design,
 *  and to the specific wording the customer was shown. */
export async function acceptancesFor(sql, specHash, version) {
  if (!sql) return [];
  const rows = await sql`
    SELECT finding_id, finding_code, finding_label, face, accepted_by, accepted_at, note
    FROM preflight_acceptances
    WHERE spec_hash = ${specHash} AND engine_version = ${version}
    ORDER BY accepted_at`;
  return rows;
}

/** Record that a named person accepted a named advisory finding at a known
 *  time.
 *
 *  This row is the product's defence if a customer disputes a completed run.
 *  It is the difference between "we printed what you approved" as an
 *  assertion and as evidence, which is why the table refuses updates and
 *  deletes (see `db/migrations/005_preflight.sql`) and why the finding's full
 *  label is copied in rather than referenced — the sentence the customer read
 *  has to survive even if the engine later rewords the check.
 */
export async function recordAcceptance(sql, { report, findingId: fid, actor, note = null, orderRef = null }) {
  const f = report.findings.find(x => x.id === fid);
  if (!f) return { ok: false, reason: 'no such finding in this report' };
  if (f.severity !== 'advisory')
    return { ok: false, reason: `only advisory findings can be accepted; this one is ${f.severity}` };
  if (!sql) return { ok: false, reason: 'no database configured for this deploy' };

  await sql`
    INSERT INTO preflight_acceptances
      (spec_hash, engine_version, finding_id, finding_code, finding_label, face, accepted_by, note, order_ref)
    VALUES (${report.specHash}, ${report.engineVersion}, ${f.id}, ${f.code}, ${f.label},
            ${f.face || null}, ${actor}, ${note}, ${orderRef})
    ON CONFLICT (spec_hash, engine_version, finding_id, accepted_by) DO NOTHING`;
  return { ok: true, finding: f };
}

/* ── The gate ───────────────────────────────────────────────────────────── */

/** Gate a design on its preflight report.
 *
 *  Pass either `{ shortCode }` or `{ design, content }`. Returns
 *  `{ ok, report, refusal }` — `refusal` is a ready-to-return `Response` in
 *  the standard error envelope, so a caller gates in one line:
 *
 *    const gate = await assertPrintable(sql, { shortCode: code });
 *    if (!gate.ok) return gate.refusal;
 *
 *  Blocking findings refuse outright. Advisory findings refuse too, unless
 *  each one has an acceptance on file — that is what §6.3 means by "requires
 *  explicit acceptance", and letting them through silently would turn the
 *  acceptance record into decoration. A caller that only wants the blocking
 *  tier (the validate screen previewing what would happen, say) passes
 *  `requireAdvisoryAcceptance: false`.
 */
export async function assertPrintable(sql, opts = {}) {
  const { shortCode, requireAdvisoryAcceptance = true, persist = true } = opts;
  let subject;

  if (shortCode) {
    if (!sql) return { ok: false, report: null, refusal: ERR.unavailable() };
    subject = await loadSubject(sql, shortCode);
    if (!subject) return {
      ok: false, report: null,
      refusal: ERR.notFound('That design is not saved.', {
        remediation: 'Save the design before ordering — the QR on the card resolves to the saved link.'
      })
    };
  } else {
    if (!opts.design || !opts.content) return {
      ok: false, report: null,
      refusal: ERR.badRequest('Send either a shortCode or a design and its content.', { field: 'design' })
    };
    subject = {
      design: opts.design, content: opts.content,
      finishes: opts.finishes || opts.design.finishes || [],
      share: opts.share || {}, shortCode: opts.share?.code || null
    };
  }

  let report;
  try {
    report = buildReport(subject);
  } catch (err) {
    /* A design naming a layout, palette or format the library does not have
       is a malformed request, not a server fault — the engine throws before
       it can compose anything. */
    return {
      ok: false, report: null,
      refusal: ERR.unprocessable('That design does not match the current component library.', {
        field: 'design', remediation: 'Regenerate the design; a component it names no longer exists.',
        detail: String(err && err.message)
      })
    };
  }

  if (persist) await persistReport(sql, report, subject.shortCode || null);

  const accepted = await acceptancesFor(sql, report.specHash, report.engineVersion);
  const acceptedIds = new Set(accepted.map(a => a.finding_id));
  const unaccepted = report.findings.filter(f => f.severity === 'advisory' && !acceptedIds.has(f.id));
  report.acceptances = accepted;
  report.unaccepted = unaccepted.map(f => f.id);

  if (report.blocking) return {
    ok: false, report,
    refusal: ERR.unprocessable(
      `Preflight found ${report.blocking} blocking issue${report.blocking > 1 ? 's' : ''}. This design cannot be printed as it stands.`,
      { remediation: 'Fix the blocking findings on the validate screen — a blocking finding cannot be overridden.', report })
  };

  if (requireAdvisoryAcceptance && unaccepted.length) return {
    ok: false, report,
    refusal: ERR.unprocessable(
      `${unaccepted.length} advisory finding${unaccepted.length > 1 ? 's have' : ' has'} not been accepted.`,
      { remediation: 'Accept each advisory finding, on the record, before the files are locked.', report })
  };

  return { ok: true, report, refusal: null };
}
