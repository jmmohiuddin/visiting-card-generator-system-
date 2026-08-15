/* The versioned API surface — Technical Design §8.
 *
 * The endpoints in this directory grew one at a time, each at its own
 * unversioned path, which is how §8's target — one versioned REST surface
 * that the web client and any print-shop or partner integration use, with no
 * private endpoints — never got built. This file is that surface, and it is
 * deliberately thin: with two exceptions it parses a path, moves an id from
 * the URL into the body the existing handler already reads, and delegates.
 *
 * Not reimplements. A second copy of the order flow or the payment capture
 * would drift from the first, and the drift would be a partner charged
 * differently from a customer — the same argument `lib/engine-node.mjs` makes
 * for loading `assets/engine.js` instead of porting it. Every route below
 * either calls the handler that already serves its unversioned path or, for
 * the four §8 routes that had no endpoint at all, calls the engine directly.
 * `tests/library.test.mjs` asserts the delegated ones return a body identical
 * to their unversioned equivalent, so a route that quietly stopped agreeing
 * would fail the build rather than a partner's integration.
 *
 * ── What the unversioned paths keep doing ─────────────────────────────────
 *
 * Everything. `/api/orders` and the rest stay exactly as they are, because
 * something is live on them: the deployed browser client is loaded from a
 * cache we do not control, and versioning a path is not a reason to break the
 * page somebody has open.
 *
 * ── Idempotency, and who owns it ──────────────────────────────────────────
 *
 * §8 puts `Idempotency-Key` on every mutating call. For a delegated route the
 * header is forwarded untouched and the target honours it — `orders.mjs`,
 * `payments.mjs`, `preflight.mjs` and `components.mjs` each cache under their
 * own scope, and wrapping a second cache around them would only mean a retry
 * could be answered from either of two places. The four routes originated
 * here carry their own replay, under their own scopes, for the same reason
 * every other mutating call does.
 *
 * ── What §8 asks for and this does not do ─────────────────────────────────
 *
 * §8 makes generation and export asynchronous, returning a `{ jobId }` and
 * calling a webhook. Both are synchronous here, because both are synchronous
 * in the handlers underneath and inventing a job id for work that has already
 * finished by the time the reply is written would be a shape without a
 * mechanism. `POST /v1/specs/:id/export` therefore returns the PDF itself.
 *
 * `GET /v1/specs/:id/render` is specified as a 302 to a CDN. It is a 302 the
 * moment `RENDER_CDN_BASE` names one, and until then it serves the SVG inline
 * with the cache headers that CDN would carry — a preview is immutable by
 * spec hash (§7.1), so the caching semantics are real even where the redirect
 * is not yet.
 */
import {
  handler, ok, fail, ERR, readJson, db, CODE_RE,
  idempotencyKey, replay, remember
} from '../../lib/http.mjs';
import { engine } from '../../lib/engine-node.mjs';
import { loadLibrary, withLibrary, candidateKey } from '../../lib/library.mjs';
import crypto from 'node:crypto';

import preflightFn from './preflight.mjs';
import renderPrintFn from './render-print.mjs';
import quotesFn from './quotes.mjs';
import ordersFn from './orders.mjs';
import paymentsFn from './payments.mjs';
import designsFn from './designs.mjs';
import enhanceFn from './enhance.mjs';
import destructureFn from './destructure.mjs';
import componentsFn from './components.mjs';

const MAX_BODY = 12 * 1024 * 1024;

/* The surface, as data, so `GET /v1` can answer with it and so the shape of
   this file is a table rather than a chain of conditionals. `to` is the
   unversioned path a route delegates to, or null where §8 asked for something
   no endpoint served. */
