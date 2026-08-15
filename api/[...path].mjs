/* One function, every endpoint.
 *
 * Netlify gives each handler its own lambda via `export const config.path`.
 * Vercel's Hobby plan allows twelve functions per deployment and there are
 * fourteen endpoints, so this is a single catch-all that dispatches on the
 * path instead. That is not only a workaround: one function means one cold
 * start for the whole API rather than fourteen, and the handlers are still
 * the same shared modules — nothing about the endpoints themselves changes.
 *
 * A catch-all route, rather than a rewrite to a fixed file, because the
 * handlers read the request URL: card.mjs takes the short code from the last
 * path segment, and several others read query parameters. `[...path]` keeps
 * the original URL intact where a rewrite to /api/index would not.
 */
import { bridge } from './_bridge.mjs';

import auth from '../netlify/functions/auth.mjs';
import card from '../netlify/functions/card.mjs';
import components from '../netlify/functions/components.mjs';
import designs from '../netlify/functions/designs.mjs';
import destructure from '../netlify/functions/destructure.mjs';
import enhance from '../netlify/functions/enhance.mjs';
import entitlements from '../netlify/functions/entitlements.mjs';
import metrics from '../netlify/functions/metrics.mjs';
import orders from '../netlify/functions/orders.mjs';
import payments from '../netlify/functions/payments.mjs';
import preflight from '../netlify/functions/preflight.mjs';
import quotes from '../netlify/functions/quotes.mjs';
import renderPrint from '../netlify/functions/render-print.mjs';
import v1 from '../netlify/functions/v1.mjs';

const ROUTES = {
  auth, components, designs, destructure, enhance, entitlements,
  metrics, orders, payments, preflight, quotes, v1,
  'render-print': renderPrint,
  c: card                    // /c/:code, rewritten to /api/c/:code
};

const notFound = (name) => new Response(
  JSON.stringify({ error: { code: 'not_found', message: `No endpoint at /api/${name}.` } }),
  { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default bridge(async (req) => {
  // /api/designs → "designs"; /api/c/ab12cd34 → "c"
  const seg = new URL(req.url).pathname.split('/').filter(Boolean);
  const name = seg[0] === 'api' ? seg[1] : seg[0];
  const handler = ROUTES[name];
  return handler ? handler(req) : notFound(name || '');
});
