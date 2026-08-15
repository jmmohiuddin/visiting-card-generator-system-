/* Quotes — the server's price, not the browser's.
 *
 * Technical Design §8 specifies `POST /v1/quotes { specId, qty } → { options[] }`,
 * and §10 item 4 says why the options have to come from records: with `press`
 * as a free-text string, finish availability and lead times were whatever the
 * order screen's author typed, and the total arrived from the client. Here
 * each option is a real press row, priced against its own rule, and the
 * quote id it returns is what the order endpoint pins so the price the
 * customer saw is the price they are charged.
 *
 * The arithmetic lives in `lib/quote-server.mjs`, which layers press
 * capability over the one cost model in `assets/engine.js`. This file is only
 * the envelope: read the request, prove the design exists, answer.
 */
import { handler, ok, fail, ERR, readJson, db, CODE_RE, idempotencyKey } from '../../lib/http.mjs';
import { loadPresses, buildQuote } from '../../lib/quote-server.mjs';

/** Confirm the design being quoted is one we hold, and return its identity.
 *
 *  A quote is against a specific saved design, not against a quantity in the
 *  abstract, because the press and the customer have to be looking at the
 *  same file — the same reason `orders.mjs` refuses an order for an unsaved
 *  design. */
async function resolveSpec(sql, body) {
  const code = String(body.shortCode || '').trim();
  const id = body.specId == null ? null : Number(body.specId);

  if (code) {
    if (!CODE_RE.test(code))
      return [null, ERR.badRequest('That short code is not one of ours.', { field: 'shortCode' })];
    const rows = await sql`SELECT id, short_code FROM design_specs WHERE short_code = ${code} LIMIT 1`;
    if (!rows.length)
      return [null, ERR.notFound('That design is not saved.',
        { field: 'shortCode', remediation: 'Save the design, then ask for a quote.' })];
    return [{ specId: Number(rows[0].id), shortCode: rows[0].short_code }, null];
  }

  if (Number.isInteger(id) && id > 0) {
    const rows = await sql`SELECT id, short_code FROM design_specs WHERE id = ${id} LIMIT 1`;
    if (!rows.length)
      return [null, ERR.notFound('That design is not saved.', { field: 'specId' })];
    return [{ specId: Number(rows[0].id), shortCode: rows[0].short_code }, null];
  }

  return [null, ERR.badRequest('Send the design as `specId` or `shortCode`.',
    { field: 'specId', remediation: 'Save the design first — a quote is always against a saved file.' })];
}

/** The handler proper, with its database client passed in so it can be
 *  driven directly by `tests/quotes.test.mjs` without a live Postgres. */
export async function quoteRequest(req, sql) {
  if (req.method !== 'POST')
    return fail(405, 'method_not_allowed', 'Quotes are computed on POST.',
      { remediation: 'POST { specId | shortCode, qty, finishes[], zone }.' });
  if (!sql) return ERR.unavailable();

  const [body, bad] = await readJson(req, 16 * 1024);
  if (bad) return bad;

  const [spec, specErr] = await resolveSpec(sql, body);
  if (specErr) return specErr;

  const { presses, source } = await loadPresses(sql);
  const q = buildQuote({
    presses, qty: body.qty, zone: body.zone === 'outside' ? 'outside' : 'dhaka',
    finishes: Array.isArray(body.finishes) ? body.finishes : [], pressSource: source
  });

  /* A finish nobody can produce is a 422, not a price. The engine would
     happily cost it; refusing with a reason is the honest answer, and
     `remediation` is what the order screen renders next. */
  if (q.error) {
    const { code, message, ...detail } = q.error;
    return code === 'bad_request'
      ? ERR.badRequest(message, detail)
      : ERR.unprocessable(message, { ...detail, code });
  }

  /* A quote changes nothing, so there is nothing to replay: the id is a
     digest of the quote's own inputs and outputs, which makes an identical
     request idempotent by construction rather than by bookkeeping. The
     caller's key is echoed so a retry can still be correlated in logs. */
  const key = idempotencyKey(req);
  return ok({ ...spec, ...q }, 200, key ? { 'idempotency-key': key } : {});
}

export default handler('quotes', (req) => quoteRequest(req, db()));

export const config = { path: '/api/quotes' };
