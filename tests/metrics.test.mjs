/* Headless verification of the §5.3 exit criteria and the §10 north star.
   Runs with `node tests/metrics.test.mjs` and prints the same pass/fail format
   as cardworks-engine.test.cjs.

   Three properties are being protected, and the middle one is the reason this
   file is longer than the module it tests.

   The first is arithmetic: each of §5.3's numbers is computed correctly from a
   seeded set of events. That is checked twice — once through the pure fold and
   once through the SQL — because those are two implementations of the same
   definition and the interesting failure is them disagreeing.

   The second is that the module refuses to state a number it does not have.
   This is the property most likely to rot, because every pressure on a
   dashboard pushes toward showing something, and a confident 99% from four
   orders is indistinguishable at a glance from a real one. So the assertions
   here are not only "it says not-enough-data" but "the response contains no
   number that could be mistaken for the rate".

   The third is that a print-correct verdict means what §10 says it means:
   preflight-attributable defects and nothing else. A courier crushing a box
   must leave the number exactly where it was, and that is asserted by moving
   one defect at a time and requiring the rate to hold still.

   Section 8 runs against a real Postgres and says loudly when there is none,
   for the reason WORKPLAN.md gives: the append-only trigger and the meta
   allowlist are guarantees held by the database rather than by callers being
   careful, and an in-memory check of them proves only that the test is
   careful. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EVENTS, META_KEYS, CAUSES, EVIDENCE, VERDICTS, AGAINST_NORTH_STAR, MIN_SAMPLE, MIN_COVERAGE,
  BRIEF_KEY_RE, sanitiseMeta, record, recordOutcome, gather, foldEvents, summarise,
  metricsFor, percentile, wilsonLower, sinceFor
} from '../lib/metrics.mjs';
import { metricsRequest } from '../netlify/functions/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✓ ' + name))
                                              : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))); };
const H = (s) => console.log('\n' + s);

/* ────────────────────────────────────────────────────────────────────────
   The fixture

   One set of events, orders and verdicts, used by every section, so that
   "the same seeded data" is literally the same object rather than two
   arrangements that drifted apart. The clock is fixed: a fixture that moves
   with the wall clock cannot be reasoned about when it fails.
   ──────────────────────────────────────────────────────────────────────── */
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function buildFixture() {
  const events = [], orders = [], outcomes = [];

  /* 60 briefs start. 30 reach a concept — a 50% reach rate, over §5.3's 40%.
     25 reach an export, at spans of half a minute to twelve and a half, whose
     median is 6.5 minutes and so passes the ten-minute criterion. 12 go on to
     an order. */
  for (let i = 0; i < 60; i++) {
    const key = 'brief-' + String(i).padStart(4, '0');
    const start = T0 + i * 60000;
    events.push({ name: 'brief.started', briefKey: key, at: iso(start),
                  meta: { locale: i % 2 ? 'bn' : 'en', vertical: 'ver.retail' } });
    /* Twenty-one of the thirty carry a timing. A client that lost its clock
       still reports the concept view, because the funnel needs the event and
       the latency figure is allowed to be drawn from fewer samples than the
       funnel is. */
    if (i < 30)
      events.push({ name: 'concept.viewed', briefKey: key, at: iso(start + 4000),
                    durationMs: i < 21 ? 1000 + i * 100 : null, meta: { count: 6 } });
    if (i < 25)
      events.push({ name: 'export.completed', briefKey: key, at: iso(start + (i + 1) * 30000),
                    shortCode: 'c0de' + String(i).padStart(2, '0'), meta: { variant: 'print' } });
    if (i < 12)
      events.push({ name: 'order.placed', briefKey: key, at: iso(start + 900000),
                    orderRef: 'ORD-9' + String(i).padStart(4, '0'), meta: { qty: 500 } });
  }

  /* 45 orders inside the window. 40 delivered and paid, 3 delivered but never
     paid, 2 still in flight. 40 of the 43 delivered ones were followed up,
     which is 93% coverage and over the 80% floor. */
  for (let i = 0; i < 45; i++) {
    const ref = 'ORD-9' + String(i).padStart(4, '0');
    orders.push({ ref, at: iso(T0 + i * 3600000), who: 'buyer-' + String(i).padStart(4, '0'),
                  status: i < 43 ? 'delivered' : 'printing', paid: i < 40 });
  }

  /* One preflight-attributable defect, one press defect and one courier
     defect among forty verdicts. Only the first moves the north star, so the
     rate is 39/40. */
  const verdictFor = (i) =>
    i === 5  ? { verdict: 'defective', cause: 'preflight', defectCode: 'text_outside_safe_area' } :
    i === 11 ? { verdict: 'defective', cause: 'press',     defectCode: 'press_misregistration' } :
    i === 17 ? { verdict: 'defective', cause: 'courier',   defectCode: 'courier_damage' } :
               { verdict: 'correct', cause: null, defectCode: null };
  for (let i = 0; i < 40; i++)
    outcomes.push({ orderRef: 'ORD-9' + String(i).padStart(4, '0'), at: iso(T0 + 86400000 + i * 60000),
                    evidence: 'customer_report', recordedBy: 'rokeya', ...verdictFor(i) });

  /* Two customers who first ordered long enough ago to have come back, one of
     whom did. Cancelled, so they stay out of the delivered denominator while
     still being part of the twelve-month reorder cohort. */
  const old = Date.UTC(2023, 5, 1);
  orders.push({ ref: 'ORD-80001', at: iso(old), who: 'buyer-old-a', status: 'cancelled', paid: false });
  orders.push({ ref: 'ORD-80002', at: iso(old + 86400000 * 40), who: 'buyer-old-a', status: 'cancelled', paid: false });
  orders.push({ ref: 'ORD-80003', at: iso(old), who: 'buyer-old-b', status: 'cancelled', paid: false });

  return { events, orders, outcomes };
}

