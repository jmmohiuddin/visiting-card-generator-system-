/* The authoritative quote.
 *
 * Until now the browser computed a total and `orders.mjs` stored whatever
 * number arrived with the request (Technical Design §10 item 2). This module
 * is the server's own answer, and it is the only one an order is allowed to
 * be charged against.
 *
 * It does not reimplement the arithmetic. `assets/engine.js` already models
 * cost as press base + finish setup + per-unit finish + delivery + margin,
 * and that file is read-only for everyone precisely so there is one cost
 * model rather than a browser one and a server one that drift. This layers
 * two things over it that the engine has no business knowing: which presses
 * exist and what each of them can actually produce, and which prices a
 * particular press has agreed to.
 *
 * The numbers underneath are still guesses. PRD §8.1 makes replacing them
 * with written quotes from three Dhaka presses a precondition for showing a
 * price to a customer, so every quote this returns carries a machine-readable
 * flag saying so, and the replacement path is one INSERT into `price_rules`
 * rather than an edit to this file.
 */
import crypto from 'node:crypto';
import { engine } from './engine-node.mjs';

export const CURRENCY = 'BDT';
export const QUOTE_VERSION = 'q1';

/* A quote is honoured for a day. Long enough that a customer can think it
   over and come back, short enough that a real press quote landing in
   `price_rules` reaches customers within a day of being entered. */
export const QUOTE_TTL_MS = 24 * 60 * 60 * 1000;

/* PRD §7: proof-before-charge is mandatory for these, because they are the
   finishes where a bad plate is discovered only on paper. */
export const PROOF_MANDATORY_FINISHES = ['foil', 'emboss', 'letterpress', 'edgepaint'];

/* PRD Epic F names the three inside-Dhaka carriers. Nothing outside Dhaka has
   been contracted yet, so that list is marked as the placeholder it is rather
   than being quietly presented as a delivery network we have. */
export const CARRIERS = {
  dhaka:   { label: 'Inside Dhaka',   options: ['Pathao', 'Steadfast', 'RedX'], contracted: false },
  outside: { label: 'Outside Dhaka',  options: ['Steadfast', 'RedX'],           contracted: false }
};

/* The same four presses `db/migrations/002_presses.sql` seeds, so a deploy
   whose migration has not been applied yet quotes the same way the order
   screen already does instead of failing or, worse, quoting from nothing.
   `tests/quotes.test.mjs` asserts these three sources have not drifted. */
export const SEED_PRESSES = [
  { slug: 'nilkhet-offset',       name: 'Nilkhet Offset, Dhaka',       finishes: ['matte','gloss','spotuv'],                            leadDays: 3, multiplier: 0.92 },
  { slug: 'fakirapool-press',     name: 'Fakirapool Press, Motijheel', finishes: ['matte','gloss','spotuv','foil'],                     leadDays: 4, multiplier: 1.00 },
  { slug: 'banglabazar-printers', name: 'Banglabazar Printers',        finishes: ['matte','gloss','foil','emboss'],                     leadDays: 5, multiplier: 1.04 },
  { slug: 'arambagh-fine-print',  name: 'Arambagh Fine Print',         finishes: ['matte','gloss','softtouch','spotuv','foil','emboss'],leadDays: 7, multiplier: 1.18 }
].map((p, i) => ({
  id: 100 + i, ...p, minQty: 100, active: true,
  iccProfile: null, iccStatus: 'unasked', plateSetupBdt: null,
  pdfx4Stance: 'unasked', verifiedAt: null,
  rule: { kind: 'multiplier', value: p.multiplier, validated: false,
          source: 'assets/ui-shell.js PRESSES literal — no press has been contacted' }
}));

/** Normalise a `presses` row (joined to its open price rule) into the shape
 *  the quote builder reads, so a seeded record and a database record are
 *  indistinguishable downstream. */
export function pressFromRow(row) {
  const rule = row.rule_json || row.rule || null;
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    finishes: (row.capabilities_json && row.capabilities_json.finishes) || [],
    leadDays: Number(row.lead_days),
    minQty: Number(row.min_qty),
    active: row.active !== false,
    iccProfile: row.icc_profile || null,
    iccStatus: row.icc_status || 'unasked',
    plateSetupBdt: row.plate_setup_bdt == null ? null : Number(row.plate_setup_bdt),
    pdfx4Stance: row.pdfx4_stance || 'unasked',
    verifiedAt: row.verified_at || null,
    rule: rule ? { ...rule, value: rule.value == null ? null : Number(rule.value) } : null
  };
}

