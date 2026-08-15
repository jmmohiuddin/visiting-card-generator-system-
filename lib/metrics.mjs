/* The numbers the Master PRD decides on, and an honest account of which of
 * them the system can actually see.
 *
 * §10 names one north star — Print-Correct Rate, orders delivered with zero
 * preflight-attributable defects — and says every requirement in the document
 * is subordinate to it. §5.3 turns the MVP exit decision into six numbers.
 * Before this module none of the seven could be computed, which meant the
 * decision §5.3 exists to inform had no data behind it at all.
 *
 * ── The line this module will not cross ──────────────────────────────────
 *
 * Four of the seven are measurable from instrumentation. Three are not, and
 * the temptation with those is to substitute something adjacent that happens
 * to be measurable and let it wear the same name. That is the failure this
 * module is written against, because a north star that quietly measures a
 * different thing is worse than one that is honestly empty: an empty number
 * makes someone go and get it, a wrong one makes them stop looking.
 *
 * So the print-correct rate is not derived from anything. It is entered by a
 * human against an order, because a print defect is discovered by a human
 * holding paper, and there is no instrumentation anywhere in this codebase
 * that sees the inside of a courier's box. `recordOutcome` is that entry
 * point, and the rate is worth exactly what the discipline of using it is
 * worth. Engine cost per brief is an invoice divided by a count; we hold the
 * count and not the invoice, so this module reports the denominator and
 * refuses the division. Pilot-shop retention is a fact about five shops that
 * have no representation in the schema at all, because Epic I is out of MVP
 * scope, so it is reported as structurally uncomputable rather than
 * approximated by something about orders.
 *
 * ── Small samples ────────────────────────────────────────────────────────
 *
 * Every rate carries the sample it came from and refuses to report below a
 * stated minimum. At four delivered orders the print-correct rate is not
 * 100%, it is unknown, and a dashboard that renders 100% there will be
 * believed. Where a rate is reportable it also carries a Wilson lower bound,
 * because the target is 99.5% and the distance between "we measured 100% of
 * 40" and "we are above 99.5%" is most of the point.
 */
import { REF_RE } from './http.mjs';

/* The closed event vocabulary. It is short because it was derived backwards
   from the numbers rather than designed as a taxonomy: each name exists
   because a §5.3 or §10 figure cannot be computed without it, and nothing
   here is recorded on the chance it proves interesting later.

   `brief.started` and `concept.viewed` are the ≥40% funnel and the clock
   start. `export.completed` is the clock stop for the median brief-to-export.
   `order.placed` attributes an order back to the brief that produced it,
   which is §10's concept→order conversion.

   Orders themselves are not events here. The `orders` table is the source of
   truth for how many orders exist and what became of them, and copying that
   into an event log would create a second answer to a question that already
   has one. */
export const EVENTS = ['brief.started', 'concept.viewed', 'export.completed', 'order.placed'];

/* What `meta` may carry, mirroring the database CHECK in migration 009. These
   events are about a funnel, not a person: there is no key here that a name, a
   phone number, an address or a line of card copy could be written under, and
   that — rather than any inspection of the values — is what keeps card content
   out of the metrics tables. */
export const META_KEYS = ['locale', 'vertical', 'format', 'count', 'engineVersion',
                          'variant', 'blocked', 'advisory', 'qty'];
const META_STRING_RE = /^[A-Za-z0-9._:-]{1,40}$/;

/* A brief key correlates the steps of one brief. It is minted fresh per brief
   attempt by whoever starts the brief and is random, so it joins a start to a
   concept view to an export and says nothing about who did any of it. It must
   not be the owner key: that would make the funnel person-stable, which is a
   tracking identifier the funnel has no use for. */
export const BRIEF_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const VERDICTS = ['correct', 'defective'];
export const CAUSES = ['preflight', 'press', 'courier', 'customer_content', 'undetermined'];
export const EVIDENCE = ['customer_report', 'shop_inspection', 'our_inspection'];