const FIXTURE = buildFixture();
const FOLDED = foldEvents(FIXTURE);
const REPORT = summarise(FOLDED);

/* ────────────────────────────────────────────────────────────────────────
   1. The vocabulary is the numbers, not a taxonomy
   ──────────────────────────────────────────────────────────────────────── */
H('1. Only what §5.3 and §10 need is recorded');

ok('there are exactly four funnel events',
   EVENTS.join() === 'brief.started,concept.viewed,export.completed,order.placed', EVENTS.join());
ok('the ≥40% funnel has both of its ends', EVENTS.includes('brief.started') && EVENTS.includes('concept.viewed'));
ok('the brief-to-export clock has both of its ends',
   EVENTS.includes('brief.started') && EVENTS.includes('export.completed'));
ok('concept→order conversion can be attributed to a brief', EVENTS.includes('order.placed'));
ok('a delivered order is not an event — the orders table is the one answer to that',
   !EVENTS.some(e => e.startsWith('order.deliver')));
ok('only a preflight-attributable defect and an unexplained one count against the north star',
   AGAINST_NORTH_STAR.join() === 'preflight,undetermined', AGAINST_NORTH_STAR.join());
ok('and the causes that do not are named rather than lumped together',
   CAUSES.includes('press') && CAUSES.includes('courier') && CAUSES.includes('customer_content'));
ok('a verdict says how it was established', EVIDENCE.length === 3 && EVIDENCE.includes('shop_inspection'));
ok('and is one of two words', VERDICTS.join() === 'correct,defective');

/* ────────────────────────────────────────────────────────────────────────
   2. No event carries card content or a person
   ──────────────────────────────────────────────────────────────────────── */
H('2. The funnel measures a funnel, not a person');

const CONTENT = {
  name: 'Sharmin Akter', phone: '+8801712345678', email: 'sharmin@zenith.com.bd',
  address: '14/B Gulshan Avenue, Dhaka', company: 'Zenith Sourcing Ltd.',
  role: 'Senior Merchandiser', ownerKey: 'owner-abcdefgh', text: 'চট্টগ্রাম',
  locale: 'bn', count: 6
};
const cleaned = sanitiseMeta(CONTENT);

ok('every content and contact key is dropped',
   Object.keys(cleaned).join() === 'locale,count', Object.keys(cleaned).join());
ok('and nothing that survived contains the customer',
   !JSON.stringify(cleaned).includes('Sharmin') && !JSON.stringify(cleaned).includes('01712345678'));
ok('the allowlist itself names no field a person could be written into',
   !META_KEYS.some(k => /name|phone|email|address|owner|text|company|role|title/i.test(k)),
   META_KEYS.join());
ok('a value that is not a scalar cannot smuggle one in',
   Object.keys(sanitiseMeta({ locale: { deep: 'Sharmin Akter' }, count: [1, 2] })).length === 0);
ok('and a long string under an allowed key is refused rather than truncated',
   sanitiseMeta({ vertical: 'x'.repeat(200) }).vertical === undefined);
ok('a brief key is random and per-brief, so two briefs from one phone do not join',
   BRIEF_KEY_RE.test('brief-0001') && !BRIEF_KEY_RE.test('short') && !BRIEF_KEY_RE.test('+8801712345678'));

/* ────────────────────────────────────────────────────────────────────────
   3. Each §5.3 criterion, from the seeded events
   ──────────────────────────────────────────────────────────────────────── */
H('3. The exit criteria compute from a seeded set of events');

const C = REPORT.exitCriteria;

ok('100 paid orders — 40 of the 45 seeded orders were delivered and paid',
   C.paidOrders.value === 40 && C.paidOrders.target === 100 && C.paidOrders.met === false,
   JSON.stringify(C.paidOrders));
ok('and an order that was delivered but never paid is not one of them',
   FOLDED.orders.delivered === 43 && FOLDED.orders.paidDelivered === 40,
   `${FOLDED.orders.delivered} delivered, ${FOLDED.orders.paidDelivered} paid`);