/** Active presses with the price rule in force right now.
 *
 *  A missing table or an unseeded one falls back to `SEED_PRESSES` rather
 *  than failing the request, because a deploy that is one migration behind
 *  should quote the same numbers the order screen is already showing, not
 *  refuse to quote at all. The source is reported so the caller can say which
 *  happened instead of guessing. */
export async function loadPresses(sql) {
  if (!sql) return { presses: SEED_PRESSES, source: 'seed:no-database' };
  try {
    const rows = await sql`
      SELECT p.*, (SELECT r.rule_json FROM price_rules r
                    WHERE r.press_id = p.id AND r.valid_to IS NULL
                      AND r.valid_from <= now()
                    ORDER BY r.valid_from DESC LIMIT 1) AS rule_json
      FROM presses p WHERE p.active ORDER BY p.lead_days, p.id`;
    if (!rows.length) return { presses: SEED_PRESSES, source: 'seed:no-rows' };
    return { presses: rows.map(pressFromRow), source: 'db' };
  } catch {
    return { presses: SEED_PRESSES, source: 'seed:migration-002-not-applied' };
  }
}

const err = (code, message, extra = {}) => ({ error: { code, message, ...extra } });
const money = (n) => Math.round(n);

/** Every finish at least one active press can produce. This is the list the
 *  order screen is allowed to offer; anything else is not a choice we can
 *  honour, however cleanly the engine prices it. */
export const offerableFinishes = (presses) => {
  const seen = new Set();
  for (const p of presses) if (p.active !== false) for (const f of p.finishes) seen.add(f);
  return [...seen];
};

/** Apply a press's price rule on top of the engine's figures.
 *
 *  A `multiplier` rule scales a placeholder, so what comes out is still a
 *  placeholder. A `tier` rule carries a written quote and substitutes it for
 *  the engine's placeholder `PRESS_BASE` — the rest of the model (finish
 *  costs, delivery, margin) is untouched, so replacing one guess replaces
 *  exactly one guess. That substitution is the only way `validated` ever
 *  becomes true, and even then only for a plain run: `FINISH_COST` lives in
 *  the engine and is still a guess, so a run carrying a finish stays
 *  unvalidated until those numbers are quoted too. */
function applyRule(rule, { qty, base, deliveryCost, finishes, MARGIN }) {
  if (rule && rule.kind === 'tier' && rule.tiers) {
    const tiers = Object.keys(rule.tiers).map(Number).sort((a, b) => a - b);
    const band = tiers.filter(t => t <= qty).pop() ?? tiers[0];
    const printing = Number(rule.tiers[band]) * (band === qty ? 1 : qty / band);
    /* Everything the engine charged that was not the print run itself. */
    const finishCost = base.pressCost - base.lines[0].cost - deliveryCost;
    const cost = printing + finishCost + deliveryCost;
    return {
      price: Math.round((cost * MARGIN) / 10) * 10,
      pressCost: money(cost),
      printingCost: money(printing),
      basis: `written press quote for ${band} cards${band === qty ? '' : `, scaled to ${qty}`}`,
      validated: rule.validated === true && finishes.length === 0,
      label: 'Press quote'
    };
  }
  const mult = rule && rule.kind === 'multiplier' && rule.value != null ? Number(rule.value) : 1;
  return {
    /* The order screen has always scaled the retail figure by the press rate,
       so the server scales the same figure: a server that quietly rounded at
       a different point would report a different price for the same order. */
    price: money(base.retail * mult),
    pressCost: money(base.pressCost * mult),
    printingCost: null,
    /* No rule on record is not the same as a rate of exactly 1.00 — it means
       this press has never agreed a price with us — so the two say so
       differently rather than both reading as a settled rate. */
    basis: !rule ? 'engine cost model; this press has no price rule on record'
         : mult === 1 ? 'engine cost model, no press adjustment'
                      : `engine cost model × ${mult} press rate`,
    validated: false,
    multiplier: mult,
    label: 'Press rate'
  };
}

/**
 * Build a quote.
 *
 * Returns `{ error: { code, message, … } }` when the request cannot be
 * priced honestly — an unknown finish, or one no active press can produce —
 * and the full quote otherwise. It never prices something it cannot fulfil.
 */
