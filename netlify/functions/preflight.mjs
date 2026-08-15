/* Preflight, run on the server.
 *
 * Until now preflight existed only in the browser, which meant the print
 * guarantee held exactly as long as nobody edited a request. Technical Design
 * §10 item 3 rates the likelihood of that abuse low at current scale and the
 * consequence high, and it is right on both counts: one order that reaches a
 * press with overlapping glyphs costs more in reprints and reputation than
 * this endpoint costs to write.
 *
 * The checks themselves are not here. They are in `assets/engine.js`, the same
 * file the browser loads, reached through `lib/preflight-gate.mjs` — see that
 * file's header for why a second implementation was never an option.
 *
 * Two things happen at this path. A POST with a design returns the report for
 * it, derived from the run that just happened rather than from any stored
 * count. A POST with `action: "accept"` records that a named person accepted a
 * named advisory finding, which is what Technical Design §6.3 requires before
 * an advisory design may be printed at all.
 */
import { handler, ok, ERR, readJson, db, CODE_RE, idempotencyKey, replay, remember } from '../../lib/http.mjs';
import { assertPrintable, recordAcceptance } from '../../lib/preflight-gate.mjs';

/* What goes back to the client. The report object carries a few fields the
   gate uses internally; this is the shape the validate screen and the order
   screen actually read. */
const wire = (report) => ({
  status: report.status,
  printable: report.status !== 'blocked' && !report.unaccepted?.length,
  blocking: report.blocking,
  advisory: report.advisory,
  informational: report.informational,
  passed: report.passed,
  findings: report.findings,
  unaccepted: report.unaccepted || [],
  acceptances: report.acceptances || [],
  eliminated: report.eliminated,
  specHash: report.specHash,
  engineVersion: report.engineVersion
});

/* Resolve the request body into the subject the gate takes. A short code is
   the design as saved; a design and its content is the one on screen that has
   not been saved yet, which the validate screen needs so it can show the same
   verdict before there is anything to reference. */
function subjectFrom(b) {
  const code = String(b.shortCode || '').trim();
  if (code) {
    if (!CODE_RE.test(code)) return [null, ERR.badRequest('That is not a valid design code.', { field: 'shortCode' })];
    return [{ shortCode: code }, null];
  }
  if (!b.design || typeof b.design !== 'object')
    return [null, ERR.badRequest('Send either a shortCode or a design and its content.', { field: 'design' })];
  if (!b.content || typeof b.content !== 'object')
    return [null, ERR.badRequest('A design without its content cannot be checked.', { field: 'content' })];
  return [{
    design: b.design,
    content: b.content,
    finishes: Array.isArray(b.finishes) ? b.finishes : (Array.isArray(b.design.finishes) ? b.design.finishes : []),
    share: b.share && typeof b.share === 'object' ? b.share : {}
  }, null];
}

export default handler('preflight', async (req) => {
  if (req.method !== 'POST') return ERR.badRequest('Send a POST with a design to check.');

  const [b, bad] = await readJson(req);
  if (bad) return bad;

  const sql = db();
  const [subject, invalid] = subjectFrom(b);
  if (invalid) return invalid;

  /* The report is computed the same way for both actions. Advisory acceptance
     is not required to *see* a report — only to print — so the gate is asked
     for the findings without that condition and the caller is told separately,
     via `printable`, whether the order endpoint would let this through.

     Only a saved design's report is kept. The validate screen re-checks on
     every edit, and a row per keystroke would bury the reports that matter —
     the ones a saved design was ordered against — under noise. */
  const gate = await assertPrintable(sql, {
    ...subject, requireAdvisoryAcceptance: false, persist: !!subject.shortCode });
  if (!gate.report) return gate.refusal;

  if (String(b.action || '') !== 'accept') return ok(wire(gate.report));

  /* ── recording an acceptance ──
     A report can be produced with no database at all, but an acceptance
     cannot: the whole point of it is that it was written down. Refusing here
     rather than further in keeps that an infrastructure answer (503) instead
     of looking like the finding was rejected.

     This is a mutating call, so it carries an idempotency key like every
     other one (Technical Design §8). Replaying a key returns the first
     response rather than writing a second row into the evidence. */
  if (!sql) return ERR.unavailable();
  const key = idempotencyKey(req);
  const scope = 'preflight.accept';
  const replayed = await replay(sql, key, scope);
  if (replayed) return replayed;

  const actor = String(b.acceptedBy || '').trim().slice(0, 120);
  if (!actor) return ERR.badRequest(
    'An acceptance has to name who accepted it.',
    { field: 'acceptedBy', remediation: 'Send the phone number or name of the person accepting this finding.' });

  const fid = String(b.findingId || '').trim();
  const res = await recordAcceptance(sql, {
    report: gate.report, findingId: fid, actor,
    note: b.note ? String(b.note).slice(0, 400) : null,
    orderRef: null
  });
  if (!res.ok) return ERR.unprocessable(res.reason, {
    field: 'findingId',
    remediation: 'Re-run preflight and accept a finding from the report it returns — a blocking finding can never be accepted.'
  });

  /* Re-read so the response carries the acceptance that was just written,
     rather than the caller having to poll for it. */
  const after = await assertPrintable(sql, { ...subject, requireAdvisoryAcceptance: false, persist: false });
  const body = { accepted: res.finding, ...wire(after.report || gate.report) };
  await remember(sql, key, scope, 201, body);
  return ok(body, 201);
});

export const config = { path: '/api/preflight' };
