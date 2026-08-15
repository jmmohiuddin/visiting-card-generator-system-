/* The caching model of Technical Design §7.1, as code.
 *
 * §7.1 is short and the whole cost model hangs off it:
 *
 *   Candidate set    sha256(vector, libraryVersion, seed)   7 days
 *   Preview render   spec_hash + variant                    immutable, 1 year
 *   Print render     spec_hash                              immutable
 *   Explanation      spec_hash                              30 days
 *
 * None of it is possible without §3.3. A cache is only ever safe over a pure
 * function: the engine may not read a clock, a database or an unseeded random
 * number, so the same brief returns the same six concepts permanently, and the
 * same spec composes to the same card permanently. That is why the table above
 * has an "immutable, 1 year" row in it at all — not optimism, a consequence.
 *
 * And it is why a library change is the only thing that may roll a cache.
 * Publishing a component version moves `libraryVersion` and therefore every
 * candidate key, and moves nothing else: a saved spec pins the exact versions
 * it was built from, so a customer's design cannot change under them. §7.1
 * calls that non-negotiable in a product people order physical goods from,
 * and it is the reason the candidate key and the spec key are separate things
 * rather than one key with a version glued on.
 *
 * ── What this module is and is not ───────────────────────────────────────
 *
 * It is the key shapes, the TTL policy expressed as headers a CDN honours,
 * and the read/write pair for the `renders` table (migration 007). It takes
 * an `sql` client as an argument rather than opening one, because `db()` in
 * lib/http.mjs returns a real client from `DATABASE_URL` with no seam to
 * inject through, and adding one ahead of a caller that needs it is the
 * speculative-capability mistake Master PRD §2.3 documents.
 *
 * It is **not yet wired to anything**. `render-print.mjs` re-renders on every
 * request and says `cache-control: no-store`; the preview path is client-side
 * and never reaches a server at all. Both are one call away from using this,
 * and neither is this module's file to change. Saying so here is better than
 * a module that reads as if it were load-bearing when nothing calls it.
 *
 * The candidate key is not defined here. `lib/library.mjs` already owns it,
 * because the thing it is keyed on — which components are published at which
 * version — is that module's subject. It is re-exported so a caller assembling
 * a cache key has one import rather than two, and so there is no second
 * implementation to drift from the first.
 */
import crypto from 'node:crypto';
import { candidateKey, libraryVersion } from './library.mjs';

export { candidateKey, libraryVersion };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ── The layers ──────────────────────────────────────────────────────────
   §7.1's table, as data rather than as four scattered literals, so a TTL is
   changed in one place and a layer that has no policy is a missing entry
   rather than a silently absent header. */
const YEAR = 31_536_000, MONTH = 2_592_000, WEEK = 604_800;

export const LAYERS = {
  candidates:  { ttl: WEEK,  immutable: false, note: 'rolled by a library publish, never by a deploy' },
  preview:     { ttl: YEAR,  immutable: true,  note: 'content-addressed; a changed design is a different key' },
  print:       { ttl: YEAR,  immutable: true,  note: 'a re-order and a proof→run reuse the same render' },
  explanation: { ttl: MONTH, immutable: false, note: 'derived from a trace already stored in spec_json' }
};

/** The `Cache-Control` a layer's response should carry.
 *
 *  `immutable` is the half that matters: it tells a browser not to
 *  revalidate at all, which is what turns a preview into a CDN hit with no
 *  round trip on the metered connection PRD §3.1 assumes. It is only honest
 *  for a content-addressed key, which is why it is a property of the layer
 *  and not an argument. */
export function cacheControl(layer) {
  const L = LAYERS[layer];
  if (!L) throw new Error(`no cache policy for '${layer}' — §7.1 names ${Object.keys(LAYERS).join(', ')}`);
  return `public, max-age=${L.ttl}` + (L.immutable ? ', immutable' : '');
}

/** The seed §7.1 derives determinism from: `sha256(briefId ‖ libraryVersion ‖
 *  rankerVersion)`.
 *
 *  Every input is a version of something rather than a moment in time, which
 *  is the point — a seed that moved on its own would make the same brief
 *  return different concepts, and the six a customer saw yesterday would be
 *  gone today with nothing to say why. */
export const seedFor = ({ briefId, libraryVersion: lv, rankerVersion }) =>
  sha256(JSON.stringify([briefId ?? null, lv ?? null, rankerVersion ?? null]));

/** The render key. §7.1 gives `spec_hash + variant` for a preview and
 *  `spec_hash` for print; print is the `print` variant of the same shape, so
 *  there is one key function rather than two that must be kept in step.
 *
 *  `engineVersion` is part of it for the reason migration 007 spells out: a
 *  spec pins its components, but nothing pins the fit ladder, so an artefact
 *  is immutable only relative to the engine that produced it. */
export const renderKey = ({ specHash, variant = 'preview', engineVersion }) =>
  `${specHash}:${variant}:${engineVersion}`;

/** The explanation key. A "why" is generated from the trace, and the trace is
 *  a function of the spec, so the spec hash names it. */
export const explanationKey = (specHash) => `${specHash}:why`;