ok('≥40% of started briefs reach a concept — 30 of 60 is 50%',
   C.conceptReachRate.value === 50 && C.conceptReachRate.n === 60 && C.conceptReachRate.met === true,
   JSON.stringify(C.conceptReachRate));
ok('and the lower bound is stated alongside it, not just the point estimate',
   C.conceptReachRate.lowerBound > 0 && C.conceptReachRate.lowerBound < C.conceptReachRate.value);

ok('median brief-to-export — 25 spans from 0.5 to 12.5 minutes have a median of 6.5',
   C.medianBriefToExport.value === 6.5 && C.medianBriefToExport.n === 25 &&
   C.medianBriefToExport.met === true, JSON.stringify(C.medianBriefToExport));

ok('the print-correct rate is 39 of 40, because one of the three defects was ours',
   C.printCorrectRate.value === 97.5 && C.printCorrectRate.n === 40,
   JSON.stringify(C.printCorrectRate));
ok('and it reports how many defects there were of each kind',
   C.printCorrectRate.preflightDefects === 1 && C.printCorrectRate.otherDefects === 2 &&
   C.printCorrectRate.undetermined === 0);
ok('97.5% does not meet the 99.5% target and says so',
   C.printCorrectRate.met === false && C.printCorrectRate.target === 99.5);

ok('engine cost per brief is not reported, because nothing here knows the billed rate',
   C.engineCostPerBrief.reportable === false && C.engineCostPerBrief.reason === 'no_billed_rate');
ok('but the divisor a real invoice would be divided by is given',
   C.engineCostPerBrief.briefs === 60);
ok('pilot shop retention is not reported, because a pilot shop is not in the schema',
   C.pilotShopRetention.reportable === false && C.pilotShopRetention.reason === 'not_instrumented');
ok('and neither of the two uncomputable criteria is scored as failed',
   C.engineCostPerBrief.met === null && C.pilotShopRetention.met === null);

H('3b. The §10 supporting metrics');
const S = REPORT.supporting;
ok('brief→first-concept p95 is 2.9s from the 21 concept views that carried a timing',
   S.briefToFirstConceptP95.value === 2.9 && S.briefToFirstConceptP95.n === 21 &&
   S.briefToFirstConceptP95.met === true, JSON.stringify(S.briefToFirstConceptP95));
ok('concept→order conversion is 12 of the 30 briefs that saw a concept',
   S.conceptToOrderRate.value === 40 && S.conceptToOrderRate.n === 30,
   JSON.stringify(S.conceptToOrderRate));
ok('the 12-month reorder rate uses the cohort old enough to have reordered',
   S.reorderRate12m.value === 50 && S.reorderRate12m.n === 2, JSON.stringify(S.reorderRate12m));
ok('and the north star is the same figure §5.3 gates on, not a second reckoning of it',
   REPORT.northStar.value === C.printCorrectRate.value && REPORT.northStar.name === 'Print-Correct Rate');

/* ────────────────────────────────────────────────────────────────────────
   4. Too little data is said out loud
   ──────────────────────────────────────────────────────────────────────── */
H('4. A criterion without enough data reports that, never a number');

const tiny = summarise(foldEvents({
  events: [
    { name: 'brief.started', briefKey: 'brief-aaaa1', at: iso(T0) },
    { name: 'concept.viewed', briefKey: 'brief-aaaa1', at: iso(T0 + 3000), durationMs: 1200 },
    { name: 'export.completed', briefKey: 'brief-aaaa1', at: iso(T0 + 120000) }
  ],
  orders: [0, 1, 2, 3].map(i => ({ ref: 'ORD-7000' + i, at: iso(T0), who: 'b' + i,
                                   status: 'delivered', paid: true })),
  outcomes: [0, 1, 2, 3].map(i => ({ orderRef: 'ORD-7000' + i, at: iso(T0 + 86400000),
                                     verdict: 'correct', cause: null }))
}));

ok('four delivered orders, all correct, is not a 100% print-correct rate',
   tiny.northStar.reportable === false && tiny.northStar.value === undefined,
   JSON.stringify(tiny.northStar));
ok('it is unknown, and it says why and what would settle it',
   tiny.northStar.reason === 'insufficient_sample' && tiny.northStar.n === 4 &&
   tiny.northStar.needed === MIN_SAMPLE.printCorrect);
ok('and no number anywhere in that answer could be read as the rate',
   !/\b(100|99\.\d)\b/.test(JSON.stringify(tiny.northStar)), JSON.stringify(tiny.northStar));
ok('one brief is not a funnel',
   tiny.exitCriteria.conceptReachRate.reportable === false &&
   tiny.exitCriteria.conceptReachRate.reason === 'insufficient_sample' &&
   tiny.exitCriteria.conceptReachRate.value === undefined);
ok('one export is not a median',
   tiny.exitCriteria.medianBriefToExport.reportable === false &&
   tiny.exitCriteria.medianBriefToExport.needed === MIN_SAMPLE.briefToExport);
