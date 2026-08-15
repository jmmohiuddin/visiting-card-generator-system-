/* The component library over HTTP.
 *
 * Technical Design §10 item 5 asks for the library as data so a designer can
 * extend it without an engineer and so publishing a version can roll a cache
 * without a deploy. Both of those are this endpoint: a GET is the current
 * `LibrarySnapshot` and the `libraryVersion` that keys the candidate cache
 * (§7.1), and a POST publishes a new version of one component.
 *
 * Two things it is careful about.
 *
 * A GET always answers. A deploy without migration 006, or without a database
 * at all, returns the built-in library and says in `source` which of those it
 * was — the library is what the product composes with, so an endpoint that
 * refuses here would take the whole funnel down to protect a lookup that has
 * a correct default sitting right there.
 *
 * A POST is the opposite: it refuses everything it is not sure about, because
 * a published version is immutable. There is no correcting a bad record
 * afterwards, only publishing another one beside it and living with whatever
 * was composed in between, so `validatePayload` runs at the door rather than
 * at the first compose that breaks.
 */
import { handler, ok, ERR, readJson, db, idempotencyKey, replay, remember } from '../../lib/http.mjs';
import { loadLibrary, resolvePins, publishComponent, KINDS, pinsFor } from '../../lib/library.mjs';

const MAX_BODY = 256 * 1024;

/* Publishing changes what every brief in the country generates next. Real
   staff accounts arrive with A5's work; until then this is the same shared
   token the refund path uses, and a deploy that has not set one refuses to
   publish at all rather than leaving the library open to anyone who finds
   the path. */
const staffAuthorised = (req) => {
  const expected = (process.env.CARDWORKS_STAFF_TOKEN || '').trim();
  if (!expected) return false;
  const got = (req.headers.get('x-cardworks-staff') || '').trim();
  return got.length === expected.length && got === expected;
};

/** `lay.rule@1,pal.ink@2` — the pin list a saved spec carries. */
function parsePins(raw) {
  const pins = {};
  for (const part of String(raw).split(',')) {
    const m = /^([A-Za-z0-9._-]{2,64})@(\d{1,6})$/.exec(part.trim());
    if (!m) return [null, part.trim()];
    pins[m[1]] = Number(m[2]);
  }
  return [pins, null];
}

/* Only the half of the snapshot a caller asked for. A designer editing
   palettes does not need thirteen layout records to come back with them, and
   the whole library is 24 KB. */
const KIND_KEY = { lay: 'layouts', pal: 'palettes', typ: 'typeSystems', slot: 'slotDefs' };

export async function componentsRequest(req, sql) {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const rawPins = url.searchParams.get('pins');
    let loaded;

    if (rawPins) {
      const [pins, bad] = parsePins(rawPins);
      if (bad !== null) return ERR.badRequest(`\`${bad}\` is not a pin. A pin is a slug and a version, as \`pal.ink@2\`.`,
        { field: 'pins', remediation: 'Send the pins exactly as the spec recorded them.' });
      try { loaded = await resolvePins(sql, pins); }
      catch (err) {
        /* A pin that will not resolve is not a stale reference to clean up.
           A published version is immutable and undeletable, so this can only
           mean something got past the trigger — and answering with the
           current version instead would hand back a different card than the
           one that was ordered. */
        return ERR.conflict(err.message, {
          code: 'pinned_version_missing',
          remediation: 'Do not compose against the current library instead — report this. A pinned version going missing means a saved design can no longer be reproduced.'
        });
      }
    } else {
      loaded = await loadLibrary(sql);
    }

    const kind = url.searchParams.get('kind');
    if (kind && !KIND_KEY[kind])
      return ERR.badRequest(`There is no component kind \`${kind}\`.`, { field: 'kind',
        remediation: `Ask for one of: ${Object.keys(KIND_KEY).join(', ')}.` });

    const library = kind ? { [KIND_KEY[kind]]: loaded.library[KIND_KEY[kind]] } : loaded.library;

    /* The snapshot for a given libraryVersion never changes — that is what
       makes it a cache key — but the *current* version does, so this is
       revalidated rather than held. A pinned read is immutable outright. */
    return ok({
      libraryVersion: loaded.libraryVersion,
      source: loaded.source,
      kinds: KINDS,
      components: loaded.components,
      pins: pinsFor(loaded.components),
      library
    }, 200, {
      etag: `"${loaded.libraryVersion}"`,
      'cache-control': rawPins ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
  }

  if (req.method !== 'POST')
    return ERR.badRequest('The library is read with GET and extended with POST.');

  /* Authorisation before infrastructure, deliberately. Answering 503 first
     would tell anyone who found this path whether the deploy has a database
     wired up, and it is not their question to have answered. */
  if (!staffAuthorised(req)) return ERR.forbidden(
    'Publishing a component version changes what every brief generates next.',
    { remediation: 'Publish from a staff session.' });
  if (!sql) return ERR.unavailable(
    'This deploy has no database, so the library is the built-in default and cannot be published to.');

  const [body, bad] = await readJson(req, MAX_BODY);
  if (bad) return bad;

  const slug = String(body.slug || '').trim();
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(slug))
    return ERR.badRequest('A component needs a slug — the id the engine and every saved spec already use, like `lay.rule`.',
      { field: 'slug' });
  if (!KINDS[body.kind])
    return ERR.badRequest(`\`${body.kind}\` is not a component kind that composes.`, { field: 'kind',
      remediation: `Publish one of: ${Object.keys(KINDS).map(k => `${k} (${KINDS[k]})`).join(', ')}.` });

  /* Publishing twice from a retried request would leave two identical
     versions in the history and roll the cache twice, so the key is honoured
     here as on every other mutating call (§8). */
  const key = idempotencyKey(req);
  const scope = 'components:publish';
  const replayed = await replay(sql, key, scope);
  if (replayed) return replayed;

  let published;
  try {
    published = await publishComponent(sql, { slug, kind: body.kind, payload: body.payload });
  } catch (err) {
    if (err.code === 'bad_component')
      return ERR.unprocessable(err.message, { field: err.field,
        remediation: 'A published version can never be edited, so it is checked before it is written rather than after.' });
    if (err.code === 'kind_conflict')
      return ERR.conflict(err.message, { field: err.field,
        remediation: 'Publish this under a new slug instead.' });
    throw err;
  }

  const payload = {
    slug: published.slug, kind: published.kind, version: published.version,
    publishedAt: published.publishedAt,
    libraryVersion: published.libraryVersion,
    /* Said plainly in the response because it is the property the caller most
       needs to be sure of before they press publish on a live library. */
    rolled: 'candidate caches only — every saved spec pins the version it was composed from and is unaffected'
  };
  await remember(sql, key, scope, 201, payload);
  return ok(payload, 201);
}

export default handler('components', (req) => componentsRequest(req, db()));

export const config = { path: '/api/components' };
