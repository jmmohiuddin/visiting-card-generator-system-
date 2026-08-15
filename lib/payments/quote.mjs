/* Where the number that gets charged comes from.
 *
 * Today `orders.mjs` takes `total` out of the request body and stores it. That
 * is a trust hole with a price tag on it: anyone who can post to the endpoint
 * can order a thousand cards for one taka. Nothing in this directory ever
 * reads an amount off a request. The amount is whatever the server can compute
 * or has already recorded, and the client's opinion of it is at most a claim to
 * be checked and logged.
 *
 * Subgroup A4's quote engine at lib/quote-server.mjs is the authority when it
 * is present. Its `amountForOrder` rebuilds the quote from the order's own
 * inputs and checks that the quote id comes out identical, so a price that
 * moved between quoting and paying is a conflict a human resolves rather than
 * a difference this code silently absorbs in one direction or the other.
 *
 * The import stays guarded, and so does the presence of `orders.quote_id`,
 * because an order placed before A4's migration ran has no quote to rebuild.
 * Those fall back to the order's own stored total — which is not a fix for the
 * trust hole on its own, only a narrowing of it, and it is why `source` is
 * recorded on every payment. A payment charged against 'order-total' is a
 * payment whose amount an older client could still have chosen.
 */

let quoteServer;                 // undefined until probed, null once known absent

async function loadQuoteServer() {
  if (quoteServer !== undefined) return quoteServer;
  try {
    const mod = await import('../quote-server.mjs');
    quoteServer = typeof mod.amountForOrder === 'function' ? mod : null;
    if (!quoteServer)
      console.warn('[payments] lib/quote-server.mjs exports no amountForOrder; using the stored order total.');
  } catch {
    quoteServer = null;          // not built in this checkout
  }
  return quoteServer;
}

export class QuoteError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The authoritative amount for an order, in integer taka.
 * `sql` is optional and only used to reach the quote engine; without it the
 * order's own recorded total stands in.
 * Returns { amount, currency, source, unvalidatedCosts, proofRequired }.
 */
export async function amountFor(store, orderRef, sql = null) {
  const order = await store.getOrder(orderRef);
  if (!order) throw new QuoteError('order_not_found', 'That order does not exist.');

  if (sql && order.quote_id) {
    const qs = await loadQuoteServer();
    if (qs) {
      const q = await qs.amountForOrder({
        sql, quoteId: order.quote_id, press: order.press, qty: order.qty,
        finishes: Array.isArray(order.finishes) ? order.finishes : [],
        zone: order.zone || 'dhaka'
      });
      /* A4 reports a moved price, an expired quote or an unavailable press as
         a refusal with its own code and remediation. Passing those through
         untranslated is the point: the order screen already knows how to
         render that envelope, and inventing a payment-flavoured message for
         "your quote expired" would only lose the remediation. */
      if (!q.ok) throw new QuoteError(q.code, q.message,
        { remediation: q.remediation, ...(q.currentId ? { currentId: q.currentId } : {}) });
      const amount = Math.round(Number(q.amount));
      if (!Number.isFinite(amount) || amount <= 0)
        throw new QuoteError('quote_unavailable', 'The server could not price this order.');
      /* `proofRequired` comes back true for foil and emboss. Nothing here
         acts on it — the charge point is already `awaiting_approval`, which
         sits downstream of proof_printed and proof_delivered, so a proof was
         held before any of these rails were reached. It is carried into the
         ledger because a finish that demanded a physical proof is worth being
         able to see against the payment afterwards. */
      return {
        amount, currency: q.currency || 'BDT', source: 'quote-server',
        unvalidatedCosts: !!q.unvalidatedCosts, proofRequired: !!q.proofRequired
      };
    }
  }

  const amount = Math.round(Number(order.total));
  if (!Number.isFinite(amount) || amount <= 0)
    throw new QuoteError('quote_unavailable', 'That order has no priced total to charge.');
  return { amount, currency: order.currency || 'BDT', source: 'order-total',
           unvalidatedCosts: false, proofRequired: false };
}

/** True when the caller sent an amount that is not the server's. Recorded, not
 *  obeyed — a mismatch is worth seeing in the ledger even though it changes
 *  nothing about what is charged. */
export const claimDiffers = (claimed, authoritative) => {
  const n = Number(claimed);
  return Number.isFinite(n) && Math.round(n) !== authoritative;
};