export function buildQuote({
  presses = SEED_PRESSES, qty, finishes = [], zone = 'dhaka',
  now = Date.now(), expiresAt = null, pressSource = 'seed'
} = {}) {
  const E = engine();
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1 || n > 100000)
    return err('bad_request', 'Quantity must be a whole number between 1 and 100000.',
               { field: 'qty', remediation: 'Choose one of the standard runs: 100, 250, 500 or 1000.' });
  if (zone !== 'dhaka' && zone !== 'outside')
    return err('bad_request', 'Delivery zone must be "dhaka" or "outside".', { field: 'zone' });
  if (!Array.isArray(finishes))
    return err('bad_request', 'Finishes must be a list.', { field: 'finishes' });

  /* Canonical order, so the same set of finishes always produces the same
     quote and therefore the same quote id whatever order they were picked
     in. Duplicates collapse for the same reason. */
  const known = Object.keys(E.FINISH_COST);
  const wanted = known.filter(f => finishes.includes(f));
  const unknown = [...new Set(finishes)].filter(f => !known.includes(f));
  if (unknown.length)
    return err('unknown_finish', `The cost model has no finish called "${unknown[0]}".`,
               { field: 'finishes', unknown,
                 remediation: 'Pick a finish from the offered list.', offerable: offerableFinishes(presses) });

  const live = presses.filter(p => p.active !== false);
  const offerable = offerableFinishes(live);
  /* Finish availability is a property of the presses, not of the screen. The
     engine will happily price rounded corners; no press in the table has said
     it can cut them, so it is not something we can sell. */
  const unproducible = wanted.filter(f => !offerable.includes(f));
  if (unproducible.length)
    return err('finish_unavailable',
               `No active press can produce ${unproducible.map(f => E.FINISH_COST[f].label).join(' or ')}.`,
               { field: 'finishes', unavailable: unproducible, offerable,
                 remediation: 'Remove that finish, or wait until a press that offers it is onboarded.' });

  const base = E.quote(n, wanted, zone);
  const deliveryCost = E.DELIVERY[zone];
  const carriers = CARRIERS[zone];

  /* Delivery is its own line and stays its own line (PRD Epic F). The engine
     already emits one; it is lifted out here so it can never be folded into a
     press subtotal by a caller that only reads the total. */
  const delivery = {
    label: `Delivery — ${carriers.label}`,
    zone, cost: deliveryCost,
    carriers: carriers.options,
    carriersContracted: carriers.contracted,
    unvalidated: true
  };

  const options = [], unavailable = [];
  for (const p of live) {
    const missing = wanted.filter(f => !p.finishes.includes(f));
    if (missing.length) {
      unavailable.push({ slug: p.slug, name: p.name, reason: 'cannot_produce_finish',
                         missing, note: `Cannot produce ${missing.map(f => E.FINISH_COST[f].label).join(', ')}.` });
      continue;
    }
    if (n < p.minQty) {
      unavailable.push({ slug: p.slug, name: p.name, reason: 'below_minimum_run',
                         minQty: p.minQty, note: `Minimum run is ${p.minQty} cards.` });
      continue;
    }

    const applied = applyRule(p.rule, { qty: n, base, deliveryCost, finishes: wanted, MARGIN: E.MARGIN });
    /* The engine's own itemisation — printing, each finish, then delivery —
       is what the press charges, and it is carried through per option rather
       than summarised, so the delivery line survives all the way to the
       screen instead of being folded into a subtotal (PRD Epic F). An
       unquoted plate charge is appended as a line with a null cost, because
       "not quoted" and "free" are different answers and a total that treats
       them alike is understating the price. */
    const lines = base.lines.map(l => ({ ...l }));
    if (applied.printingCost != null) lines[0] = { ...lines[0], cost: applied.printingCost };
    lines.push({ label: `Plate/block setup — ${p.name}`,
                 cost: p.plateSetupBdt, unpriced: p.plateSetupBdt == null });

    const price = applied.price + (p.plateSetupBdt || 0);
    options.push({
      pressId: p.id, slug: p.slug, name: p.name,
      price, currency: CURRENCY,
      unit: +(price / n).toFixed(2),
      leadDays: p.leadDays, leadTime: `${p.leadDays} working days`,
      lines, delivery,
      /* What the customer pays is the press's cost plus our margin, and the
         two are reported separately so an operator can see which of them a
         change moved. */
      pricing: {
        pressCost: applied.pressCost,
        marginMultiplier: E.MARGIN,
        pressRate: applied.multiplier ?? null,
        priceBeforeSetup: applied.price,
        plateSetup: p.plateSetupBdt,
        price
      },
      capabilityMatch: { requested: wanted, supported: p.finishes, missing: [] },
      minQty: p.minQty,
      colourProfile: { icc: p.iccProfile, status: p.iccStatus },
      /* Routing, not trivia: a press that reopens the file in CorelDRAW
         discards the outlined type and spot separations the print-correct
         guarantee depends on (PRD §7). */
      pdfx4Stance: p.pdfx4Stance,
      plateSetupBdt: p.plateSetupBdt,
      pressVerified: !!p.verifiedAt,
      priceBasis: applied.basis,
      unvalidatedCosts: !applied.validated
    });
  }

  if (!options.length)
    return err('no_capable_press',
               'No active press can print this order as specified.',
               { field: 'finishes', unavailable,
                 remediation: 'Drop a finish or lower the quantity, and quote again.' });

  options.sort((a, b) => a.price - b.price || a.leadDays - b.leadDays);

  /* PRD §7 requires two presses minimum for any order so that one press's
     rejection or delay never blocks it. A quote that only one press can
     fulfil is still returned — refusing the order outright helps nobody —
     but it says so, because whoever accepts it is accepting a single point
     of failure and should be told that before the run, not during it. */
  const singlePressOnly = options.length < 2;

  const unvalidatedCosts = options.some(o => o.unvalidatedCosts);
  /* Truncated to whole seconds here, where the expiry is decided, and never
     anywhere else. The quote id can only carry seconds, so a millisecond
     expiry would be one value on the quote and a different one in the id it
     is verified against — and rebuilding the quote at payment time would then
     digest an expiry the customer's id never held. The customer would be told
     the price had changed at the moment they tried to pay, which is the worst
     possible place in the funnel for a conflict that is not real. One value,
     decided once, is what makes that impossible rather than unlikely. */
  const exp = Math.floor((expiresAt != null ? Number(expiresAt) : now + QUOTE_TTL_MS) / 1000) * 1000;

  const quote = {
    quoteId: null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(exp).toISOString(),
    // Floored, so a quote never claims more time than it actually has left.
    expiresInSeconds: Math.max(0, Math.floor((exp - now) / 1000)),
    currency: CURRENCY,
    qty: n, finishes: wanted, zone,
    delivery,
    offerableFinishes: offerable,
    options, unavailable,
    singlePressOnly,
    proofRequired: wanted.some(f => PROOF_MANDATORY_FINISHES.includes(f)),
    /* The flag PRD §8.1 exists to force. It is machine-readable and it is on
       every quote, so no surface can render a price without having had the
       chance to say where the number came from. */
    unvalidatedCosts,
    costBasis: {
      validated: !unvalidatedCosts,
      source: unvalidatedCosts ? 'placeholder-constants' : 'press-quote',
      constants: unvalidatedCosts
        ? ['PRESS_BASE', 'FINISH_COST', 'DELIVERY', 'MARGIN', 'price_rules.multiplier']
        : [],
      pressRecords: pressSource,
      warning: unvalidatedCosts
        ? 'Estimate. No Dhaka press has been contacted; these constants must be replaced with written quotes before a price is shown to a customer (PRD §8.1).'
        : null,
      replaceBy: 'INSERT a price_rules row of kind "tier" with the written quote and "validated": true.'
    },
    engineTotals: { pressCost: base.pressCost, retail: base.retail, marginPct: base.marginPct }
  };

  quote.quoteId = quoteId(quote, exp);
  return quote;
}

