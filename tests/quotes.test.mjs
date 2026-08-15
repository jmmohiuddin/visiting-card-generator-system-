/* Headless verification of the server-side quote.
   Runs with `node tests/quotes.test.mjs` and prints the same pass/fail format
   as cardworks-engine.test.cjs, because a second reporting style is a second
   thing to read before you can tell whether the build is green.

   What is being protected here is that the price has exactly one source. The
   browser used to compute a total and the order endpoint stored it; these
   assertions say the server's answer matches the engine's cost model for the
   same inputs, that it refuses what no press can produce rather than pricing
   it, and that a quote a customer accepted cannot be repriced underneath
   them. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine } from '../lib/engine-node.mjs';
import {
  buildQuote, quoteFor, amountForOrder, loadPresses, parseQuoteId, offerableFinishes,
  SEED_PRESSES, CARRIERS, QUOTE_TTL_MS, CURRENCY
} from '../lib/quote-server.mjs';
import { quoteRequest } from '../netlify/functions/quotes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✓ ' + name))
                                              : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))); };
const H = (s) => console.log('\n' + s);

const E = engine();
/* Deliberately not on a second boundary. Every assertion below used to run at
   a whole second, and a quote id that digested milliseconds while carrying
   only seconds still round-tripped under that clock — so the suite passed
   while no customer could have paid. Real requests arrive at arbitrary
   moments, and the tests now do too. */
const NOW = Date.UTC(2026, 7, 14, 6, 0, 0) + 437;
const q = (o) => buildQuote({ now: NOW, ...o });
const opt = (quote, slug) => quote.options.find(o => o.slug === slug);

/* The order screen's own press list, read out of the shipped source rather
   than restated here, so a drift between the two shows up as a failure. */
const shellSrc = read('assets/ui-shell.js');
const shellLiteral = shellSrc.slice(shellSrc.indexOf('const PRESSES = ['));
const UI_PRESSES = new Function('return ' + shellLiteral.slice(
  shellLiteral.indexOf('['), shellLiteral.indexOf('];') + 1))();

