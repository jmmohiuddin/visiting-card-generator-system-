/* What this caller has bought.
 *
 * A read-only endpoint, on purpose. Every other function in this codebase that
 * changes something takes a POST; this one refuses one, because the only thing
 * a POST here could mean is "grant me an entitlement", and an entitlement a
 * caller can ask for is not an entitlement. Grants come from
 * `grantFromPayment` in lib/entitlements.mjs, which derives every stored column
 * from a captured payment row, and there is no route from an HTTP body to that
 * function. The 405 below says so rather than leaving the absence to be
 * inferred from a missing branch.
 *
 * The screen needs this because a gate the customer only meets at the moment
 * they press a button is a worse gate: `assets/ui-order.js` asks here first so
 * the Export screen can state the price up front instead of offering a control
 * that will refuse.
 *
 * This endpoint is the polite version, not the enforcement. The refusal that
 * protects the file is `assertEntitled`, which belongs in the two endpoints
 * that hand something over — `render-print.mjs` and `orders.mjs` — for the
 * same reason `lib/preflight-gate.mjs` had to move server-side: a guarantee
 * that lives in a browser is one a browser can skip.
 */
import { handler, ok, ERR, fail, db, CODE_RE } from '../../lib/http.mjs';
import {
  entitlementsFor, actorFrom, FREE_TIER, FILE_PACK, SPEC_HASH_RE
} from '../../lib/entitlements.mjs';

export default handler('entitlements', async (req) => {
  /* Both of these answer before the database is reached, and deliberately.
     "There is nothing to post here" is a fact about this endpoint rather than
     about a deploy, and a 503 in its place would read as "try again later" —
     which for a caller hoping to grant themselves something is exactly the
     wrong answer. The price list is a constant for the same reason. */
  if (req.method !== 'GET')
    return fail(405, 'method_not_allowed',
      'Entitlements are read here. They are granted only by a captured payment, so there is nothing to post.');

  const url = new URL(req.url);

  /* The price list, for a screen that wants to say what the file pack costs
     before the customer has saved anything. Answering this without a design
     keeps `assets/ui-misc.js` from carrying a second copy of the number. */
  if (url.searchParams.get('tiers') === '1')
    return ok({ free: FREE_TIER, filePack: FILE_PACK });

  /* A design is named either by its content hash or by the short code that is
     its public name. Neither is trusted: the hash is shape-checked and the code
     is resolved through `design_specs` inside `entitlementsFor`, so a caller
     cannot read entitlements against a hash they invented — and would learn
     nothing if they could, because the row also has to match their holder. */
  const specHash = String(url.searchParams.get('specHash') || '').trim().toLowerCase();
  const shortCode = String(url.searchParams.get('code') || '').trim();
  if (!SPEC_HASH_RE.test(specHash) && !CODE_RE.test(shortCode))
    return ERR.badRequest('Name a design by specHash or by its saved code.', { field: 'code' });

  const sql = db();
  if (!sql) return ERR.unavailable();

  const actor = await actorFrom(req, sql);
  const ent = await entitlementsFor(sql, { specHash: specHash || null, shortCode, ...actor });

  /* A code that names no saved design is not an error to a screen that has
     just minted one and raced the write; it is the free tier, which is what a
     design nobody has bought is anyway. */
  if (ent.unreadable === 'bad_spec_hash')
    return ERR.notFound('No saved design with that code.');

  /* A read that could not run is not "you have nothing" — that would tell a
     customer who has paid that they have not. It is a deploy that is missing
     migration 008, and saying so is the difference between a bug someone fixes
     and a support ticket about a lost purchase. */
  if (ent.unreadable)
    return ERR.unavailable('Purchases cannot be read on this deploy.',
      { remediation: 'contact_support',
        remediationText: 'This is a deployment gap on our side. Nothing you have designed or paid for is affected.' });

  return ok({
    specHash: ent.specHash,
    tier: ent.tier,
    may: ent.may,
    watermark: ent.watermark,
    grants: ent.grants,
    identity: actor.userId ? 'account' : (actor.ownerKey ? 'browser' : 'anonymous'),
    filePack: FILE_PACK
  });
});

export const config = { path: '/api/entitlements' };