/* ── Pinning ──────────────────────────────────────────────────────────────
   A quote has to survive the walk from the quote screen to the order screen
   unchanged, or the price a customer saw is not the price they are charged.
   There is no `quotes` table doing that here: the id is a digest of the
   quote's own inputs and outputs plus its expiry, so re-deriving it at order
   time either reproduces the same id — proving nothing moved — or does not,
   which is a repricing and is reported as one. A stored row could be edited;
   a digest of the priced result cannot be edited into agreeing.

   The digest is keyed with QUOTE_SECRET when one is configured, which stops
   ids minted by one deploy from being replayed against another. */
const digest = (payload) => {
  const secret = process.env.QUOTE_SECRET;
  const h = secret ? crypto.createHmac('sha256', secret) : crypto.createHash('sha256');
  return h.update(payload).digest('hex').slice(0, 32);
};

/* The digested expiry and the transported expiry are the same expression, so
   the two cannot drift apart: anything that digests one representation of a
   value while transporting another verifies against a value it never sent. */
function quoteId(q, exp) {
  const seconds = Math.floor(exp / 1000);
  const payload = JSON.stringify([
    QUOTE_VERSION, seconds, q.qty, q.finishes, q.zone, q.delivery.cost,
    q.options.map(o => [o.slug, o.price, o.leadDays]),
    q.costBasis.validated
  ]);
  return `${QUOTE_VERSION}_${seconds}_${digest(payload)}`;
}