export const ROUTES = [
  { method: 'POST', pattern: '/v1/briefs',                    to: null,                  note: 'brief → { briefId, vector }' },
  { method: 'POST', pattern: '/v1/briefs/:id/generate',       to: null,                  note: 'ranked concepts for a brief' },
  { method: 'POST', pattern: '/v1/specs',                     to: '/api/designs',         note: 'save a spec, get its id' },
  { method: 'GET',  pattern: '/v1/specs/:id',                 to: '/api/designs',         note: 'load a saved spec' },
  { method: 'POST', pattern: '/v1/specs/:id/instruct',        to: null,                  note: 'free text → operations' },
  { method: 'GET',  pattern: '/v1/specs/:id/render',          to: null,                  note: '?variant=preview | print' },
  { method: 'POST', pattern: '/v1/specs/:id/preflight',       to: '/api/preflight',       note: 'findings, and whether it may print' },
  { method: 'POST', pattern: '/v1/specs/:id/export',          to: '/api/render-print',    note: 'PDF/X-4 press file' },
  { method: 'POST', pattern: '/v1/quotes',                    to: '/api/quotes',          note: 'server-computed price options' },
  { method: 'GET',  pattern: '/v1/orders',                    to: '/api/orders',          note: '?ref= | ?list=1' },
  { method: 'POST', pattern: '/v1/orders',                    to: '/api/orders',          note: 'place or advance an order' },
  { method: 'POST', pattern: '/v1/payments/:orderId/capture', to: '/api/payments',        note: 'begin or complete a capture' },
  { method: 'GET',  pattern: '/v1/payments/:orderId',         to: '/api/payments',        note: 'payment state for an order' },
  { method: 'GET',  pattern: '/v1/components',                to: '/api/components',      note: 'the library, and its version' },
  { method: 'POST', pattern: '/v1/components',                to: '/api/components',      note: 'publish a component version' },
  { method: 'GET',  pattern: '/v1/enhance',                   to: '/api/enhance',         note: 'what enhancement can and cannot do' },
  { method: 'POST', pattern: '/v1/enhance',                   to: '/api/enhance',         note: 'make an uploaded card printable' },
  { method: 'GET',  pattern: '/v1/destructure',               to: '/api/destructure',     note: 'what decomposition can and cannot do' },
  { method: 'POST', pattern: '/v1/destructure',               to: '/api/destructure',     note: 'take an uploaded card apart' }
];

const TARGET = {
  '/api/designs': designsFn, '/api/preflight': preflightFn, '/api/render-print': renderPrintFn,
  '/api/quotes': quotesFn, '/api/orders': ordersFn, '/api/payments': paymentsFn,
  '/api/components': componentsFn, '/api/enhance': enhanceFn, '/api/destructure': destructureFn
};

/** Hand a request to the handler that already serves the unversioned path,
 *  with the URL rewritten and whatever the route lifted out of the path
 *  merged into the body. Headers travel untouched, which is what carries
 *  `Idempotency-Key`, the session cookie and the staff token through. */
function delegate(to, req, ctx, { raw, body, search } = {}) {
  const target = TARGET[to];
  if (!target) throw new Error(`/v1 route points at ${to}, which is not a handler here`);

  const url = new URL(req.url);
  url.pathname = to;
  for (const [k, v] of Object.entries(search || {})) url.searchParams.set(k, v);

  const headers = new Headers(req.headers);
  const init = { method: req.method, headers };
  if (body !== undefined) { init.body = JSON.stringify(body); headers.set('content-type', 'application/json'); }
  else if (raw !== undefined && raw !== '') init.body = raw;

  return target(new Request(url, init), ctx);
}

/* ── The four routes §8 specifies that no endpoint served ────────────────
   Generation, briefing and the edit grammar have always run in the browser —
   §9 requires it, so that briefing works with no network at all. That leaves
   nothing on the server for a partner to call, which is what these four fix.
   They call `assets/engine.js` through the Node loader, so a partner and the
   browser get the same six concepts for the same brief rather than two
   rankers that agree until they do not. */

const AXES_SET = () => new Set(engine().AXES);
const DENSITIES = ['airy', 'balanced', 'tight'];

/** A brief reduced to the closed sets the engine actually reads. Anything
 *  else a caller sends is dropped rather than passed through, so the brief id
 *  below is a digest of what was used and not of what was typed. */
