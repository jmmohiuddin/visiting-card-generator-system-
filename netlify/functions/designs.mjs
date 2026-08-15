/* Save and load a DesignSpec.
 *
 * A spec is immutable and content-addressed (blueprint §2, §8, §12): the same
 * design saved twice is one row, and its hash is its name. That is what makes
 * a short link stable and a render cacheable forever.
 *
 * The connection string is read from the environment. It is never in this
 * repository and must not be — see .gitignore and .env.example.
 */
import { neon } from '@neondatabase/serverless';
import { authenticate } from '../../lib/auth.mjs';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
  });

// FNV-1a, twice, in opposite directions — identical to specHash() in the
// engine, so a code minted client-side and one minted here always agree.
function specHash(spec) {
  const s = stableStringify(spec);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x9e3779b9;
  for (let i = s.length - 1; i >= 0; i--) { h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x85ebca6b) >>> 0; }
  return h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

const MAX_SPEC_BYTES = 64 * 1024;

export default async (req) => {
  const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
  if (!sql) return json({ error: 'DATABASE_URL is not configured for this deploy' }, 503);

  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!/^[0-9a-f]{6,16}$/.test(code)) return json({ error: 'bad code' }, 400);

      const rows = await sql`
        SELECT short_code, spec_json, label, created_at
        FROM design_specs WHERE short_code = ${code} LIMIT 1`;
      if (!rows.length) return json({ error: 'not found' }, 404);

      await sql`INSERT INTO usage_events (type, short_code) VALUES ('design.load', ${code})`;
      return json({ code: rows[0].short_code, spec: rows[0].spec_json,
                    label: rows[0].label, createdAt: rows[0].created_at });
    }

    if (req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > MAX_SPEC_BYTES) return json({ error: 'spec too large' }, 413);

      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: 'invalid JSON' }, 400); }
      const spec = body && body.spec;
      if (!spec || typeof spec !== 'object') return json({ error: 'missing spec' }, 400);

      // An uploaded asset must never reach the database through this path.
      if (spec.content && spec.content.logo) delete spec.content.logo;

      /* ── Pin the component versions this design was built from ────────────
         Technical Design §7.1 calls this guarantee non-negotiable: publishing
         a new component version rolls the candidate caches but must never
         change a design somebody has already saved, because in this product
         people order five hundred physical copies of it.

         A spec records its components by slug — `pal.ink`, `lay.rule` — and a
         slug is not a version. Without pins, republishing `pal.ink` with a
         different accent silently repaints every saved design that used it,
         including one a customer approved a printed proof of. The spec hash
         does not move, which makes it worse rather than better: everything
         downstream reports the design as unchanged while it renders
         differently.

         `lib/library.mjs` could already resolve pins back into a library;
         nothing wrote them. This is the other half. */
      if (!spec.pins) {
        try {
          const { loadLibrary, pinsFor } = await import('../../lib/library.mjs');
          const lib = await loadLibrary(sql);
          spec.pins = pinsFor(lib.components);
          spec.libraryVersion = lib.libraryVersion;
        } catch (err) {
          /* A deploy without migration 006 has no component tables, so there
             are no versions to pin and every design is built from the
             built-in library. Recording that is more useful than failing the
             save — and it is the honest answer rather than a silent absence. */
          spec.pins = null;
          spec.libraryVersion = 'builtin';
          console.error('could not pin component versions:', err && err.message);
        }
      }

      /* Hashed after pinning, deliberately. The pins are part of what the
         design IS — two specs naming the same slugs at different versions are
         different cards — so a hash taken before them would collapse both onto
         one row and hand the second customer the first one's design. */
      const hash = specHash(spec);
      const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null;
      // An anonymous per-browser key so "My designs" can list what this
      // person saved. It is not an account and grants nothing.
      const owner = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.owner || '')) ? body.owner : null;

      /* A signed-in customer's designs are stamped with their account here and
         only here. `design_specs` is append-only — the trigger raises on
         UPDATE — so a row saved without a user id can never be adopted later
         by writing to it; work made before signing in comes back through
         `owner_claims` instead. Both halves are needed, and this is the half
         that stops a fresh browser's first design from being invisible to the
         account that made it. */
      const [user] = await authenticate(req, sql).catch(() => [null, null]);
      const userId = user ? user.userId : null;

      // Content addressing means saving the same design twice is idempotent:
      // ON CONFLICT DO NOTHING, then read back whichever row won.
      /* The column is only named when there is an account to put in it,
         because a deploy that has not run migration 004 has no `user_id` on
         this table and naming it would fail the save outright.

         What makes that safe is the `sql` argument above, not the fact that
         someone is signed in. `authenticate(req, sql)` queries `auth_sessions`,
         which 004 creates; without 004 that query raises, the catch turns it
         into `[null, null]`, and this branch never names the column. A session
         verified *without* a database round trip — `sessionFrom(req)`, or
         `authenticate(req)` with no sql — would return a live user on exactly
         that deploy and take the other branch into a phantom column.

         So the rule, and it belongs at every call site that follows: a path
         that names `user_id` must authenticate with `sql`. This is reachable,
         not hypothetical — tokens are self-contained and last thirty days,
         and Netlify preview deploys inherit AUTH_SECRET while getting their
         own fresh DATABASE_URL. */
      let code = hash.slice(0, 8);
      await (userId
        ? sql`
            INSERT INTO design_specs (spec_hash, short_code, spec_json, label, owner_key, user_id)
            VALUES (${hash}, ${code}, ${JSON.stringify(spec)}::jsonb, ${label}, ${owner}, ${userId})
            ON CONFLICT (spec_hash) DO NOTHING`
        : sql`
            INSERT INTO design_specs (spec_hash, short_code, spec_json, label, owner_key)
            VALUES (${hash}, ${code}, ${JSON.stringify(spec)}::jsonb, ${label}, ${owner})
            ON CONFLICT (spec_hash) DO NOTHING`);

      const rows = await sql`SELECT short_code FROM design_specs WHERE spec_hash = ${hash} LIMIT 1`;
      if (rows.length) code = rows[0].short_code;
      else {
        // Same 8-hex prefix, different design. Widen and retry once.
        code = hash.slice(0, 12);
        await (userId
          ? sql`
              INSERT INTO design_specs (spec_hash, short_code, spec_json, label, owner_key, user_id)
              VALUES (${hash}, ${code}, ${JSON.stringify(spec)}::jsonb, ${label}, ${owner}, ${userId})`
          : sql`
              INSERT INTO design_specs (spec_hash, short_code, spec_json, label, owner_key)
              VALUES (${hash}, ${code}, ${JSON.stringify(spec)}::jsonb, ${label}, ${owner})`);
      }

      await sql`INSERT INTO usage_events (type, short_code) VALUES ('design.save', ${code})`;
      return json({ code, hash, url: `${url.origin}/c/${code}` }, 201);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    // Never leak connection details into a response body.
    console.error('designs function failed:', err && err.message);
    return json({ error: 'server error' }, 500);
  }
};

export const config = { path: '/api/designs' };