/** Split a quote id back into its parts, or null if it is not one of ours. */
export function parseQuoteId(id) {
  const m = /^([a-z0-9]+)_(\d{9,12})_([0-9a-f]{32})$/.exec(String(id || ''));
  if (!m || m[1] !== QUOTE_VERSION) return null;
  return { version: m[1], expiresAt: Number(m[2]) * 1000, digest: m[3] };
}

/**
 * The amount an order may be charged, for a quote the customer accepted.
 *
 * This is what `netlify/functions/payments.mjs` charges against: never a
 * client-supplied total, and never a freshly computed one either, because a
 * fresh computation would silently absorb any price change between the quote
 * and the payment. The quote is rebuilt from the same inputs against the same
 * expiry and the id has to come out identical; if it does not, the price
 * moved and that is a conflict for a human to resolve, not a rounding
 * difference to swallow.
 *
 * Returns `{ ok: true, amount, currency, unvalidatedCosts, option, quote }`
 * or `{ ok: false, code, message, remediation }`.
 */
export async function amountForOrder({
  sql = null, presses = null, quoteId: id, press,
  qty, finishes = [], zone = 'dhaka', now = Date.now()
} = {}) {
  const parsed = parseQuoteId(id);
  if (!parsed)
    return { ok: false, code: 'bad_quote', message: 'That is not a quote reference we issued.',
             remediation: 'Request a fresh quote before placing the order.' };
  if (parsed.expiresAt <= now)
    return { ok: false, code: 'quote_expired',
             message: 'That quote has expired.',
             expiredAt: new Date(parsed.expiresAt).toISOString(),
             remediation: 'Request a fresh quote; prices may have changed.' };

  let source = 'seed';
  let list = presses;
  if (!list) { const loaded = await loadPresses(sql); list = loaded.presses; source = loaded.source; }

  const fresh = buildQuote({ presses: list, qty, finishes, zone, now,
                             expiresAt: parsed.expiresAt, pressSource: source });
  if (fresh.error)
    return { ok: false, code: fresh.error.code, message: fresh.error.message,
             remediation: fresh.error.remediation ||
               'This order can no longer be quoted as specified. Quote it again.' };

  if (fresh.quoteId !== id)
    return { ok: false, code: 'quote_stale',
             message: 'The price for this order has changed since it was quoted.',
             quotedId: id, currentId: fresh.quoteId,
             remediation: 'Show the customer the new quote and have them accept it before charging.' };

  /* An order identifies its press three ways depending on how old it is: the
     free-text name it was placed with, the slug a quote option carries, or
     the `press_id` migration 002 added. All three resolve, because a payment
     that cannot find the press it is for would refuse a charge over a naming
     convention rather than over anything the customer did. */
  const key = String(press ?? '');
  const option = fresh.options.find(o =>
    o.slug === key || o.name === key || (/^\d+$/.test(key) && o.pressId === Number(key)));
  if (!option)
    return { ok: false, code: 'press_unavailable',
             message: 'That press cannot fulfil this order.',
             options: fresh.options.map(o => o.slug),
             remediation: 'Pick one of the presses the quote offered.' };

  return {
    ok: true,
    amount: option.price,
    currency: CURRENCY,
    /* Carried through to the charge so no payment surface can present a
       placeholder as a settled price without knowing that it is one. */
    unvalidatedCosts: option.unvalidatedCosts,
    proofRequired: fresh.proofRequired,
    option, quote: fresh
  };
}

/** One call for the endpoint: load the presses, then price the order. */
export async function quoteFor({ sql = null, qty, finishes = [], zone = 'dhaka', now = Date.now() } = {}) {
  const { presses, source } = await loadPresses(sql);
  return buildQuote({ presses, qty, finishes, zone, now, pressSource: source });
}