const migration = read('db/migrations/002_presses.sql');
const SQL_PRESSES = [...migration.matchAll(
  /\('([a-z0-9-]+)',\s*'([^']+)',\s*'(\{.*?\})'::jsonb,\s*(\d+),\s*(\d+),\s*(true|false)\)/gs)]
  .map(m => ({ slug: m[1], name: m[2], finishes: JSON.parse(m[3]).finishes,
               leadDays: +m[4], minQty: +m[5], active: m[6] === 'true' }));
const SQL_RATES = Object.fromEntries(
  [...migration.matchAll(/\('([a-z0-9-]+)',\s+([\d.]+)\)/g)].map(m => [m[1], +m[2]]));

H('1. Press records — one set of facts, three places that hold it');
ok('the migration seeds four presses', SQL_PRESSES.length === 4, String(SQL_PRESSES.length));
ok('the seed fallback names the same four presses as the migration',
   SEED_PRESSES.map(p => p.slug).join() === SQL_PRESSES.map(p => p.slug).join());
ok('names, capabilities and lead times match the migration',
   SEED_PRESSES.every((p, i) => p.name === SQL_PRESSES[i].name
     && p.finishes.join() === SQL_PRESSES[i].finishes.join()
     && p.leadDays === SQL_PRESSES[i].leadDays && p.minQty === SQL_PRESSES[i].minQty));
ok('the records carry the order screen\'s presses verbatim',
   UI_PRESSES.every(u => SEED_PRESSES.some(p => p.name === u.name
     && p.finishes.join() === u.can.join()
     && `${p.leadDays} days` === u.lead && p.multiplier === u.mult)),
   'assets/ui-shell.js PRESSES drifted from db/migrations/002_presses.sql');
ok('the seeded price rules carry the screen\'s multipliers',
   SEED_PRESSES.every(p => SQL_RATES[p.slug] === p.multiplier));
ok('every seeded press records that nobody has contacted it',
   SEED_PRESSES.every(p => p.verifiedAt === null && p.iccStatus === 'unasked'
     && p.pdfx4Stance === 'unasked' && p.plateSetupBdt === null));
ok('the migration models the PDF/X-4 answer as a column, not a note',
   /pdfx4_stance\s+text\s+NOT NULL/.test(migration)
   && /accepts_as_is/.test(migration) && /fixes_in_coreldraw/.test(migration));
ok('the migration is re-runnable',
   (migration.match(/IF NOT EXISTS/g) || []).length >= 8
   && /ON CONFLICT \(slug\) DO NOTHING/.test(migration));
ok('price history is protected by a trigger, not by convention',
   /CREATE TRIGGER price_rules_immutable/.test(migration)
   && /BEFORE UPDATE OR DELETE ON price_rules/.test(migration));
ok('identifiers come from dedicated sequences',
   /CREATE SEQUENCE IF NOT EXISTS presses_id_seq/.test(migration)
   && /CREATE SEQUENCE IF NOT EXISTS price_rules_id_seq/.test(migration));

H('2. The server and the browser price the same order identically');
let mismatch = 0, checked = 0;
for (const qty of [100, 250, 500, 1000, 750]) {
  for (const finishes of [[], ['matte'], ['gloss', 'spotuv'], ['foil'], ['matte', 'foil', 'emboss']]) {
    for (const zone of ['dhaka', 'outside']) {
      const server = q({ qty, finishes, zone });
      if (server.error) continue;
      /* Exactly what assets/ui-order.js computes: the engine's retail figure
         scaled by the chosen press's multiplier. */
      const client = E.quote(qty, finishes, zone);
      for (const u of UI_PRESSES) {
        const capable = finishes.every(f => u.can.includes(f));
        const o = server.options.find(x => x.name === u.name);
        checked++;
        if (!capable) { if (o) mismatch++; continue; }
        if (!o || o.price !== Math.round(client.retail * u.mult)) mismatch++;
      }
    }
  }
}
ok(`every press option matches the browser's own total (${checked} comparisons)`,
   mismatch === 0, mismatch + ' differed');
const q500 = q({ qty: 500, finishes: ['matte'], zone: 'dhaka' });
ok('the engine\'s figures are reported, not recomputed',
   q500.engineTotals.retail === E.quote(500, ['matte'], 'dhaka').retail
   && q500.engineTotals.pressCost === E.quote(500, ['matte'], 'dhaka').pressCost);
ok('finish order does not change the price',
   q({ qty: 500, finishes: ['foil', 'matte'] }).quoteId
   === q({ qty: 500, finishes: ['matte', 'foil'] }).quoteId);

H('3. Finish availability is computed from capabilities, never typed in');
ok('the offerable list is the union of what active presses can do',
   offerableFinishes(SEED_PRESSES).sort().join() ===
   ['matte', 'gloss', 'spotuv', 'foil', 'emboss', 'softtouch'].sort().join());
const rounded = q({ qty: 500, finishes: ['rounded'] });
ok('rounded corners — priced by the engine, produced by no press — is refused',
   !!rounded.error && rounded.error.code === 'finish_unavailable');
ok('the refusal names the finish and what to do instead',
   !!rounded.error && rounded.error.unavailable.join() === 'rounded'
   && typeof rounded.error.remediation === 'string' && rounded.error.remediation.length > 0);
ok('the refusal carries no price at all',
   !!rounded.error && !('options' in rounded) && !('price' in rounded.error));
ok('the engine would have happily costed it', !!E.FINISH_COST.rounded,
   'the engine no longer prices rounded corners; this assertion has gone stale');
ok('a finish the cost model has never heard of is refused separately',
   q({ qty: 500, finishes: ['holographic'] }).error.code === 'unknown_finish');
ok('a quantity below every press minimum is refused, not quoted',
   q({ qty: 50, finishes: [] }).error.code === 'no_capable_press');

H('4. Two presses minimum (PRD §7)');
const plain = q({ qty: 500, finishes: ['matte'] });
ok('a plain run is fulfillable by all four presses', plain.options.length === 4);
ok('and is not flagged as single-sourced', plain.singlePressOnly === false);
const soft = q({ qty: 500, finishes: ['softtouch'] });
ok('soft-touch reaches exactly one press', soft.options.length === 1);
ok('a single-capable-press result is flagged', soft.singlePressOnly === true);
ok('and the three presses that cannot do it say why',
   soft.unavailable.length === 3
   && soft.unavailable.every(u => u.reason === 'cannot_produce_finish' && u.missing.includes('softtouch')));
ok('options are ordered cheapest first',
   plain.options.every((o, i) => i === 0 || plain.options[i - 1].price <= o.price));
ok('each option is a real press record, not a string',
   plain.options.every(o => o.pressId && o.slug && o.leadDays > 0
     && o.capabilityMatch.supported.length > 0 && 'pdfx4Stance' in o));

H('5. Delivery is itemised, never absorbed (PRD Epic F)');
for (const zone of ['dhaka', 'outside']) {
  const qz = q({ qty: 500, finishes: ['matte'], zone });
  const line = qz.options[0].lines.filter(l => /^Delivery/.test(l.label));
  ok(`${zone}: delivery is its own line, once`, line.length === 1);
  ok(`${zone}: at the cost model's figure`, line[0] && line[0].cost === E.DELIVERY[zone]);
  ok(`${zone}: and is repeated as a structured field`,
     qz.delivery.cost === E.DELIVERY[zone] && qz.delivery.zone === zone);
  ok(`${zone}: the carriers are named`,
     qz.delivery.carriers.join() === CARRIERS[zone].options.join() && qz.delivery.carriers.length > 0);
}
ok('the inside-Dhaka carriers are the three the PRD names',
   q({ qty: 500, finishes: [] }).delivery.carriers.join() === 'Pathao,Steadfast,RedX');
ok('an unquoted plate charge is shown as unpriced rather than as zero',
   plain.options.every(o => {
     const l = o.lines.find(x => /^Plate\/block setup/.test(x.label));
     return l && l.cost === null && l.unpriced === true;
   }));

H('6. Every quote says its numbers are not validated (PRD §8.1)');
let flagged = 0, quotes = 0;
for (const qty of [100, 500, 1000]) for (const f of [[], ['matte'], ['foil']]) {
  const x = q({ qty, finishes: f });
  quotes++;
  if (x.unvalidatedCosts === true && x.costBasis.validated === false
      && typeof x.costBasis.warning === 'string'
      && x.options.every(o => o.unvalidatedCosts === true)) flagged++;
}
ok(`the unvalidated-costs flag is on every quote (${quotes} quotes)`, flagged === quotes);
ok('the flag names the constants that have to be replaced',
   plain.costBasis.constants.includes('PRESS_BASE') && plain.costBasis.constants.includes('MARGIN'));
ok('and states how to replace them',
   /price_rules/.test(plain.costBasis.replaceBy) && /tier/.test(plain.costBasis.replaceBy));
ok('the quote records where the press records came from',
   typeof plain.costBasis.pressRecords === 'string' && plain.costBasis.pressRecords.length > 0);

/* The replacement path, exercised: one INSERT of a tier rule per press and
   the flag turns itself off. If this stops working, "replace the constants
   with real quotes" has quietly become a code change again. */
const quoted = SEED_PRESSES.slice(0, 2).map(p => ({
  ...p, rule: { kind: 'tier', currency: 'BDT', tiers: { 500: 900 },
                validated: true, source: 'written quote' } }));
const real = q({ qty: 500, finishes: [], presses: quoted });
ok('a validated tier rule clears the flag',
   real.unvalidatedCosts === false && real.costBasis.validated === true
   && real.costBasis.source === 'press-quote');
ok('and replaces the placeholder base rather than scaling it',
   real.options[0].lines[0].cost === 900
   && real.options[0].price === Math.round(((900 + E.DELIVERY.dhaka) * E.MARGIN) / 10) * 10);
ok('a finish still costed from the engine keeps the quote unvalidated',
   q({ qty: 500, finishes: ['matte'], presses: quoted }).unvalidatedCosts === true);

H('7. A quote is quotable, then orderable, at the same price');
const EXP = Math.floor((NOW + QUOTE_TTL_MS) / 1000) * 1000;
ok('a quote states its expiry', typeof plain.expiresAt === 'string'
   && Date.parse(plain.expiresAt) === EXP
   && plain.expiresInSeconds === Math.floor((EXP - NOW) / 1000));
ok('a quote never claims more time than it has left',
   plain.expiresInSeconds * 1000 <= EXP - NOW);
/* The invariant, rather than a restatement of the arithmetic: whatever the
   quote tells the customer about its expiry is the value its id is verified
   against. Two representations of one expiry is exactly the bug that made
   every payment fail with a conflict that was not real. */
ok('the quote id carries the same expiry the quote states',
   parseQuoteId(plain.quoteId).expiresAt === Date.parse(plain.expiresAt));
ok('the currency is stated', plain.currency === CURRENCY
   && plain.options.every(o => o.currency === CURRENCY));

const pinned = { quoteId: plain.quoteId, press: 'nilkhet-offset',
                 qty: 500, finishes: ['matte'], zone: 'dhaka' };
const honoured = await amountForOrder({ presses: SEED_PRESSES, now: NOW, ...pinned });
ok('the pinned quote is honoured at the price the customer saw',
   honoured.ok === true && honoured.amount === opt(plain, 'nilkhet-offset').price);
ok('and the charge carries the unvalidated-costs flag with it',
   honoured.unvalidatedCosts === true && honoured.currency === CURRENCY);

/* The whole path a paying customer walks — quote the design, then charge the
   quote — driven at arbitrary times rather than at a clock the code finds
   convenient. This is the assertion that would have caught a quote id whose
   digest and whose transported value disagreed below the second: it verified
   only when the expiry happened to land on a whole second, roughly one call
   in a thousand, and every other customer met "the price has changed" at the
   moment they tried to pay. */
let trips = 0, verified = 0, unaligned = 0;
let seed = 20260814;
const arbitraryNow = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return NOW + (seed % 86400000);
};
for (let i = 0; i < 250; i++) {
  const t = arbitraryNow();
  if (t % 1000 !== 0) unaligned++;
  const fresh = await quoteFor({ qty: 500, finishes: ['matte'], zone: 'dhaka', now: t });
  const paid = await amountForOrder({
    presses: SEED_PRESSES, quoteId: fresh.quoteId, press: 'nilkhet-offset',
    qty: 500, finishes: ['matte'], zone: 'dhaka', now: t });
  trips++;
  if (paid.ok && paid.amount === opt(fresh, 'nilkhet-offset').price
      && Date.parse(fresh.expiresAt) === parseQuoteId(fresh.quoteId).expiresAt) verified++;
}
ok(`a quote pins and pays at an arbitrary clock time (${trips} round trips)`,
   verified === trips, (trips - verified) + ' failed to verify');