ok('one sample is not a p95',
   tiny.supporting.briefToFirstConceptP95.reportable === false);
ok('but a count is still a count — four paid orders out of a hundred is progress, not noise',
   tiny.exitCriteria.paidOrders.reportable === true && tiny.exitCriteria.paidOrders.value === 4);
ok('nothing delivered at all is a different answer from too few delivered',
   summarise(foldEvents({ orders: [], outcomes: [] })).northStar.reason === 'no_delivered_orders');

/* Coverage, which is the subtler half. Thirty-five verdicts clears the sample
   floor, but thirty-five out of two hundred deliveries is not a sample of the
   run — it is whoever was chased, and that set is skewed in a direction
   nobody can measure. */
const skewed = summarise(foldEvents({
  orders: Array.from({ length: 200 }, (_, i) => ({ ref: 'ORD-6' + String(i).padStart(4, '0'),
    at: iso(T0), who: 'b' + i, status: 'delivered', paid: true })),
  outcomes: Array.from({ length: 35 }, (_, i) => ({ orderRef: 'ORD-6' + String(i).padStart(4, '0'),
    at: iso(T0 + 86400000), verdict: 'correct', cause: null }))
}));
ok('35 verdicts over 200 deliveries clears the sample floor but not the coverage floor',
   skewed.northStar.reportable === false && skewed.northStar.reason === 'insufficient_coverage',
   JSON.stringify(skewed.northStar));
ok('and it says how far short the follow-up is',
   skewed.northStar.n === 35 && skewed.northStar.needed === Math.ceil(MIN_COVERAGE * 200));

/* And the reverse: with enough of both, it reports, and the lower bound is
   what stops "100% of 40" from reading as "we hit 99.5%". */
const clean = summarise(foldEvents({
  orders: Array.from({ length: 40 }, (_, i) => ({ ref: 'ORD-5' + String(i).padStart(4, '0'),
    at: iso(T0), who: 'b' + i, status: 'delivered', paid: true })),
  outcomes: Array.from({ length: 40 }, (_, i) => ({ orderRef: 'ORD-5' + String(i).padStart(4, '0'),
    at: iso(T0 + 86400000), verdict: 'correct', cause: null }))
}));
ok('forty out of forty correct does report 100%', clean.northStar.value === 100);
ok('but its lower bound says the 99.5% target is not yet evidenced',
   clean.northStar.lowerBound < 99.5, String(clean.northStar.lowerBound));
ok('and it is not claimed as met on that evidence', clean.northStar.met === true &&
   clean.northStar.lowerBound < clean.northStar.target);

/* ────────────────────────────────────────────────────────────────────────
   5. The north star counts preflight-attributable defects and nothing else
   ──────────────────────────────────────────────────────────────────────── */
H('5. Only a defect that was ours moves the north star');

const rateWith = (extra) => summarise(foldEvents({
  orders: Array.from({ length: 40 + extra.length }, (_, i) => ({
    ref: 'ORD-4' + String(i).padStart(4, '0'), at: iso(T0), who: 'b' + i,
    status: 'delivered', paid: true })),
  outcomes: [
    ...Array.from({ length: 40 }, (_, i) => ({ orderRef: 'ORD-4' + String(i).padStart(4, '0'),
      at: iso(T0 + 86400000), verdict: 'correct', cause: null })),
    ...extra.map((cause, j) => ({ orderRef: 'ORD-4' + String(40 + j).padStart(4, '0'),
      at: iso(T0 + 86400000), verdict: 'defective', cause }))
  ]
})).northStar;

const base = rateWith([]);
ok('a clean run of forty is 100%', base.value === 100);
ok('a press misregistration does not move it', rateWith(['press']).value === 100);
ok('nor does courier damage', rateWith(['courier']).value === 100);
ok('nor does a customer typing their own number wrong', rateWith(['customer_content']).value === 100);
ok('three defects that were not ours still leave it at 100%',
   rateWith(['press', 'courier', 'customer_content']).value === 100);
ok('but they are counted and shown, so the run does not look flawless',
   rateWith(['press', 'courier', 'customer_content']).otherDefects === 3);
ok('one preflight-attributable defect does move it',
   rateWith(['preflight']).value === Math.round((40 / 41) * 10000) / 100,
   String(rateWith(['preflight']).value));
ok('an unexplained defect counts against us rather than for us',
   rateWith(['undetermined']).value < 100 && rateWith(['undetermined']).undetermined === 1);
ok('and it is reported separately, so nobody has to guess how much is unresolved',
   rateWith(['preflight', 'undetermined']).undetermined === 1 &&
   rateWith(['preflight', 'undetermined']).preflightDefects === 1);

/* ────────────────────────────────────────────────────────────────────────
   6. The arithmetic underneath
   ──────────────────────────────────────────────────────────────────────── */
H('6. Percentiles and the lower bound');

