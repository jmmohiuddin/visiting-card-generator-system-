/* Vercel adapter.
 *
 * Every endpoint in netlify/functions is a Web-standard handler:
 * `async (Request) => Response`. That is deliberate — it is the shape the
 * platform-independent half of the app is written against, and it is why
 * porting to a second host is an adapter rather than a rewrite. The handlers
 * themselves are imported unchanged; there is exactly one implementation of
 * each endpoint and both hosts run it.
 *
 * Vercel's Node runtime hands a function `(req, res)` in Node's own shape, so
 * this converts in both directions. Edge runtime would take the Web shape
 * directly and skip all of this, but it cannot: `lib/engine-node.mjs` reads
 * assets/engine.js off disk so the server composes with byte-identical code
 * to the browser, and there is no filesystem on the edge.
 */

/** Node's IncomingMessage → a Web Request. */
async function toRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const url = new URL(req.url, `${proto}://${host}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    // A repeated header arrives as an array; a Web Headers wants them appended.
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else headers.set(k, String(v));
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
    // A zero-length body must be undefined rather than an empty buffer, or
    // fetch's Request rejects it for methods that disallow a body.
    if (!body.length) body = undefined;
  }

  return new Request(url, { method: req.method, headers, body });
}

/** A Web Response → Node's ServerResponse. */
async function send(res, webRes) {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    // set-cookie is the one header that may legitimately repeat; Headers
    // joins it with ", " which breaks cookie parsing, so split it back out.
    if (key.toLowerCase() === 'set-cookie' && typeof webRes.headers.getSetCookie === 'function') {
      res.setHeader('set-cookie', webRes.headers.getSetCookie());
    } else {
      res.setHeader(key, value);
    }
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

/** Wrap a Web handler so Vercel's Node runtime can serve it. */
export function bridge(handler) {
  return async function vercelHandler(req, res) {
    try {
      const webRes = await handler(await toRequest(req));
      await send(res, webRes);
    } catch (err) {
      // Never leak a stack or a connection string into a response body.
      console.error('bridge failed:', err && err.message);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'server_error', message: 'Something went wrong.' } }));
    }
  };
}