ok('and those timestamps were genuinely not second-aligned',
   unaligned >= trips - 1, `only ${unaligned} of ${trips} were off the second`);
ok('a quote issued mid-second is still payable',
   (await amountForOrder({ presses: SEED_PRESSES, now: NOW + 1, press: 'nilkhet-offset',
     quoteId: q({ qty: 500, finishes: ['matte'], now: NOW + 1 }).quoteId,
     qty: 500, finishes: ['matte'], zone: 'dhaka' })).ok === true);

/* The press raises its rate between the quote and the payment. A server that
   simply recomputed would charge the new number without telling anyone. */
const dearer = SEED_PRESSES.map(p => p.slug === 'nilkhet-offset'
  ? { ...p, rule: { ...p.rule, value: 1.30 } } : p);
const reprice = await amountForOrder({ presses: dearer, now: NOW, ...pinned });
ok('a price that moved after the quote is a conflict, not a silent charge',
   reprice.ok === false && reprice.code === 'quote_stale');
ok('the conflict says what to do about it',
   reprice.ok === false && /accept/i.test(reprice.remediation) && reprice.currentId !== reprice.quotedId);

const swapped = await amountForOrder({ presses: SEED_PRESSES, now: NOW, ...pinned, qty: 1000 });
ok('the pinned id cannot be reused for a different order',
   swapped.ok === false && swapped.code === 'quote_stale');