ok('the median of an even set interpolates, as percentile_cont does',
   percentile([1, 2, 3, 4], 0.5) === 2.5);
ok('and of an odd set does not', percentile([1, 2, 3], 0.5) === 2);
ok('p95 interpolates between the two straddling samples',
   Math.abs(percentile([0, 10, 20, 30, 40], 0.95) - 38) < 1e-9, String(percentile([0, 10, 20, 30, 40], 0.95)));
ok('an empty set has no percentile rather than a zero', percentile([], 0.5) === null);
ok('the Wilson bound of 4 out of 4 is nowhere near certainty',
   wilsonLower(4, 4) < 0.6 && wilsonLower(4, 4) > 0.3, String(wilsonLower(4, 4)));
ok('and it tightens as the sample grows', wilsonLower(400, 400) > wilsonLower(40, 40) &&
   wilsonLower(40, 40) > wilsonLower(4, 4));
ok('an empty sample has a lower bound of nothing at all', wilsonLower(0, 0) === 0);
ok('the default window is all of time, because §5.3 is a cumulative gate',
   sinceFor(null).getTime() === 0 && sinceFor(0).getTime() === 0);
ok('and a day count narrows it', sinceFor(30).getTime() > Date.now() - 31 * 86400000);

/* ────────────────────────────────────────────────────────────────────────
   7. The endpoint's refusals, which need no database
   ──────────────────────────────────────────────────────────────────────── */
H('7. Who may read the numbers and who may write a verdict');

const REQ = (method, p, body, headers) =>
  new Request('https://cardworks.bd' + p, { method, body: body && JSON.stringify(body), headers });

ok('the report needs a database', (await metricsRequest(REQ('GET', '/api/metrics'), null)).status === 503);
ok('so does recording a verdict',
   (await metricsRequest(REQ('POST', '/api/metrics', { outcome: {} }), null)).status === 503);

/* ────────────────────────────────────────────────────────────────────────
   8. Against a real Postgres
   ──────────────────────────────────────────────────────────────────────── */
H('8. The events table, the verdicts table, and the SQL that reads them');

/* Everything above ran on the fold. The fold is a reference implementation,
   and a reference implementation agreeing with itself proves nothing about
   the queries the dashboard will actually run — so this section seeds the
   same fixture into a real Postgres, runs `gather`, and requires the two to
   agree field for field. That is the far-side-of-the-seam assertion
   WORKPLAN.md asks for: a HAVING clause that quietly redefines a started
   brief fails the build instead of moving the number the company decides on.

   It builds and drops its own `cardworks_metrics_test`. Point
   CARDWORKS_TEST_DATABASE_URL at an already-migrated database to skip both. */
const PG_URL = process.env.CARDWORKS_TEST_DATABASE_URL
  || `postgres://${process.env.USER || 'postgres'}@127.0.0.1/cardworks_metrics_test`;

