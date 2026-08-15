/* The read path for §5.3 and §10, and the one place a print-correct verdict
 * gets entered.
 *
 * Two very different things share this endpoint on purpose. The funnel events
 * are cheap, anonymous and open, because the client's brief and generate path
 * is where two of them happen and there is nothing worth guarding in "somebody
 * started a brief". The verdict on a delivered order is the opposite: it is
 * the north star §10 subordinates every other requirement to, it is typed by a
 * person rather than observed, and it is the number the decision to build V2
 * rests on. Anyone who can write it can move that decision, so it takes the
 * same staff token settlement and refunds take, and a deploy that has not set
 * one refuses outright rather than leaving the company's headline metric open
 * to whoever finds the path.
 *
 * The report is staff-only for a duller reason: conversion rates and order
 * counts are the business's numbers, not a customer's.
 */
import { handler, ok, ERR, readJson, db, REF_RE } from '../../lib/http.mjs';
import {
  record, recordOutcome, metricsFor, EVENTS, CAUSES, EVIDENCE, VERDICTS
} from '../../lib/metrics.mjs';

/* The same shared token components and refunds use, and the same reasoning:
   real staff accounts arrive with A5's work, and until then a token that a
   deploy must deliberately set is the honest placeholder. */
const staffAuthorised = (req) => {
  const expected = (process.env.CARDWORKS_STAFF_TOKEN || '').trim();
  if (!expected) return false;
  const got = (req.headers.get('x-cardworks-staff') || '').trim();
  return got.length === expected.length && got === expected;
};

/* The handler with the database passed in rather than reached for, the same
   split `components.mjs` uses. The point is not tidiness: `db()` returns a
   Neon client from `DATABASE_URL`, so a test that cannot supply its own would
   be reduced to comparing one 503 with another, and the two things worth
   asserting here — that a verdict is refused without a staff token, and that
   the report says "not enough data" rather than 100% — both need a real
   database behind them. */
export async function metricsRequest(req, sql) {
  if (!sql) return ERR.unavailable();

  if (req.method === 'GET') {
    if (!staffAuthorised(req))
      /* Prose rather than a remediation token, per the rule in lib/http.mjs:
         a token exists so a screen can branch on it, and no customer screen
         will ever see this one. */
      return ERR.forbidden('These are the business\'s numbers.', {
        remediation: 'The report is read with a staff token.' });
    const url = new URL(req.url);
    return ok(await metricsFor(sql, { days: url.searchParams.get('days') }));
  }

  if (req.method !== 'POST') return ERR.badRequest('Method not allowed.');

  const [b, bad] = await readJson(req, 8 * 1024);
  if (bad) return bad;

  /* ── a verdict on a delivered order ── */
  if (b.outcome) {
    if (!staffAuthorised(req))
      return ERR.forbidden('A print verdict is recorded by staff.', {
        remediation: 'This is entered by whoever confirmed the delivery or handled the complaint.' });

    const o = b.outcome;
    if (!REF_RE.test(String(o.orderRef || '').toUpperCase()))
      return ERR.badRequest('That is not an order reference.', { field: 'orderRef' });

    const exists = await sql`SELECT status FROM orders WHERE ref = ${String(o.orderRef).toUpperCase()} LIMIT 1`;
    if (!exists.length) return ERR.notFound('No order with that reference.');

    /* A verdict on an order that has not been delivered is not refused, only
       flagged back. A shop that spots a defect on the sheet before handover
       has found exactly the thing this metric exists to catch, and refusing it
       because a status column has not caught up would lose the observation
       that matters most. */
    const [row, problem] = await recordOutcome(sql, o);
    if (problem) return ERR.badRequest(problem.message, {
      field: problem.field, remediation: 'Correct the field and record it again.' });
    return ok({ outcome: row, orderStatus: exists[0].status,
                undelivered: exists[0].status !== 'delivered' }, 201);
  }

  /* ── a funnel event ── */
  const name = String(b.event || '');
  if (!EVENTS.includes(name))
    return ERR.badRequest('Unknown event.', { field: 'event',
      remediation: 'One of: ' + EVENTS.join(', ') + '.' });

  const written = await record(sql, name, b);
  return ok({ recorded: written }, written ? 201 : 202);
}

export default handler('metrics', (req) => metricsRequest(req, db()));

/* The vocabularies, exported so the entry screen and the tests read them from
   here rather than keeping a second copy that drifts. */
export const VOCABULARY = { EVENTS, VERDICTS, CAUSES, EVIDENCE };

export const config = { path: '/api/metrics' };
