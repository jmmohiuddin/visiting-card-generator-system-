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

      const hash = specHash(spec);
      const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null;

      // Content addressing means saving the same design twice is idempotent:
      // ON CONFLICT DO NOTHING, then read back whichever row won.
      let code = hash.slice(0, 8);
      await sql`
        INSERT INTO design_specs (spec_hash, short_code, spec_json, label)
        VALUES (${hash}, ${code}, ${JSON.stringify(spec)}::jsonb, ${label})
        ON CONFLICT (spec_hash) DO NOTHING`;

      const rows = await sql`SELECT short_code FROM design_specs WHERE spec_hash = ${hash} LIMIT 1`;
      if (rows.length) code = rows[0].short_code;
      else {
        // Same 8-hex prefix, different design. Widen and retry once.
        code = hash.slice(0, 12);
        await sql`
          INSERT INTO design_specs (spec_hash, short_code, spec_json, label)
          VALUES (${hash}, ${code}, ${JSON.stringify(spec)}::jsonb, ${label})`;
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