function normaliseBrief(input) {
  const E = engine();
  const axes = AXES_SET();
  const raw = input && typeof input === 'object' ? input : {};

  const industry = E.INDUSTRIES[raw.industry] ? raw.industry : null;
  const personality = [...new Set((Array.isArray(raw.personality) ? raw.personality : [])
    .filter(p => axes.has(p)))].sort();
  const format = E.FORMATS.some(f => f.id === raw.format) ? raw.format : 'bd-std';
  const density = DENSITIES.includes(raw.density) ? raw.density : 'balanced';
  const script = raw.script === 'bangla' ? 'bangla' : 'latin';

  return { industry, personality, format, density, script };
}

/* Content-addressed, exactly like a spec hash and a quote id, and for the
   same reason: there is no `briefs` table, and a brief that names itself
   needs no row to be looked up in. `POST /v1/briefs/:id/generate` therefore
   takes the brief again and checks the id against it, rather than trusting a
   caller to say which brief a generation was for. */
const briefIdFor = (brief) =>
  'brf-' + crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex').slice(0, 16);

/** Content, reduced to the fields the composer reads. */
function normaliseContent(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of ['name', 'role', 'company', 'quals', 'bname', 'brole', 'bcompany',
                   'p1', 'p2', 'email', 'web', 'addr'])
    if (typeof c[k] === 'string') out[k] = c[k].slice(0, 200);
  return out;
}

async function specForCode(sql, code) {
  if (!CODE_RE.test(code))
    return [null, ERR.badRequest('That is not a design id.', { field: 'specId',
      remediation: 'A design id is the short code a save returns, like `f08e40a3`.' })];
  if (!sql) return [null, ERR.unavailable()];
  const rows = await sql`SELECT spec_json FROM design_specs WHERE short_code = ${code} LIMIT 1`;
  if (!rows.length) return [null, ERR.notFound('No saved design with that id.',
    { remediation: 'Save the design first — everything downstream of a spec is addressed by its id.' })];
  return [rows[0].spec_json, null];
}

/* ── Route handlers ─────────────────────────────────────────────────── */

async function postBriefs(req, sql) {
  const [body, bad] = await readJson(req, 64 * 1024);
  if (bad) return bad;

  const brief = normaliseBrief(body.input || body.brief || body);
  const briefId = briefIdFor(brief);

  const key = idempotencyKey(req);
  const replayed = await replay(sql, key, 'v1:briefs');
  if (replayed) return replayed;

  const E = engine();
  const intent = E.resolveIntent(brief);
  const payload = {
    briefId, brief,
    vector: intent.vector,
    avoid: intent.avoid,
    /* §4.2 and the ranker's own note: with nothing stated the vector is an
       industry prior rather than a preference, and the caller should be able
       to tell those apart without reading the prose. */
    inferred: !intent.stated.length,
    inferredFrom: intent.inferredFrom,
    note: intent.note
  };
  await remember(sql, key, 'v1:briefs', 201, payload);
  return ok(payload, 201);
}

