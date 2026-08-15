/* Every database statement the payment flow issues, and nothing else.
 *
 * The orchestration in index.mjs is the part that has to be right — that a
 * capture cannot happen before approval, that a retry is not a second charge,
 * that a provider success we failed to record becomes an incident and a
 * refund. Keeping the SQL behind a named interface means that logic can be
 * driven against an in-memory store in tests without a Postgres, and it means
 * the two constraints that actually protect the money are asserted in both
 * implementations rather than only in the one nobody runs.
 *
 * `createMemoryStore` is shipped code, not a test fixture, precisely so those
 * constraints stay in step with db/migrations/003_payments.sql. If the unique
 * index there changes, this file has to change with it or the tests stop
 * describing production.
 */

/** A store rejection we recognise, as opposed to a database being down. */
export class StoreConflict extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'StoreConflict';
    this.code = code;
    this.detail = detail;
  }
}

const CAPTURED = new Set(['captured', 'partially_refunded', 'refunded']);
const isUnique = (e) => e && (e.code === '23505' || /duplicate key value/i.test(e.message || ''));

/* The same transition table the payments_guard trigger enforces in
   db/migrations/003_payments.sql, kept here so the memory store refuses what
   Postgres would refuse. Without it the two drift, and the way that shows up
   is a test passing on a path the database would have rejected — which is
   worse than no test. A payment that failed cannot become refunded: there was
   nothing recorded to refund, and the money going back is a refunds row
   pointing at it, not a rewrite of what it was. */
const NEXT = {
  intent: new Set(['captured', 'failed', 'cancelled']),
  captured: new Set(['partially_refunded', 'refunded']),
  partially_refunded: new Set(['refunded'])
};
const legal = (from, to) => from === to || !!(NEXT[from] && NEXT[from].has(to));

/* ── Postgres ───────────────────────────────────────────────────────────── */