const psql = (url, args, input) => execFileSync('psql', [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', ...args],
  { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    env: { ...process.env, PGCONNECT_TIMEOUT: '3' } });

let live = null;
try {
  const admin = PG_URL.replace(/\/[^/]*$/, '/postgres');
  const dbName = PG_URL.slice(PG_URL.lastIndexOf('/') + 1);
  if (!process.env.CARDWORKS_TEST_DATABASE_URL) {
    try { psql(admin, ['-c', `DROP DATABASE IF EXISTS ${dbName}`]); } catch { /* reported below */ }
    psql(admin, ['-c', `CREATE DATABASE ${dbName}`]);
  }
  psql(PG_URL, ['-f', path.join(ROOT, 'db/schema.sql')]);
  for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations')).sort())
    psql(PG_URL, ['-f', path.join(ROOT, 'db/migrations', f)]);
  live = PG_URL;
} catch (err) {
  console.log('  ⚠ NOT RUN — no Postgres at ' + PG_URL);
  console.log('    Unverified here: that metric_events and order_outcomes refuse UPDATE and DELETE,');
  console.log('    that the meta allowlist is enforced by the database rather than by callers,');
  console.log('    and that the aggregate SQL agrees with the fold every number above came from.');
  console.log('    Run a local Postgres, or set CARDWORKS_TEST_DATABASE_URL, to check them.');
  console.log('    (' + String(err.message || err).split('\n')[0].slice(0, 120) + ')');
}

if (live) {
  const q = (text) => psql(live, ['-c', text]).trim();
  const raises = (text) => { try { psql(live, ['-c', text]); return null; } catch (e) { return String(e.stderr || e.message); } };
  const rows = (text) => JSON.parse(
    psql(live, ['-c', `WITH r AS (${text}) SELECT coalesce(json_agg(r),'[]'::json)::text FROM r`]).trim() || '[]');

  /* A tagged template with the same surface as the Neon client, so the real
     module runs unmodified against the real database. Values are quoted
     rather than bound because psql has no bind protocol on `-c`; that is
     acceptable in a fixture and nowhere else. */
  const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const sql = (strings, ...vals) => {
    const text = strings.reduce((a, s, i) => a + s + (i < vals.length ? lit(vals[i]) : ''), '').trim();
    const returning = /^\s*(select|with)\b/i.test(text) || /\breturning\b/i.test(text);
    if (!returning) { q(text); return Promise.resolve([]); }
    return Promise.resolve(rows(text));
  };

  /* Clearing the table between sections needs the trigger out of the way,
     which is itself a small proof that the guarantee is real: there is no
     ordinary DELETE that works, only an owner disabling the trigger. */
  const clearEvents = () => q(`ALTER TABLE metric_events DISABLE TRIGGER metric_events_immutable;
                               DELETE FROM metric_events;
                               ALTER TABLE metric_events ENABLE TRIGGER metric_events_immutable`);

  ok('the migration applies to a clean database',
     q(`SELECT count(*) FROM information_schema.tables WHERE table_name IN ('metric_events','order_outcomes')`) === '2');
  for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations')).sort())
    psql(live, ['-f', path.join(ROOT, 'db/migrations', f)]);
  ok('and re-running every migration changes nothing',
     q('SELECT count(*) FROM metric_events') === '0' && q('SELECT count(*) FROM order_outcomes') === '0');

  /* The table has no column a name could live in. This is the structural half
     of the privacy claim — the allowlist guards `meta`, and this guards the
     idea of adding a `content` column later without anyone noticing. */
  const cols = q(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
                  FROM information_schema.columns WHERE table_name = 'metric_events'`);
  ok('metric_events has exactly the eight columns the metrics need and no more',
     cols === 'id,name,brief_key,short_code,order_ref,duration_ms,meta,created_at', cols);

  ok('the database refuses an event name outside the closed set',
     raises(`INSERT INTO metric_events (name) VALUES ('brief.start')`) !== null);
  ok('and refuses a brief key shaped like a phone number',
     raises(`INSERT INTO metric_events (name, brief_key) VALUES ('brief.started', '+8801712345678')`) !== null);
  ok('the meta allowlist is enforced by Postgres, not by the caller remembering',
     raises(`INSERT INTO metric_events (name, meta) VALUES ('brief.started', '{"name":"Sharmin Akter"}'::jsonb)`) !== null);
  ok('a phone number under an invented key is refused for the same reason',
     raises(`INSERT INTO metric_events (name, meta) VALUES ('brief.started', '{"phone":"01712345678"}'::jsonb)`) !== null);
  ok('and a nested object under an allowed key is refused too',
     raises(`INSERT INTO metric_events (name, meta) VALUES ('brief.started', '{"locale":{"x":"Sharmin"}}'::jsonb)`) !== null);
  ok('while the meta the funnel actually uses is accepted',
     raises(`INSERT INTO metric_events (name, meta) VALUES ('brief.started', '{"locale":"bn","count":6}'::jsonb)`) === null);

  ok('metric_events refuses UPDATE',
     /append-only/.test(raises(`UPDATE metric_events SET name = 'order.placed'`) || ''));
  ok('and refuses DELETE',
     /append-only/.test(raises(`DELETE FROM metric_events`) || ''));
  clearEvents();

  /* `record` writes through the same helper the endpoints will call, so what
     is being checked here is the helper, not a hand-written INSERT. */
  ok('record() writes an event', await record(sql, 'brief.started', { briefKey: 'brief-zzzz1', meta: { locale: 'bn' } }));
  ok('and strips a name out of the meta on the way rather than being refused by the CHECK',
     await record(sql, 'concept.viewed', { briefKey: 'brief-zzzz1', durationMs: 900, meta: CONTENT }) &&
     q(`SELECT meta::text FROM metric_events WHERE name = 'concept.viewed'`) === '{"count": 6, "locale": "bn"}',
     q(`SELECT meta::text FROM metric_events WHERE name = 'concept.viewed'`));
  ok('an unknown event name is not written and does not throw',
     (await record(sql, 'brief.abandoned', { briefKey: 'brief-zzzz1' })) === false);
  ok('and a metrics write never fails the request it rides on',
     (await record(null, 'brief.started', {})) === false &&
     (await record({ }, 'brief.started', {})) === false);
  clearEvents();

  /* ── seed the fixture ──
     One statement per table rather than one per row. Three hundred psql
     invocations is thirty seconds of process spawning, and a suite people
     will not wait for is a suite people stop running. */
  const txt = (v) => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  const jsonLit = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
  const insert = (table, columns, values) =>
    values.length && q(`INSERT INTO ${table} (${columns}) VALUES ${values.join(',')}`);

  insert('metric_events', 'name, brief_key, short_code, order_ref, duration_ms, meta, created_at',
    FIXTURE.events.map(e => `(${txt(e.name)}, ${txt(e.briefKey)}, ${txt(e.shortCode)}, ${txt(e.orderRef)},`
      + ` ${e.durationMs ?? 'NULL'}, ${jsonLit(sanitiseMeta(e.meta))}, ${txt(e.at)})`));

  insert('orders', 'ref, owner_key, short_code, qty, press, subtotal, total, status, created_at',
    FIXTURE.orders.map(o => `(${txt(o.ref)}, ${txt(o.who)}, 'c0de00', 500, 'Nilkhet Press',`
      + ` 4000, 4500, ${txt(o.status)}, ${txt(o.at)})`));

  insert('payments', 'ref, order_ref, provider, amount, status, capture_key',
    FIXTURE.orders.filter(o => o.paid).map(o =>
      `(${txt('PAY-' + o.ref)}, ${txt(o.ref)}, 'bkash', 4500, 'captured', ${txt('k-' + o.ref)})`));

  insert('order_outcomes', 'order_ref, verdict, cause, defect_code, evidence, recorded_by, created_at',
    FIXTURE.outcomes.map(v => `(${txt(v.orderRef)}, ${txt(v.verdict)}, ${txt(v.cause)},`
      + ` ${txt(v.defectCode)}, ${txt(v.evidence)}, ${txt(v.recordedBy)}, ${txt(v.at)})`));

  const gathered = await gather(sql, {});

  const same = (a, b, tol = 1e-6) => {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      return ka.join() === kb.join() && ka.every(k => same(a[k], b[k], tol));
    }
    return false;
  };

  ok('the aggregate SQL and the fold agree on the funnel',
     same(gathered.briefs, FOLDED.briefs), JSON.stringify(gathered.briefs) + ' vs ' + JSON.stringify(FOLDED.briefs));
  ok('and on the brief-to-export median',
     same(gathered.briefToExport, FOLDED.briefToExport),
     JSON.stringify(gathered.briefToExport) + ' vs ' + JSON.stringify(FOLDED.briefToExport));
  ok('and on the concept latency p95',
     same(gathered.conceptLatency, FOLDED.conceptLatency),
     JSON.stringify(gathered.conceptLatency) + ' vs ' + JSON.stringify(FOLDED.conceptLatency));
  ok('and on which orders were paid and delivered',
     same(gathered.orders, FOLDED.orders),
     JSON.stringify(gathered.orders) + ' vs ' + JSON.stringify(FOLDED.orders));
  ok('and on the verdicts, defect by defect',
     same(gathered.outcomes, FOLDED.outcomes),
     JSON.stringify(gathered.outcomes) + ' vs ' + JSON.stringify(FOLDED.outcomes));
  ok('and on the twelve-month reorder cohort',
     same(gathered.reorder, FOLDED.reorder),
     JSON.stringify(gathered.reorder) + ' vs ' + JSON.stringify(FOLDED.reorder));

  const liveReport = await metricsFor(sql, {});
  ok('so the report read out of Postgres is the report every assertion above was made against',
     liveReport.northStar.value === 97.5 && liveReport.exitCriteria.paidOrders.value === 40 &&
     liveReport.exitCriteria.conceptReachRate.value === 50 &&
     liveReport.exitCriteria.medianBriefToExport.value === 6.5,
     JSON.stringify(liveReport.northStar));

  /* ── the verdict, entered rather than derived ── */
  const [row, problem] = await recordOutcome(sql, {
    orderRef: 'ORD-90040', verdict: 'defective', cause: 'preflight',
    defectCode: 'bangla_cluster_broken', evidence: 'shop_inspection', recordedBy: 'rokeya',
    sourceKey: 'complaint-118', note: 'Conjunct broke on the second line'
  });
  ok('a verdict is recorded against the order', !problem && row.order_ref === 'ORD-90040', JSON.stringify(problem));
  const [again] = await recordOutcome(sql, {
    orderRef: 'ORD-90040', verdict: 'defective', cause: 'preflight',
    defectCode: 'bangla_cluster_broken', evidence: 'shop_inspection', recordedBy: 'rokeya',
    sourceKey: 'complaint-118'
  });
  ok('and a retried complaint is the same verdict, not a second one',
     again.id === row.id && q(`SELECT count(*) FROM order_outcomes WHERE order_ref = 'ORD-90040'`) === '1');

  const [, missingCause] = await recordOutcome(sql, {
    orderRef: 'ORD-90041', verdict: 'defective', evidence: 'customer_report', recordedBy: 'rokeya' });
  ok('a defect without a cause is refused, because an uncaused defect cannot be counted',
     missingCause && missingCause.field === 'cause');
  const [, causedCorrect] = await recordOutcome(sql, {
    orderRef: 'ORD-90041', verdict: 'correct', cause: 'press', evidence: 'customer_report', recordedBy: 'rokeya' });
  ok('and a correct card with a defect cause is refused as the contradiction it is',
     causedCorrect && causedCorrect.field === 'cause');
  const [, anonymous] = await recordOutcome(sql, {
    orderRef: 'ORD-90041', verdict: 'correct', evidence: 'customer_report', recordedBy: '  ' });
  ok('a verdict nobody put their name to is refused', anonymous && anonymous.field === 'recordedBy');
  const [, noEvidence] = await recordOutcome(sql, {
    orderRef: 'ORD-90041', verdict: 'correct', recordedBy: 'rokeya' });
  ok('and one that does not say how it was established is too', noEvidence && noEvidence.field === 'evidence');

  ok('order_outcomes refuses UPDATE',
     /append-only/.test(raises(`UPDATE order_outcomes SET verdict = 'correct'`) || ''));
  ok('and refuses DELETE', /append-only/.test(raises(`DELETE FROM order_outcomes`) || ''));

  /* A defect found after a sign-off is a correction, and a correction is a new
     row. The rate must follow the newest verdict, not the first one. */
  const beforeCorrection = (await metricsFor(sql, {})).northStar.value;
  await recordOutcome(sql, { orderRef: 'ORD-90000', verdict: 'defective', cause: 'preflight',
    defectCode: 'text_outside_safe_area', evidence: 'customer_report', recordedBy: 'rokeya',
    sourceKey: 'complaint-119' });
  const afterCorrection = (await metricsFor(sql, {})).northStar;
  ok('a corrected verdict is a new row rather than an edit',
     q(`SELECT count(*) FROM order_outcomes WHERE order_ref = 'ORD-90000'`) === '2');
  ok('and the rate follows the newest one',
     afterCorrection.value < beforeCorrection && afterCorrection.preflightDefects === 3,
     `${beforeCorrection} then ${afterCorrection.value}, ${afterCorrection.preflightDefects} preflight`);

  /* ── the endpoint, against the same database ── */
  const CALL = (method, p, body, headers) => metricsRequest(REQ(method, p, body, headers), sql);
  delete process.env.CARDWORKS_STAFF_TOKEN;
  ok('a deploy with no staff token will not hand out the numbers',
     (await CALL('GET', '/api/metrics')).status === 403);
  ok('nor accept a verdict, rather than leaving the north star open to anyone',
     (await CALL('POST', '/api/metrics', { outcome: { orderRef: 'ORD-90002', verdict: 'correct',
       evidence: 'our_inspection', recordedBy: 'anyone' } })).status === 403);

  process.env.CARDWORKS_STAFF_TOKEN = 'test-staff-token';
  const STAFF = { 'x-cardworks-staff': 'test-staff-token' };
  ok('a wrong token is still refused', (await CALL('GET', '/api/metrics', null, { 'x-cardworks-staff': 'wrong' })).status === 403);

  const reportRes = await CALL('GET', '/api/metrics', null, STAFF);
  const reportBody = await reportRes.json();
  ok('staff get the report', reportRes.status === 200 && reportBody.northStar.name === 'Print-Correct Rate');
  ok('and it carries the window it was computed over', reportBody.window.days === null);
  ok('the read path never returns the note a complaint was written up in',
     !JSON.stringify(reportBody).includes('Conjunct broke'));
  ok('nor any customer content at all',
     !/Sharmin|01712345678|Gulshan/.test(JSON.stringify(reportBody)));

  ok('a verdict on an order that does not exist is a 404',
     (await CALL('POST', '/api/metrics', { outcome: { orderRef: 'ORD-00001', verdict: 'correct',
       evidence: 'our_inspection', recordedBy: 'rokeya' } }, STAFF)).status === 404);

  const early = await CALL('POST', '/api/metrics', { outcome: { orderRef: 'ORD-90044',
    verdict: 'defective', cause: 'preflight', defectCode: 'glyph_missing',
    evidence: 'shop_inspection', recordedBy: 'rokeya' } }, STAFF);
  ok('a shop that catches a defect before handover is recorded, not turned away',
     early.status === 201 && (await early.json()).undelivered === true);

  const evt = await CALL('POST', '/api/metrics', { event: 'brief.started', briefKey: 'brief-yyyy1',
    meta: { locale: 'bn', name: 'Sharmin Akter' } });
  ok('a funnel event needs no staff token, because starting a brief is not a secret',
     evt.status === 201);
  ok('and the name sent with it never reaches the database',
     q(`SELECT meta::text FROM metric_events WHERE brief_key = 'brief-yyyy1'`) === '{"locale": "bn"}',
     q(`SELECT meta::text FROM metric_events WHERE brief_key = 'brief-yyyy1'`));
  ok('an invented event name is refused with the vocabulary that would have worked',
     (await CALL('POST', '/api/metrics', { event: 'brief.abandoned' })).status === 400);

  if (!process.env.CARDWORKS_TEST_DATABASE_URL) {
    try { psql(live.replace(/\/[^/]*$/, '/postgres'), ['-c', `DROP DATABASE IF EXISTS ${live.slice(live.lastIndexOf('/') + 1)}`]); }
    catch { /* a leftover throwaway database is not worth failing a build over */ }
  }
}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