/* §10 says *preflight-attributable* defects, and the qualifier is the metric.
   A card crushed in a van printed correctly; a card whose Bangla conjunct
   broke because our checks passed a file that could not hold it did not. Only
   the second kind moves this number, which is what makes it a judgement of
   our product rather than of a courier.

   `undetermined` counts against us. It is not preflight-attributable — nobody
   established that it was — but an unexplained defect that improves the north
   star is precisely the corruption this whole module is written to avoid, and
   the reported figures carry the undetermined count separately so the size of
   that assumption is always visible. */
export const AGAINST_NORTH_STAR = ['preflight', 'undetermined'];

/* How much evidence each rate needs before it is worth reading.

   The print-correct threshold is 30 because §5.3 sets the gate at 100 paid
   orders and the number is meant to be read there; 30 is the point at which a
   single defect moves it by three points rather than by twenty-five, which is
   the earliest it stops being anecdote. The funnel needs 50 briefs for the
   same reason at looser tolerance — it is a 40% target, not a 99.5% one, so it
   survives more noise. The two latency figures need 20 because a p95 drawn
   from fewer than 20 samples is the maximum wearing a percentile's name.

   Concept→order gets its own floor rather than borrowing the funnel's,
   because its denominator is a different and smaller population — the briefs
   that reached a concept, not the briefs that started — and a threshold that
   silently guards the wrong denominator is a threshold nobody can reason
   about.

   Coverage is separate and stricter in spirit: an adjudicated sample is only
   representative if most delivered orders were adjudicated, since the ones
   nobody chased are exactly where a complaint would be hiding. */
export const MIN_SAMPLE = { printCorrect: 30, conceptReach: 50, conceptToOrder: 30,
                            briefToExport: 20, conceptLatency: 20 };
export const MIN_COVERAGE = 0.8;

/* ── Writing ─────────────────────────────────────────────────────────────── */

/** Keep only the allowed keys, and only scalars. Drops rather than refuses,
 *  because a metrics write rides on a customer's request and must never be
 *  the reason it fails; the allowlist failing closed is the safe direction. */
export function sanitiseMeta(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && META_STRING_RE.test(v)) out[k] = v;
  }
  return out;
}

/** Record one funnel event. Best-effort by design: losing a measurement is a
 *  worse dashboard, losing the request it was attached to is a worse product.
 *  Returns whether the row was written, so a caller that cares can tell. */
export async function record(sql, name, fields = {}) {
  if (!sql || !EVENTS.includes(name)) return false;
  const briefKey = BRIEF_KEY_RE.test(String(fields.briefKey || '')) ? String(fields.briefKey) : null;
  const shortCode = fields.shortCode ? String(fields.shortCode).slice(0, 32) : null;
  const orderRef = fields.orderRef && REF_RE.test(String(fields.orderRef).toUpperCase())
    ? String(fields.orderRef).toUpperCase() : null;
  const ms = Number.isFinite(Number(fields.durationMs)) && Number(fields.durationMs) >= 0
    ? Math.round(Number(fields.durationMs)) : null;
  try {
    await sql`
      INSERT INTO metric_events (name, brief_key, short_code, order_ref, duration_ms, meta)
      VALUES (${name}, ${briefKey}, ${shortCode}, ${orderRef}, ${ms},
              ${JSON.stringify(sanitiseMeta(fields.meta))}::jsonb)`;
    return true;
  } catch (e) {
    console.error('metric write failed:', e && e.message);
    return false;
  }
}

/** Record what became of a delivered order. Returns `[row, problem]`, the
 *  same shape `readJson` uses, because every field here is judgement typed by
 *  a person and a silently-dropped one would corrupt the north star.
 *
 *  Unlike `record`, this one validates and refuses. A funnel event that goes
 *  missing costs a percentage point of precision; a verdict that goes missing
 *  is the number itself. */