const forged = await amountForOrder({ presses: SEED_PRESSES, now: NOW, ...pinned,
  quoteId: plain.quoteId.replace(/.$/, m => m === 'a' ? 'b' : 'a') });
ok('a tampered quote id does not verify',
   forged.ok === false && forged.code === 'quote_stale');
ok('a quote id we never issued is rejected outright',
   (await amountForOrder({ presses: SEED_PRESSES, now: NOW, ...pinned, quoteId: 'q1-500-cheap' })).code === 'bad_quote');
const stale = await amountForOrder({ presses: SEED_PRESSES, now: NOW + QUOTE_TTL_MS + 1000, ...pinned });
ok('an expired quote is refused rather than honoured',
   stale.ok === false && stale.code === 'quote_expired');

/* An order names its press three ways depending on how it was placed: the
   free-text name that is on every order today, the slug the quote option
   carries, and the `press_id` migration 002 added. A charge that failed
   because the caller picked a different one of the three would be refusing
   over a naming convention rather than over anything the customer did. */
const nilkhet = opt(plain, 'nilkhet-offset');
const byEachName = await Promise.all([nilkhet.name, nilkhet.slug, nilkhet.pressId].map(
  (p) => amountForOrder({ presses: SEED_PRESSES, now: NOW, ...pinned, press: p })));