async function generate(req, sql, briefId) {
  const [body, bad] = await readJson(req, 64 * 1024);
  if (bad) return bad;

  const brief = normaliseBrief(body.input || body.brief || body);
  const claimed = briefIdFor(brief);
  if (claimed !== briefId)
    return ERR.conflict('That brief id is not this brief.', {
      code: 'brief_mismatch', field: 'input', briefId: claimed,
      remediation: 'A brief id is a digest of the brief, so send the brief the id was issued for, or POST /v1/briefs again for a new id.'
    });

  const content = normaliseContent(body.content);
  if (!content.name)
    return ERR.badRequest('A card needs a name on it.', { field: 'content.name',
      remediation: 'Send the content the concepts should be composed with — at minimum a name and one contact route.' });

  const count = Math.min(Math.max(Number(body.count) || 6, 1), 12);
  const key = idempotencyKey(req);
  const replayed = await replay(sql, key, 'v1:generate');
  if (replayed) return replayed;

  const E = engine();
  const loaded = await loadLibrary(sql);
  const result = await withLibrary(E, loaded.library, () => {
    const g = E.generate(brief, content, { n: count });
    /* The spec is built and hashed inside the swap, because a hash taken
       against a different library would name a design nothing here composed. */
    return {
      specs: g.picked.map(c => {
        const spec = { format: brief.format, type: c.type, palette: c.palette,
                       density: brief.density, layout: c.layout, content };
        return { specId: null, specHash: E.specHash(spec), spec, score: c.score, why: c.why };
      }),
      trace: [
        { stage: 'intent', ...g.intent },
        { stage: 'enumerate', candidates: g.stages.enumerated },
        { stage: 'compose', survived: g.stages.composed, eliminated: g.stages.enumerated - g.stages.composed },
        { stage: 'preflight', survived: g.stages.printSafe },
        { stage: 'rank', scored: g.considered },
        { stage: 'diversify', returned: g.stages.selected }
      ],
      ms: g.ms
    };
  });

  /* §7.1's candidate cache key. It is returned rather than used, because
     nothing caches candidates yet — generation is 15 ms of arithmetic and a
     cache that saves nothing is a cache that can be wrong for free. What the
     key is for is the day it does: publishing a component rolls it, which is
     the property the caller can check now rather than trust later. */
  const payload = {
    briefId,
    libraryVersion: loaded.libraryVersion,
    librarySource: loaded.source,
    candidateKey: candidateKey({ vector: result.trace[0].vector, libraryVersion: loaded.libraryVersion, seed: body.seed ?? null }),
    ...result
  };

  if (!payload.specs.length)
    return ERR.unprocessable('No concept survived this brief.', {
      code: 'no_candidates', trace: payload.trace,
      remediation: 'Shorten the longest line, move the qualifications to the back, or try another format — nothing here will render a card that does not fit.'
    });

  await remember(sql, key, 'v1:generate', 200, payload);
  return ok(payload);
}

async function instruct(req, sql, specId) {
  const [body, bad] = await readJson(req, 64 * 1024);
  if (bad) return bad;

  let spec = body.spec && typeof body.spec === 'object' ? body.spec : null;
  if (!spec) {
    const [loaded, err] = await specForCode(sql, specId);
    if (err) return err;
    spec = loaded;
  }

  const E = engine();
  const text = typeof body.text === 'string' ? body.text : '';
  const given = Array.isArray(body.ops) ? body.ops : null;

  if (!text && !given)
    return ERR.badRequest('Send either the instruction as `text` or the operations as `ops`.', { field: 'text' });

  const classified = given ? { ops: given, matched: [], unmapped: false } : E.classifyInstruction(text);

  /* The honest refusal, and it is a 200 rather than an error: the request was
     understood perfectly, and the answer is that this system does not do
     that. §8's `unmapped[]` is what carries it. */
  if (classified.unmapped)
    return ok({ specId, ops: [], unmapped: [text], matched: [],
                suggestions: classified.suggestions || [], note: classified.note });

  const key = idempotencyKey(req);
  const replayed = await replay(sql, key, 'v1:instruct');
  if (replayed) return replayed;

  const loaded = await loadLibrary(sql);
  const result = await withLibrary(E, loaded.library, () => {
    const design = { format: spec.format, type: spec.type, palette: spec.palette,
                     density: spec.density, layout: spec.layout, corner: spec.corner || 0 };
    const applied = E.applyOps(design, classified.ops);
    const next = { ...spec, ...applied.design, content: spec.content };
    const composed = E.compose(next);
    return {
      design: applied.design, changes: applied.changes,
      spec: next, specHash: E.specHash(next),
      eliminated: composed.eliminated || null,
      findings: composed.eliminated ? [] : E.preflight(composed)
    };
  });

  const payload = { specId, ops: classified.ops, unmapped: [], matched: classified.matched,
                    libraryVersion: loaded.libraryVersion, ...result };
  await remember(sql, key, 'v1:instruct', 200, payload);
  return ok(payload);
}