export async function recordOutcome(sql, o = {}) {
  if (!sql) return [null, { field: null, message: 'No database is configured for this deploy.' }];

  const ref = String(o.orderRef || '').toUpperCase();
  if (!REF_RE.test(ref)) return [null, { field: 'orderRef', message: 'That is not an order reference.' }];

  const verdict = String(o.verdict || '');
  if (!VERDICTS.includes(verdict))
    return [null, { field: 'verdict', message: 'The verdict is either correct or defective.' }];

  const cause = o.cause == null || o.cause === '' ? null : String(o.cause);
  if (verdict === 'defective' && !CAUSES.includes(cause))
    return [null, { field: 'cause', message: 'A defect needs a cause: ' + CAUSES.join(', ') + '.' }];
  if (verdict === 'correct' && cause !== null)
    return [null, { field: 'cause', message: 'A card that was correct has no defect cause.' }];

  const code = o.defectCode == null || o.defectCode === '' ? null : String(o.defectCode);
  if (code !== null && !/^[a-z][a-z0-9_]{2,40}$/.test(code))
    return [null, { field: 'defectCode', message: 'A defect code is a lowercase token, like text_outside_safe_area.' }];

  const evidence = String(o.evidence || '');
  if (!EVIDENCE.includes(evidence))
    return [null, { field: 'evidence', message: 'Say how this was established: ' + EVIDENCE.join(', ') + '.' }];

  const by = String(o.recordedBy || '').trim().slice(0, 80);
  if (!by) return [null, { field: 'recordedBy', message: 'Say who established this.' }];

  const note = o.note ? String(o.note).slice(0, 400) : null;
  const sourceKey = o.sourceKey ? String(o.sourceKey).slice(0, 128) : null;

  /* A retried request is the same verdict, not a second one. A corrected
     verdict is a different thing entirely and is meant to be a new row — the
     table is append-only and the read path takes the newest per order — so
     the dedupe is on the caller's key alone. */
  const ins = await sql`
    INSERT INTO order_outcomes (order_ref, verdict, cause, defect_code, evidence,
                                recorded_by, source_key, note)
    VALUES (${ref}, ${verdict}, ${cause}, ${code}, ${evidence}, ${by}, ${sourceKey}, ${note})
    ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
    RETURNING id, order_ref, verdict, cause, defect_code, evidence, recorded_by, created_at`;
  if (ins.length) return [ins[0], null];

  const existing = await sql`
    SELECT id, order_ref, verdict, cause, defect_code, evidence, recorded_by, created_at
    FROM order_outcomes WHERE source_key = ${sourceKey} LIMIT 1`;
  return existing.length ? [existing[0], null]
    : [null, { field: 'orderRef', message: 'No order with that reference.' }];
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/* The window defaults to all time. §5.3 is a cumulative gate — a hundred paid
   orders, ever, not a hundred in the last quarter — so windowing it by
   default would answer a question nobody asked. `days` narrows it when
   somebody wants a trend instead of a gate.

   The window is applied to the events, which means a brief that started
   before the window is not counted at all rather than counted as a brief that
   never reached a concept. Undercounting the numerator and the denominator
   together is the harmless direction; only one of them is not. */
export const sinceFor = (days) =>
  days && Number.isFinite(Number(days)) && Number(days) > 0
    ? new Date(Date.now() - Math.min(3650, Number(days)) * 86400000)
    : new Date(0);

/** Everything the report needs, as a dozen scalars.
 *
 *  Every query here aggregates in Postgres and returns one row. A dashboard
 *  that pulls the event log across the wire to count it in JavaScript is the
 *  thing §10's cost line rules out — the metrics path must not become the
 *  expensive part of a product whose engine costs 2.8 ms a brief. */
export async function gather(sql, opts = {}) {
  const since = sinceFor(opts.days);

  const funnel = await sql`
    SELECT count(*)::int AS started,
           count(*) FILTER (WHERE reached_concept)::int AS reached_concept,
           count(*) FILTER (WHERE reached_order)::int   AS reached_order
    FROM (
      SELECT brief_key,
             bool_or(name = 'concept.viewed') AS reached_concept,
             bool_or(name = 'order.placed')   AS reached_order
      FROM metric_events
      WHERE brief_key IS NOT NULL AND created_at >= ${since}
      GROUP BY brief_key
      HAVING bool_or(name = 'brief.started')
    ) b`;

  const timing = await sql`
    SELECT count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS median_ms
    FROM (
      SELECT extract(epoch FROM (max(created_at) FILTER (WHERE name = 'export.completed')
                                 - min(created_at) FILTER (WHERE name = 'brief.started'))) * 1000 AS ms
      FROM metric_events
      WHERE brief_key IS NOT NULL AND created_at >= ${since}
      GROUP BY brief_key
      HAVING bool_or(name = 'brief.started') AND bool_or(name = 'export.completed')
    ) t
    WHERE ms >= 0`;

  const latency = await sql`
    SELECT count(*)::int AS n,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
    FROM metric_events
    WHERE name = 'concept.viewed' AND duration_ms IS NOT NULL AND created_at >= ${since}`;

  /* Paid and delivered, which is what §5.3 means by end to end. A captured
     payment that was later part-refunded still happened, so it counts; an
     intent that never captured did not. */
  const orders = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE o.status = 'delivered' AND EXISTS (
             SELECT 1 FROM payments p WHERE p.order_ref = o.ref
               AND p.status IN ('captured','partially_refunded')))::int AS paid_delivered
    FROM orders o WHERE o.created_at >= ${since}`;

  /* The newest verdict per order, scoped by the order's own date so that the
     numerator and the denominator describe the same set of orders. */
  const outcomes = await sql`
    SELECT count(*)::int AS adjudicated,
           count(*) FILTER (WHERE verdict = 'correct')::int          AS correct,
           count(*) FILTER (WHERE cause = 'preflight')::int          AS preflight,
           count(*) FILTER (WHERE cause = 'undetermined')::int       AS undetermined,
           count(*) FILTER (WHERE cause IS NOT NULL
                              AND cause NOT IN ('preflight','undetermined'))::int AS other_cause
    FROM (
      SELECT DISTINCT ON (x.order_ref) x.order_ref, x.verdict, x.cause
      FROM order_outcomes x JOIN orders r ON r.ref = x.order_ref
      WHERE r.created_at >= ${since}
      ORDER BY x.order_ref, x.created_at DESC, x.id DESC
    ) o`;

  /* §10's 12-month reorder rate. The cohort is customers whose first order is
     at least a year old, because nobody else has had the chance. */
  const reorder = await sql`
    SELECT count(*)::int AS cohort,
           count(*) FILTER (WHERE orders_since > 1)::int AS reordered
    FROM (
      SELECT coalesce(user_id::text, owner_key) AS who,
             min(created_at) AS first_at, count(*) AS orders_since
      FROM orders
      WHERE coalesce(user_id::text, owner_key) IS NOT NULL
      GROUP BY 1
    ) c
    WHERE first_at <= now() - interval '12 months'`;

  return {
    since: since.toISOString(),
    days: opts.days && Number(opts.days) > 0 ? Math.min(3650, Number(opts.days)) : null,
    briefs: { started: funnel[0].started, reachedConcept: funnel[0].reached_concept,
              reachedOrder: funnel[0].reached_order },
    briefToExport: { n: timing[0].n, medianMs: timing[0].median_ms == null ? null : Number(timing[0].median_ms) },
    conceptLatency: { n: latency[0].n, p95Ms: latency[0].p95_ms == null ? null : Number(latency[0].p95_ms) },
    orders: { total: orders[0].total, delivered: orders[0].delivered, paidDelivered: orders[0].paid_delivered },
    outcomes: { adjudicated: outcomes[0].adjudicated, correct: outcomes[0].correct,
                preflight: outcomes[0].preflight, undetermined: outcomes[0].undetermined,
                otherCause: outcomes[0].other_cause },
    reorder: { cohort: reorder[0].cohort, reordered: reorder[0].reordered }
  };
}

/* The same shape, folded out of plain arrays instead of out of Postgres.
 *
 * This exists so the criteria can be asserted on a machine with no database,
 * and — more usefully — so the SQL above has something to be checked against.
 * WORKPLAN.md's rule is that a guarantee is asserted from the far side of the
 * seam it protects: `tests/metrics.test.mjs` seeds one fixture, runs it
 * through both, and requires them to agree, so a `HAVING` clause that quietly
 * changes what counts as a started brief fails the build instead of moving
 * the number the company makes a decision on. */
export function foldEvents(fixture = {}) {
  const events = fixture.events || [];
  const orders = fixture.orders || [];
  const outcomes = fixture.outcomes || [];
  const since = sinceFor(fixture.days);
  const at = (e) => new Date(e.at || 0);
  const inWindow = (t) => t >= since;

  const briefs = new Map();
  for (const e of events) {
    if (!e.briefKey || !inWindow(at(e))) continue;
    if (!briefs.has(e.briefKey)) briefs.set(e.briefKey, []);
    briefs.get(e.briefKey).push(e);
  }

  let started = 0, reachedConcept = 0, reachedOrder = 0;
  const spans = [];
  for (const list of briefs.values()) {
    const firstStart = list.filter(e => e.name === 'brief.started').map(at).sort((a, b) => a - b)[0];
    if (!firstStart) continue;
    started++;
    if (list.some(e => e.name === 'concept.viewed')) reachedConcept++;
    if (list.some(e => e.name === 'order.placed')) reachedOrder++;
    const lastExport = list.filter(e => e.name === 'export.completed').map(at).sort((a, b) => b - a)[0];
    if (lastExport) {
      const ms = lastExport - firstStart;
      if (ms >= 0) spans.push(ms);
    }
  }

  const latencies = events
    .filter(e => e.name === 'concept.viewed' && e.durationMs != null && inWindow(at(e)))
    .map(e => Number(e.durationMs));

  const windowed = orders.filter(o => inWindow(new Date(o.at || 0)));
  const delivered = windowed.filter(o => o.status === 'delivered');

  /* Newest verdict per order, over orders inside the window — the same
     definition the DISTINCT ON above implements. */
  const latest = new Map();
  const refs = new Set(windowed.map(o => o.ref));
  for (const o of outcomes) {
    if (!refs.has(o.orderRef)) continue;
    const prev = latest.get(o.orderRef);
    if (!prev || new Date(o.at || 0) >= new Date(prev.at || 0)) latest.set(o.orderRef, o);
  }
  const verdicts = [...latest.values()];

  return {
    since: since.toISOString(),
    days: fixture.days && Number(fixture.days) > 0 ? Math.min(3650, Number(fixture.days)) : null,
    briefs: { started, reachedConcept, reachedOrder },
    briefToExport: { n: spans.length, medianMs: percentile(spans, 0.5) },
    conceptLatency: { n: latencies.length, p95Ms: percentile(latencies, 0.95) },
    orders: {
      total: windowed.length,
      delivered: delivered.length,
      paidDelivered: delivered.filter(o => o.paid).length
    },
    outcomes: {
      adjudicated: verdicts.length,
      correct: verdicts.filter(v => v.verdict === 'correct').length,
      preflight: verdicts.filter(v => v.cause === 'preflight').length,
      undetermined: verdicts.filter(v => v.cause === 'undetermined').length,
      otherCause: verdicts.filter(v => v.cause && v.cause !== 'preflight' && v.cause !== 'undetermined').length
    },
    reorder: fixture.reorder || reorderFrom(orders)
  };
}

/* The reorder cohort deliberately ignores the window, exactly as the SQL
   does: "did this customer come back within a year" is a question about the
   customer's whole history, and clipping it to a reporting window would
   silently answer a different one. */
function reorderFrom(orders) {
  const cutoff = Date.now() - 365 * 86400000;
  const by = new Map();
  for (const o of orders) {
    if (!o.who) continue;
    const t = new Date(o.at || 0).getTime();
    const e = by.get(o.who) || { first: Infinity, n: 0 };
    e.first = Math.min(e.first, t);
    e.n++;
    by.set(o.who, e);
  }
  const cohort = [...by.values()].filter(e => e.first <= cutoff);
  return { cohort: cohort.length, reordered: cohort.filter(e => e.n > 1).length };
}

/** Linear-interpolated percentile, matching Postgres `percentile_cont` so the
 *  fold and the SQL are comparable rather than merely similar. */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = p * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Wilson score lower bound at 95%. A rate of 100% from 4 orders has a lower
 *  bound near 40%, which is the honest way to say "we do not know yet" to
 *  somebody who is going to read the headline number and stop. */
export function wilsonLower(k, n, z = 1.96) {
  if (!n) return 0;
  const p = k / n, z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / (1 + z2 / n)));
}

const round = (x, dp = 1) => x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp;

/* A criterion is a small record rather than a bare number, because a bare
   number cannot say "I do not know yet" and this module's whole job is to be
   able to say that. `met` is null, not false, when the figure is not
   reportable — a criterion nobody has enough data for is not a failed one. */
const measured = (o) => ({ reportable: true, ...o });
const unmeasured = (reason, detail = {}) => ({ reportable: false, met: null, reason, ...detail });

/** Turn the gathered scalars into the §5.3 gate and the §10 supporting set. */
export function summarise(g) {
  const o = g.outcomes, ord = g.orders;

  /* The north star. Two things have to be true before it means anything: a
     large enough adjudicated sample, and adjudication of most of what was
     delivered. The second matters more than it looks — if half the delivered
     orders were never followed up, the half that were are not a sample, they
     are whoever complained loudly enough to be recorded, and that set is not
     representative in a knowable direction. */
  const coverage = ord.delivered ? o.adjudicated / ord.delivered : 0;
  const against = o.preflight + o.undetermined;
  const printCorrect = (() => {
    if (!ord.delivered) return unmeasured('no_delivered_orders', {
      note: 'No order has reached delivered. Nothing has been printed to be correct or not.' });
    if (o.adjudicated < MIN_SAMPLE.printCorrect) return unmeasured('insufficient_sample', {
      n: o.adjudicated, needed: MIN_SAMPLE.printCorrect, delivered: ord.delivered,
      note: `${o.adjudicated} of ${ord.delivered} delivered orders have a recorded outcome. `
          + 'A rate from that many is anecdote, so none is shown.' });
    if (coverage < MIN_COVERAGE) return unmeasured('insufficient_coverage', {
      n: o.adjudicated, delivered: ord.delivered, coverage: round(coverage * 100),
      needed: Math.ceil(MIN_COVERAGE * ord.delivered),
      note: 'Too many delivered orders were never followed up. The ones that were are '
          + 'not a sample of the run, they are the ones somebody chased.' });
    const rate = (o.adjudicated - against) / o.adjudicated;
    return measured({
      value: round(rate * 100, 2), unit: '%', target: 99.5, met: rate * 100 >= 99.5,
      n: o.adjudicated, lowerBound: round(wilsonLower(o.adjudicated - against, o.adjudicated) * 100, 2),
      preflightDefects: o.preflight, undetermined: o.undetermined, otherDefects: o.otherCause
    });
  })();

  const conceptReach = g.briefs.started < MIN_SAMPLE.conceptReach
    ? unmeasured('insufficient_sample', { n: g.briefs.started, needed: MIN_SAMPLE.conceptReach })
    : measured({
        value: round((g.briefs.reachedConcept / g.briefs.started) * 100), unit: '%', target: 40,
        met: (g.briefs.reachedConcept / g.briefs.started) * 100 >= 40,
        n: g.briefs.started,
        lowerBound: round(wilsonLower(g.briefs.reachedConcept, g.briefs.started) * 100)
      });

  const briefToExport = g.briefToExport.n < MIN_SAMPLE.briefToExport
    ? unmeasured('insufficient_sample', { n: g.briefToExport.n, needed: MIN_SAMPLE.briefToExport })
    : measured({
        value: round(g.briefToExport.medianMs / 60000, 2), unit: 'minutes', target: 10,
        met: g.briefToExport.medianMs / 60000 < 10, n: g.briefToExport.n
      });

  const conceptLatency = g.conceptLatency.n < MIN_SAMPLE.conceptLatency
    ? unmeasured('insufficient_sample', { n: g.conceptLatency.n, needed: MIN_SAMPLE.conceptLatency })
    : measured({
        value: round(g.conceptLatency.p95Ms / 1000, 2), unit: 'seconds', target: 6,
        met: g.conceptLatency.p95Ms / 1000 < 6, n: g.conceptLatency.n
      });

  const conceptToOrder = g.briefs.reachedConcept < MIN_SAMPLE.conceptToOrder
    ? unmeasured('insufficient_sample', { n: g.briefs.reachedConcept, needed: MIN_SAMPLE.conceptToOrder })
    : measured({
        value: round((g.briefs.reachedOrder / g.briefs.reachedConcept) * 100), unit: '%',
        target: null, met: null, n: g.briefs.reachedConcept
      });

  const reorder = g.reorder.cohort === 0
    ? unmeasured('window_not_elapsed', {
        note: 'No customer placed a first order twelve months ago, so nobody has had the chance to reorder.' })
    : measured({ value: round((g.reorder.reordered / g.reorder.cohort) * 100), unit: '%',
                 target: null, met: null, n: g.reorder.cohort });

  return {
    window: { since: g.since, days: g.days },

    /* §10's north star, and the only metric in this file that a person has to
       type in for. Everything else here is observed. */
    northStar: { name: 'Print-Correct Rate', ...printCorrect },

    exitCriteria: {
      paidOrders: measured({
        value: ord.paidDelivered, unit: 'orders', target: 100, met: ord.paidDelivered >= 100,
        note: 'Paid and delivered. Orders placed but not yet delivered are not counted: '
            + `${ord.total} orders exist, ${ord.delivered} of them delivered.` }),
      printCorrectRate: printCorrect,
      conceptReachRate: conceptReach,
      medianBriefToExport: briefToExport,

      /* Not measurable from here, and it would be easy to pretend otherwise.
         The cost is a Netlify and Neon invoice divided by the number of
         briefs; this table holds the divisor and nothing else, and inventing
         a per-invocation rate constant would produce a figure that looks
         audited and is not. So the divisor is reported and the division is
         refused — which is also the shape the print cost constants are in
         until somebody in Nilkhet quotes a real number. */
      engineCostPerBrief: unmeasured('no_billed_rate', {
        target: 1, unit: 'BDT', briefs: g.briefs.started,
        note: 'Divide the platform invoice for this window by the brief count. '
            + 'Nothing in the database knows what a function invocation was billed at.' }),

      /* §5.3 calls this the number that validates or kills the distribution
         thesis, and it is the one the schema cannot see at all: a pilot shop
         has no representation anywhere in it, because Epic I is a V2 item
         gated on this very criterion. Nothing about orders is a proxy for it —
         a shop that stopped using the tool and a quiet month look identical. */
      pilotShopRetention: unmeasured('not_instrumented', {
        target: '3 of 5', note: 'A pilot shop is not a record in this system. This is counted by '
            + 'asking five shops, and it stays a field observation until Epic I gives a shop an identity.' })
    },

    supporting: {
      briefToFirstConceptP95: conceptLatency,
      conceptToOrderRate: conceptToOrder,
      reorderRate12m: reorder,
      engineCostPerBrief: unmeasured('no_billed_rate', { target: 1, unit: 'BDT', briefs: g.briefs.started }),
      pilotShopRetention30d: unmeasured('not_instrumented', { target: '3 of 5' })
    },

    counts: g
  };
}

/** The whole read, for the endpoint. */
export const metricsFor = async (sql, opts) => summarise(await gather(sql, opts));