export function createStore(sql) {
  return {
    /* The whole row, because pricing an order through lib/quote-server.mjs
       needs its qty, press, finishes, zone and quote_id, and naming those
       columns here would break on a deploy where A4's migration has not run
       yet. */
    async getOrder(ref) {
      const rows = await sql`SELECT * FROM orders WHERE ref = ${ref} LIMIT 1`;
      return rows.length ? rows[0] : null;
    },

    /* Guarded by the order's current status so two concurrent approvals cannot
       both believe they moved it. The row count is the answer. */
    async advanceOrder(ref, from, to) {
      const rows = await sql`
        UPDATE orders SET status = ${to}
        WHERE ref = ${ref} AND status = ${from}
        RETURNING ref, status`;
      return rows.length > 0;
    },

    async addOrderEvent(ref, type, actor, note) {
      await sql`INSERT INTO order_events (order_ref, type, actor, note)
                VALUES (${ref}, ${type}, ${actor}, ${note || null})`;
    },

    async paymentByKey(orderRef, captureKey) {
      const rows = await sql`
        SELECT * FROM payments WHERE order_ref = ${orderRef} AND capture_key = ${captureKey} LIMIT 1`;
      return rows.length ? rows[0] : null;
    },

    async paymentByProviderRef(provider, providerRef) {
      const rows = await sql`
        SELECT * FROM payments WHERE provider = ${provider} AND provider_ref = ${providerRef}
        ORDER BY id DESC LIMIT 1`;
      return rows.length ? rows[0] : null;
    },

    async paymentsFor(orderRef) {
      return await sql`SELECT * FROM payments WHERE order_ref = ${orderRef} ORDER BY id`;
    },

    async capturedPayment(orderRef) {
      const rows = await sql`
        SELECT * FROM payments
        WHERE order_ref = ${orderRef} AND status IN ('captured','partially_refunded','refunded')
        LIMIT 1`;
      return rows.length ? rows[0] : null;
    },

    /* Opens the local slot *before* the provider is called, so a charge can
       never exist upstream with no trace of it here. A duplicate key means a
       concurrent attempt won the race and its row is the one to use. */
    async openIntent(p) {
      try {
        const rows = await sql`
          INSERT INTO payments (order_ref, provider, provider_ref, amount, currency,
                                capture_key, status, simulated)
          VALUES (${p.orderRef}, ${p.provider}, ${p.providerRef || null}, ${p.amount},
                  ${p.currency || 'BDT'}, ${p.captureKey}, 'intent', ${!!p.simulated})
          RETURNING *`;
        return rows[0];
      } catch (e) {
        if (isUnique(e)) throw new StoreConflict('duplicate_capture_key', 'This capture key is already in flight.');
        throw e;
      }
    },

    async attachProviderRef(id, providerRef) {
      const rows = await sql`
        UPDATE payments SET provider_ref = ${providerRef} WHERE id = ${id} AND status = 'intent'
        RETURNING *`;
      return rows.length ? rows[0] : null;
    },

    /* The one that must not be allowed to happen twice. The partial unique
       index on (order_ref) WHERE status is a captured state is what refuses
       the second one; a conflict here is the reconciliation case, not a bug. */
    async markCaptured(id, providerTxn) {
      try {
        const rows = await sql`
          UPDATE payments SET status = 'captured', provider_txn = ${providerTxn}
          WHERE id = ${id} AND status = 'intent'
          RETURNING *`;
        if (!rows.length)
          throw new StoreConflict('not_capturable', 'That payment is no longer an open intent.');
        return rows[0];
      } catch (e) {
        if (isUnique(e))
          throw new StoreConflict('already_captured', 'This order already holds a captured payment.');
        throw e;
      }
    },

    async markFailed(id, failureCode) {
      const rows = await sql`
        UPDATE payments SET status = 'failed', failure_code = ${String(failureCode || 'unknown').slice(0, 64)}
        WHERE id = ${id} AND status = 'intent'
        RETURNING *`;
      return rows.length ? rows[0] : null;
    },

    async markCancelled(id) {
      const rows = await sql`
        UPDATE payments SET status = 'cancelled' WHERE id = ${id} AND status = 'intent' RETURNING *`;
      return rows.length ? rows[0] : null;
    },

    async addEvent(e) {
      await sql`
        INSERT INTO payment_events (payment_id, order_ref, type, actor, detail)
        VALUES (${e.paymentId || null}, ${e.orderRef}, ${e.type}, ${e.actor || 'system'},
                ${JSON.stringify(e.detail || {})}::jsonb)`;
    },

    async eventsFor(orderRef) {
      return await sql`
        SELECT payment_id, type, actor, detail, created_at FROM payment_events
        WHERE order_ref = ${orderRef} ORDER BY id`;
    },

    async openRefund(r) {
      const existing = await sql`
        SELECT * FROM refunds WHERE payment_id = ${r.paymentId} AND refund_key = ${r.refundKey} LIMIT 1`;
      if (existing.length) return { refund: existing[0], fresh: false };
      try {
        const rows = await sql`
          INSERT INTO refunds (payment_id, order_ref, provider, amount, reason, refund_key, status)
          VALUES (${r.paymentId}, ${r.orderRef}, ${r.provider}, ${r.amount},
                  ${String(r.reason).slice(0, 255)}, ${r.refundKey}, 'pending')
          RETURNING *`;
        return { refund: rows[0], fresh: true };
      } catch (e) {
        if (isUnique(e)) {
          const again = await sql`
            SELECT * FROM refunds WHERE payment_id = ${r.paymentId} AND refund_key = ${r.refundKey} LIMIT 1`;
          return { refund: again[0], fresh: false };
        }
        throw e;
      }
    },

    /* Only a payment that was actually recorded as captured has a refunded
       total to move. Refunding a charge we never managed to record — the
       reconciliation case — leaves that row `failed` and lets the refunds row
       carry the money going back, which is also the only version the
       payments_guard trigger will accept. */
    async settleRefund(refundId, paymentId, amount, providerRef, status) {
      await sql`UPDATE refunds SET status = ${status}, provider_ref = ${providerRef || null} WHERE id = ${refundId}`;
      if (status !== 'refunded') return null;
      const rows = await sql`
        UPDATE payments
        SET refunded = refunded + ${amount},
            status = CASE WHEN refunded + ${amount} >= amount THEN 'refunded' ELSE 'partially_refunded' END
        WHERE id = ${paymentId} AND status IN ('captured','partially_refunded')
        RETURNING *`;
      return rows.length ? rows[0] : null;
    },

    async openIncident(i) {
      const rows = await sql`
        INSERT INTO payment_incidents (order_ref, payment_id, kind, severity, detail)
        VALUES (${i.orderRef}, ${i.paymentId || null}, ${i.kind},
                ${i.severity || 'critical'}, ${JSON.stringify(i.detail || {})}::jsonb)
        RETURNING *`;
      return rows[0];
    },

    async resolveIncident(incidentId, orderRef, detail) {
      const rows = await sql`
        INSERT INTO payment_incidents (order_ref, kind, severity, detail, resolves)
        VALUES (${orderRef}, 'resolution', 'resolved', ${JSON.stringify(detail || {})}::jsonb, ${incidentId})
        RETURNING *`;
      return rows[0];
    },

    async incidentsFor(orderRef) {
      return await sql`SELECT * FROM payment_incidents WHERE order_ref = ${orderRef} ORDER BY id`;
    }
  };
}