async function render(req, ctx, sql, specId) {
  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') || 'preview';

  if (variant === 'print')
    return delegate('/api/render-print', new Request(url, { method: 'POST', headers: req.headers }), ctx,
      { body: { shortCode: specId } });

  if (variant !== 'preview')
    return ERR.badRequest(`There is no \`${variant}\` render.`, { field: 'variant',
      remediation: 'Ask for `preview` for the SVG, or `print` for the press file.' });

  const [spec, err] = await specForCode(sql, specId);
  if (err) return err;

  const E = engine();
  const loaded = await loadLibrary(sql);
  const out = await withLibrary(E, loaded.library, () => {
    const composed = E.compose(spec);
    return composed.eliminated ? { eliminated: composed.eliminated } : { svg: E.renderSVG(composed), hash: E.specHash(spec) };
  });

  if (out.eliminated)
    return ERR.unprocessable(`This design no longer composes: ${out.eliminated}`, {
      code: 'layout_eliminated', libraryVersion: loaded.libraryVersion,
      remediation: 'The design was saved against a library it can still be rendered from — ask for it pinned, at /api/components?pins=…, rather than against the current one.'
    });

  /* A preview is immutable by spec hash (§7.1), so it carries the cache
     headers of the CDN object it will become, and becomes a redirect the
     moment a CDN is configured rather than the moment this file is edited. */
  const cdn = (process.env.RENDER_CDN_BASE || '').replace(/\/+$/, '');
  const immutable = { 'cache-control': 'public, max-age=31536000, immutable', 'x-cardworks-render-key': `${out.hash}+preview` };
  if (cdn) return new Response(null, { status: 302, headers: { ...immutable, location: `${cdn}/${out.hash}/preview.svg` } });
  return new Response(out.svg, { status: 200, headers: { ...immutable, 'content-type': 'image/svg+xml; charset=utf-8' } });
}

/* ── The router ─────────────────────────────────────────────────────── */

const index = () => ok({
  api: 'cardworks', version: 'v1',
  routes: ROUTES.map(r => ({ method: r.method, path: r.pattern, does: r.note })),
  idempotency: 'Every mutating call accepts an Idempotency-Key; replaying one returns the first response.',
  errors: '{ code, message, field?, remediation? }'
});

const notFound = (path) => fail(404, 'no_such_route', `There is no ${path} in v1.`, {
  remediation: 'GET /v1 lists every route on this surface.'
});

/** The whole surface, with its database client passed in so the suite can
 *  drive it without a live Postgres. */
