/* Orders, and the list behind "My designs".
 *
 * The prototype's best product decision was proof-before-charge: a printed
 * proof is made first, and the run only starts once the customer has held it.
 * That is encoded here as an append-only event log — the order's history of
 * who approved what and when can never be overwritten.
 */
import { neon } from '@neondatabase/serverless';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

const OWNER = /^[A-Za-z0-9_-]{8,64}$/;
const REF   = /^ORD-[0-9A-Z]{4,10}$/;

const FLOW = [
  ['files_locked',      'Files locked',        'Preflight passed with no blocking finding'],
  ['at_press',          'Sent to press',       'Plates and any foil block prepared'],
  ['proof_printed',     'Proof printed',       'One card, on the exact stock and finish of the run'],
  ['proof_delivered',   'Proof delivered',     'Courier handover'],
  ['awaiting_approval', 'Your approval',       'The run does not start, and nothing is charged, until you approve'],
  ['printing',          'Run and delivery',    'Four working days after approval'],
  ['delivered',         'Delivered',           '']
];

export default async (req) => {
  const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
  if (!sql) return json({ error: 'DATABASE_URL is not configured for this deploy' }, 503);

  const url = new URL(req.url);
  /* The owner key arrives in the query on a GET and in the body on a POST.
     Reading only the query silently dropped it on every order placed, so
     nothing a customer ordered ever appeared in "My designs". */
  let owner = (url.searchParams.get('owner') || '').trim();

  try {
    /* ── list designs + orders for this browser ── */
    if (req.method === 'GET' && url.searchParams.get('list') === '1') {
      if (!OWNER.test(owner)) return json({ designs: [], orders: [] });
      const designs = await sql`
        SELECT short_code, label, created_at,
               spec_json->'content'->>'name'    AS name,
               spec_json->>'layout'             AS layout,
               spec_json->>'palette'            AS palette
        FROM design_specs WHERE owner_key = ${owner}
        ORDER BY created_at DESC LIMIT 24`;
      const orders = await sql`
        SELECT ref, short_code, qty, press, total, status, created_at
        FROM orders WHERE owner_key = ${owner}
        ORDER BY created_at DESC LIMIT 24`;
      return json({ designs, orders });
    }

    /* ── one order, with its event history ── */
    if (req.method === 'GET') {
      const ref = (url.searchParams.get('ref') || '').trim().toUpperCase();
      if (!REF.test(ref)) return json({ error: 'bad ref' }, 400);
      const rows = await sql`SELECT * FROM orders WHERE ref = ${ref} LIMIT 1`;
      if (!rows.length) return json({ error: 'not found' }, 404);
      const events = await sql`
        SELECT type, actor, note, created_at FROM order_events
        WHERE order_ref = ${ref} ORDER BY created_at`;
      return json({ order: rows[0], events, flow: FLOW });
    }

    if (req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 16 * 1024) return json({ error: 'payload too large' }, 413);
      let b; try { b = JSON.parse(raw); } catch { return json({ error: 'invalid JSON' }, 400); }
      if (!owner && typeof b.owner === 'string') owner = b.owner.trim();

      /* ── advance an existing order ── */
      if (b.ref) {
        const ref = String(b.ref).toUpperCase();
        if (!REF.test(ref)) return json({ error: 'bad ref' }, 400);
        const action = String(b.action || '');
        const next = { approve:'printing', reproof:'proof_printed', cancel:'cancelled' }[action];
        if (!next) return json({ error: 'unknown action' }, 400);
        const cur = await sql`SELECT status FROM orders WHERE ref = ${ref} LIMIT 1`;
        if (!cur.length) return json({ error: 'not found' }, 404);
        if (cur[0].status === 'delivered' || cur[0].status === 'cancelled')
          return json({ error: 'this order is closed' }, 409);
        await sql`UPDATE orders SET status = ${next} WHERE ref = ${ref}`;
        await sql`INSERT INTO order_events (order_ref, type, actor, note)
                  VALUES (${ref}, ${action}, 'customer', ${String(b.note || '').slice(0, 400) || null})`;
        return json({ ref, status: next });
      }

      /* ── place a new order ── */
      const code = String(b.shortCode || '').trim();
      if (!/^[0-9a-f]{6,16}$/.test(code)) return json({ error: 'save the design before ordering' }, 400);
      const exists = await sql`SELECT 1 FROM design_specs WHERE short_code = ${code} LIMIT 1`;
      if (!exists.length) return json({ error: 'that design is not saved' }, 404);

      const qty = Math.max(1, Math.min(100000, Number(b.qty) || 500));
      const total = Math.max(0, Math.round(Number(b.total) || 0));
      const sub   = Math.max(0, Math.round(Number(b.subtotal) || 0));
      /* The reference comes from a dedicated Postgres sequence (see
         db/schema.sql). An earlier version derived it from a row count and
         truncated to a fixed width, which silently collapsed ten
         consecutive orders onto the same reference — the second one then
         failed on the unique index. A sequence is also race-safe. */
      const ins = await sql`
        INSERT INTO orders (owner_key, short_code, qty, press, finishes, zone,
                            subtotal, total, status, recipient)
        VALUES (${OWNER.test(owner) ? owner : null}, ${code}, ${qty},
                ${String(b.press || 'Unassigned').slice(0,80)},
                ${JSON.stringify(Array.isArray(b.finishes) ? b.finishes : [])}::jsonb,
                ${b.zone === 'outside' ? 'outside' : 'dhaka'}, ${sub}, ${total},
                'files_locked', ${JSON.stringify(b.recipient || {})}::jsonb)
        RETURNING ref`;
      const ref = ins[0].ref;

      // Seed the flow up to the point a real press would have reached.
      for (const [t, , note] of FLOW.slice(0, 5)) {
        await sql`INSERT INTO order_events (order_ref, type, actor, note)
                  VALUES (${ref}, ${t}, ${t === 'files_locked' ? 'you' : 'press'}, ${note || null})`;
      }
      await sql`UPDATE orders SET status = 'awaiting_approval' WHERE ref = ${ref}`;
      await sql`INSERT INTO usage_events (type, short_code, meta)
                VALUES ('order.placed', ${code}, ${JSON.stringify({ ref, qty, total })}::jsonb)`;
      return json({ ref, status: 'awaiting_approval' }, 201);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    console.error('orders function failed:', err && err.message);
    return json({ error: 'server error' }, 500);
  }
};

export const config = { path: '/api/orders' };