/* ── The renders table ───────────────────────────────────────────────────
   Both calls degrade rather than refuse, and each says which state it was
   in. A deploy with no database, a database without migration 007, and a
   genuine miss are three different things, and a cache that reports them all
   as "not cached" is a cache nobody can operate. */

const MISSING_RELATION = /relation .*renders.* does not exist/i;

/** A render already made, or why there is not one.
 *
 *  Returns `{ hit, render?, reason }`. A miss is never an error: the caller's
 *  job on a miss is to render, which is the thing it was going to do anyway.
 */
export async function getRender(sql, { specHash, variant = 'preview', engineVersion }) {
  if (!specHash || !engineVersion)
    throw new Error('a render key needs both a spec hash and an engine version');
  if (!sql) return { hit: false, reason: 'no-database' };
  try {
    const rows = await sql`
      SELECT spec_hash, variant, engine_version, content_type, byte_length,
             content_sha256, body, url, short_code, created_at
      FROM renders
      WHERE spec_hash = ${specHash} AND variant = ${variant}
        AND engine_version = ${engineVersion}
      LIMIT 1`;
    if (!rows.length) return { hit: false, reason: 'miss' };
    return { hit: true, render: rows[0], reason: 'hit' };
  } catch (e) {
    if (MISSING_RELATION.test(e && e.message || '')) return { hit: false, reason: 'migration-007-not-applied' };
    throw e;
  }
}

/** Record a render under its key.
 *
 *  Idempotent by the unique index rather than by a read-then-write, because
 *  two requests for the same uncached design arrive together often enough
 *  that the race is the normal case rather than the edge one. The existing
 *  row wins, and that is correct: the key is content-addressed, so the two
 *  rows would have been the same bytes.
 */
export async function putRender(sql, {
  specHash, variant = 'preview', engineVersion, contentType, body = null, url = null, shortCode = null
}) {
  if (!specHash || !engineVersion)
    throw new Error('a render key needs both a spec hash and an engine version');
  if (body === null && url === null)
    throw new Error('a render row must carry the artefact or a URL to it — an entry pointing at nothing is worse than a miss');
  if (!contentType) throw new Error('a render row must say what it is');
  if (!sql) return { stored: false, reason: 'no-database' };

  /* The digest is over the artefact when we hold it, and over the URL when we
     do not, so a row always carries something a caller can verify what it
     fetched against. */
  const subject = body === null ? url : body;
  const contentSha = sha256(subject);
  const byteLength = Buffer.byteLength(body === null ? '' : body, 'utf8');

  try {
    const rows = await sql`
      INSERT INTO renders (spec_hash, variant, engine_version, content_type,
                           byte_length, content_sha256, body, url, short_code)
      VALUES (${specHash}, ${variant}, ${engineVersion}, ${contentType},
              ${byteLength}, ${contentSha}, ${body}, ${url}, ${shortCode})
      ON CONFLICT (spec_hash, variant, engine_version) DO NOTHING
      RETURNING id`;
    return rows.length
      ? { stored: true, id: rows[0].id, contentSha, reason: 'stored' }
      : { stored: false, contentSha, reason: 'already-cached' };
  } catch (e) {
    if (MISSING_RELATION.test(e && e.message || '')) return { stored: false, reason: 'migration-007-not-applied' };
    throw e;
  }
}

/** The §7.2 lifecycle sweep: renders older than `days` move to cold storage.
 *
 *  Deletion is safe here and nowhere else in this schema, because a render is
 *  derived — evicting one costs a regeneration, and §7.2 budgets 40 ms for
 *  the expensive kind. `design_specs` and `preflight_acceptances` refuse to
 *  be deleted for the opposite reason: nothing can regenerate them.
 */
export async function sweepRenders(sql, { olderThanDays = 90, limit = 1000 } = {}) {
  if (!sql) return { swept: 0, reason: 'no-database' };
  try {
    const rows = await sql`
      DELETE FROM renders
      WHERE id IN (
        SELECT id FROM renders
        WHERE created_at < now() - make_interval(days => ${olderThanDays})
        ORDER BY created_at
        LIMIT ${limit}
      )
      RETURNING id`;
    return { swept: rows.length, reason: 'swept' };
  } catch (e) {
    if (MISSING_RELATION.test(e && e.message || '')) return { swept: 0, reason: 'migration-007-not-applied' };
    throw e;
  }
}

/* ── The load-shedding ladder, §7.3 ──────────────────────────────────────
   Under stress: disable bulk generation, then serve cached previews only,
   then queue exports with an honest ETA on screen. §7.3's own point is that
   the product should stay usable at every step — a slightly less nuanced
   result is a far better failure mode than an error page — so each step
   names what it takes away rather than being a numeric level nobody can
   reason about at three in the morning. */
export const SHED_LADDER = [
  { step: 1, disable: 'bulk',           keeps: 'one card at a time still generates, previews and orders unaffected' },
  { step: 2, disable: 'fresh-previews', keeps: 'a design already rendered still shows; a new one waits' },
  { step: 3, disable: 'sync-export',    keeps: 'exports queue and the screen states the wait rather than failing' }
];

/** What is still allowed at a given shed level. Level 0 is everything. */
export const shedAllows = (level, capability) =>
  !SHED_LADDER.some(s => s.step <= level && s.disable === capability);