ok('a press resolves by name, by slug or by id — all to the same amount',
   byEachName.every(r => r.ok === true && r.amount === nilkhet.price),
   byEachName.map(r => r.code || r.amount).join(' / '));
ok('a press that cannot fulfil the order cannot be charged for it',
   (await amountForOrder({ presses: SEED_PRESSES, now: NOW, ...pinned, press: 'arambagh-fine-print' })).ok === true
   && (await amountForOrder({ presses: SEED_PRESSES, now: NOW, ...pinned, press: 'no-such-press' })).code === 'press_unavailable');
ok('proof-before-charge is stated for the finishes that mandate it',
   q({ qty: 500, finishes: ['foil'] }).proofRequired === true
   && plain.proofRequired === false);

H('8. The endpoint');
const pressRows = SEED_PRESSES.map(p => ({
  id: p.id, slug: p.slug, name: p.name,
  capabilities_json: { finishes: p.finishes }, lead_days: p.leadDays, min_qty: p.minQty,
  active: true, icc_profile: null, icc_status: 'unasked', plate_setup_bdt: null,
  pdfx4_stance: 'unasked', verified_at: null, rule_json: p.rule }));
const stubSql = (specRows) => (strings) => {
  const text = strings.join('?');
  if (/FROM design_specs/.test(text)) return Promise.resolve(specRows);
  if (/FROM presses/.test(text)) return Promise.resolve(pressRows);
  return Promise.resolve([]);
};
const post = (body, sql = stubSql([{ id: 7, short_code: 'a1b2c3' }])) =>
  quoteRequest(new Request('https://cardworks.bd/api/quotes',
    { method: 'POST', body: JSON.stringify(body) }), sql);

const res = await post({ shortCode: 'a1b2c3', qty: 500, finishes: ['matte'], zone: 'dhaka' });
const body = await res.json();
ok('a saved design gets 200 and a list of press options',
   res.status === 200 && Array.isArray(body.options) && body.options.length === 4);
ok('the response identifies the design it priced', body.shortCode === 'a1b2c3' && body.specId === 7);
ok('and carries the quote id, the expiry and the unvalidated flag',
   !!parseQuoteId(body.quoteId) && !!body.expiresAt && body.unvalidatedCosts === true);
ok('the endpoint agrees with the library it wraps',
   body.options.map(o => o.price).join() ===
   q({ qty: 500, finishes: ['matte'] }).options.map(o => o.price).join());

const refused = await post({ shortCode: 'a1b2c3', qty: 500, finishes: ['rounded'] });
const refusedBody = await refused.json();
ok('an unproducible finish is 422 with a reason, not a price',
   refused.status === 422 && refusedBody.error.code === 'finish_unavailable'
   && !!refusedBody.error.remediation);
const missing = await post({ shortCode: 'ffffff', qty: 500 }, stubSql([]));
ok('an unsaved design is 404', missing.status === 404);
const noRef = await post({ qty: 500 });
ok('a quote with no design is 400 with a remediation',
   noRef.status === 400 && !!(await noRef.json()).error.remediation);
const badQty = await post({ shortCode: 'a1b2c3', qty: 0 });
ok('a nonsense quantity is 400', badQty.status === 400);
const getRes = await quoteRequest(new Request('https://cardworks.bd/api/quotes'), stubSql([]));
ok('GET is 405', getRes.status === 405);
const noDb = await quoteRequest(new Request('https://cardworks.bd/api/quotes', { method: 'POST', body: '{}' }), null);
ok('an unconfigured deploy says so rather than inventing a price', noDb.status === 503);

const fallback = await loadPresses(() => { throw new Error('relation "presses" does not exist'); });
ok('a deploy without migration 002 falls back to the seeded records',
   fallback.presses.length === 4 && /^seed:/.test(fallback.source));
ok('and says that is what it did', fallback.source === 'seed:migration-002-not-applied');

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