export async function route(req, ctx, sql) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

  if (parts[0] !== 'v1') return notFound(url.pathname);
  if (parts.length === 1) return req.method === 'GET' ? index()
    : fail(405, 'method_not_allowed', 'The route index is a GET.', { remediation: 'GET /v1.' });

  const [, head, a, b] = parts;
  const method = req.method;

  /* A body is read once here and forwarded as text, so a delegated handler
     parses exactly what the caller sent and nothing is re-serialised on the
     way through. Routes that lift an id out of the path merge it and send a
     body instead — that re-serialisation is the whole of what the router
     changes about a request. */
  const rawBody = method === 'POST' || method === 'PUT' ? await req.text() : undefined;
  if (rawBody !== undefined && rawBody.length > MAX_BODY) return ERR.tooLarge();
  const parsed = () => { try { return rawBody ? JSON.parse(rawBody) : {}; } catch { return null; } };
  const merged = (extra) => {
    const b = parsed();
    return b === null ? null : { ...b, ...extra };
  };
  const badJson = () => ERR.badRequest('The request body is not valid JSON.');

  if (head === 'briefs') {
    if (parts.length === 2 && method === 'POST') return postBriefs(new Request(url, { method, headers: req.headers, body: rawBody }), sql);
    if (parts.length === 4 && b === 'generate' && method === 'POST')
      return generate(new Request(url, { method, headers: req.headers, body: rawBody }), sql, a);
    return notFound(url.pathname);
  }

  if (head === 'specs') {
    if (parts.length === 2 && method === 'POST') return delegate('/api/designs', req, ctx, { raw: rawBody });
    if (parts.length === 3 && method === 'GET') return delegate('/api/designs', req, ctx, { search: { code: a } });

    if (parts.length === 4) {
      if (b === 'instruct' && method === 'POST')
        return instruct(new Request(url, { method, headers: req.headers, body: rawBody }), sql, a);
      if (b === 'render' && method === 'GET') return render(req, ctx, sql, a);
      if (b === 'preflight' && method === 'POST') {
        /* The unversioned endpoint takes the design as a short code or as a
           design-and-content pair, and the validate screen needs the second
           for a design nobody has saved yet. So the id from the path fills in
           the short code only when the body did not bring a design of its
           own — a `/v1` path must not make the unsaved case unreachable. */
        const body = merged({});
        if (body === null) return badJson();
        if (!body.design && !body.shortCode) body.shortCode = a;
        return delegate('/api/preflight', req, ctx, { body });
      }
      if (b === 'export' && method === 'POST') {
        const body = merged({});
        if (body === null) return badJson();
        if (!body.spec && !body.shortCode) body.shortCode = a;
        return delegate('/api/render-print', req, ctx, { body });
      }
    }
    return notFound(url.pathname);
  }

  if (head === 'quotes' && parts.length === 2 && method === 'POST')
    return delegate('/api/quotes', req, ctx, { raw: rawBody });

  if (head === 'orders' && parts.length === 2 && (method === 'GET' || method === 'POST'))
    return delegate('/api/orders', req, ctx, { raw: rawBody });

  if (head === 'payments') {
    if (parts.length === 3 && method === 'GET') return delegate('/api/payments', req, ctx, { search: { ref: a } });
    if (parts.length === 4 && b === 'capture' && method === 'POST') {
      const body = merged({ ref: a });
      if (body === null) return badJson();
      /* §8 sends `{ provider, token }`. The endpoint underneath distinguishes
         starting a capture from completing one, and which of the two this is
         is decided by whether the caller holds a provider reference yet —
         bKash and Nagad hand one back only after the customer has typed their
         PIN. Naming `action` explicitly still wins, so a caller that knows
         which half it is doing is never second-guessed. */
      if (!body.action) body.action = (body.token || body.providerRef) ? 'complete' : 'begin';
      if (body.token && !body.providerRef) body.providerRef = body.token;
      return delegate('/api/payments', req, ctx, { body });
    }
    return notFound(url.pathname);
  }

  if (head === 'components' && parts.length === 2 && (method === 'GET' || method === 'POST'))
    return delegate('/api/components', req, ctx, { raw: rawBody });

  if (head === 'enhance' && parts.length === 2 && (method === 'GET' || method === 'POST'))
    return delegate('/api/enhance', req, ctx, { raw: rawBody });

  if (head === 'destructure' && parts.length === 2 && (method === 'GET' || method === 'POST'))
    return delegate('/api/destructure', req, ctx, { raw: rawBody });

  return notFound(url.pathname);
}

export default handler('v1', (req, ctx) => route(req, ctx, db()));

/* Declared route by route rather than as `/v1/*`, so the surface a deploy
   actually serves is the same list this file routes on and `GET /v1`
   advertises. A path that exists in one and not the others is then a
   deployment that fails rather than a 404 a partner discovers. */
export const config = {
  path: [
    '/v1',
    '/v1/briefs',
    '/v1/briefs/:id/generate',
    '/v1/specs',
    '/v1/specs/:id',
    '/v1/specs/:id/instruct',
    '/v1/specs/:id/render',
    '/v1/specs/:id/preflight',
    '/v1/specs/:id/export',
    '/v1/quotes',
    '/v1/orders',
    '/v1/payments/:orderId',
    '/v1/payments/:orderId/capture',
    '/v1/components',
    '/v1/enhance',
    '/v1/destructure'
  ]
};