/* ── In memory ──────────────────────────────────────────────────────────────
   The same interface with the same refusals, including the two unique indexes
   and the reference sequences. Sequences rather than array lengths, for the
   reason db/schema.sql records: a reference derived from a row count collides
   the moment a row is skipped or removed, and it does it silently. */

export function createMemoryStore(seedOrders = []) {
  const orders = new Map(seedOrders.map((o) => [o.ref, { currency: 'BDT', ...o }]));
  const payments = [];
  const events = [];
  const refunds = [];
  const incidents = [];
  const seq = { payment: 1000, refund: 1000, incident: 1, id: 1 };
  const nextId = () => seq.id++;
  const clone = (r) => (r ? { ...r } : null);

  const store = {
    /* test affordances, not part of the interface index.mjs uses */
    _orders: orders, _payments: payments, _events: events,
    _refunds: refunds, _incidents: incidents,

    async getOrder(ref) { return clone(orders.get(ref)); },

    async advanceOrder(ref, from, to) {
      const o = orders.get(ref);
      if (!o || o.status !== from) return false;
      o.status = to;
      return true;
    },

    async addOrderEvent(ref, type, actor, note) {
      events.push({ kind: 'order', order_ref: ref, type, actor, note });
    },

    async paymentByKey(orderRef, captureKey) {
      return clone(payments.find((p) => p.order_ref === orderRef && p.capture_key === captureKey));
    },

    async paymentByProviderRef(provider, providerRef) {
      return clone([...payments].reverse()
        .find((p) => p.provider === provider && p.provider_ref === providerRef));
    },

    async paymentsFor(orderRef) {
      return payments.filter((p) => p.order_ref === orderRef).map(clone);
    },

    async capturedPayment(orderRef) {
      return clone(payments.find((p) => p.order_ref === orderRef && CAPTURED.has(p.status)));
    },

    async openIntent(p) {
      if (payments.some((x) => x.order_ref === p.orderRef && x.capture_key === p.captureKey))
        throw new StoreConflict('duplicate_capture_key', 'This capture key is already in flight.');
      const row = {
        id: nextId(),
        ref: 'PAY-' + String(seq.payment++).padStart(6, '0'),
        order_ref: p.orderRef, provider: p.provider, provider_ref: p.providerRef || null,
        provider_txn: null, amount: p.amount, currency: p.currency || 'BDT',
        status: 'intent', capture_key: p.captureKey, refunded: 0,
        failure_code: null, simulated: !!p.simulated, created_at: new Date()
      };
      payments.push(row);
      return clone(row);
    },

    async attachProviderRef(id, providerRef) {
      const row = payments.find((p) => p.id === id && p.status === 'intent');
      if (!row) return null;
      row.provider_ref = providerRef;
      return clone(row);
    },

    async markCaptured(id, providerTxn) {
      const row = payments.find((p) => p.id === id);
      if (!row || !legal(row.status, 'captured'))
        throw new StoreConflict('not_capturable', 'That payment is no longer an open intent.');
      if (payments.some((p) => p.order_ref === row.order_ref && p.id !== id && CAPTURED.has(p.status)))
        throw new StoreConflict('already_captured', 'This order already holds a captured payment.');
      row.status = 'captured';
      row.provider_txn = providerTxn;
      return clone(row);
    },

    async markFailed(id, failureCode) {
      const row = payments.find((p) => p.id === id && p.status === 'intent');
      if (!row) return null;
      row.status = 'failed';
      row.failure_code = String(failureCode || 'unknown').slice(0, 64);
      return clone(row);
    },

    async markCancelled(id) {
      const row = payments.find((p) => p.id === id && p.status === 'intent');
      if (!row) return null;
      row.status = 'cancelled';
      return clone(row);
    },

    async addEvent(e) {
      events.push({
        kind: 'payment', payment_id: e.paymentId || null, order_ref: e.orderRef,
        type: e.type, actor: e.actor || 'system', detail: e.detail || {}, created_at: new Date()
      });
    },

    async eventsFor(orderRef) {
      return events.filter((e) => e.kind === 'payment' && e.order_ref === orderRef).map(clone);
    },

    async openRefund(r) {
      const found = refunds.find((x) => x.payment_id === r.paymentId && x.refund_key === r.refundKey);
      if (found) return { refund: clone(found), fresh: false };
      const row = {
        id: nextId(), ref: 'RFD-' + String(seq.refund++).padStart(6, '0'),
        payment_id: r.paymentId, order_ref: r.orderRef, provider: r.provider,
        provider_ref: null, amount: r.amount, reason: String(r.reason).slice(0, 255),
        refund_key: r.refundKey, status: 'pending', created_at: new Date()
      };
      refunds.push(row);
      return { refund: clone(row), fresh: true };
    },

    async settleRefund(refundId, paymentId, amount, providerRef, status) {
      const r = refunds.find((x) => x.id === refundId);
      if (r) { r.status = status; r.provider_ref = providerRef || null; }
      if (status !== 'refunded') return null;
      const p = payments.find((x) => x.id === paymentId);
      if (!p || (p.status !== 'captured' && p.status !== 'partially_refunded')) return null;
      p.refunded += amount;
      p.status = p.refunded >= p.amount ? 'refunded' : 'partially_refunded';
      return clone(p);
    },

    async openIncident(i) {
      const row = {
        id: nextId(), ref: 'INC-' + String(seq.incident++).padStart(6, '0'),
        order_ref: i.orderRef, payment_id: i.paymentId || null, kind: i.kind,
        severity: i.severity || 'critical', detail: i.detail || {}, resolves: null,
        created_at: new Date()
      };
      incidents.push(row);
      return clone(row);
    },

    async resolveIncident(incidentId, orderRef, detail) {
      const row = {
        id: nextId(), ref: 'INC-' + String(seq.incident++).padStart(6, '0'),
        order_ref: orderRef, payment_id: null, kind: 'resolution', severity: 'resolved',
        detail: detail || {}, resolves: incidentId, created_at: new Date()
      };
      incidents.push(row);
      return clone(row);
    },

    async incidentsFor(orderRef) {
      return incidents.filter((i) => i.order_ref === orderRef).map(clone);
    }
  };
  return store;
}
