/* Cash on delivery.
 *
 * This is a first-class payment method, not a fallback for when the rails are
 * down. For a large share of the market it is the only method they will use,
 * and treating it as an absence of payment is how a product ends up unable to
 * tell an unpaid order from a delivered-and-settled one.
 *
 * It implements the same interface as bKash and Nagad and differs in exactly
 * one declared way: `kind` is 'offline'. That word is what tells the
 * orchestration in index.mjs that raising the intent is enough to start the
 * run — the customer has approved the proof and committed to pay the courier —
 * while capture happens later, when a human confirms the notes were handed
 * over. Nothing about proof-before-charge is weakened by this: no money is
 * taken before approval here either, because no money is taken at all until
 * the card is in the customer's hand.
 *
 * There is no simulated transport because there is no transport. The reference
 * is the order's own, which is what the courier's manifest will carry.
 */
import { PaymentError } from './provider.mjs';

export const id = 'cod';
export const label = 'Cash on delivery';
export const kind = 'offline';

export const configured = () => true;
export const simulated = () => false;

export async function createIntent({ orderRef }) {
  return { providerRef: `COD-${orderRef}`, redirectURL: null, extra: { collectAt: 'handover' } };
}

/* Settlement is somebody asserting the money arrived, so it carries who said
   so. An unattributed cash settlement is not evidence of anything. */
export async function capture({ orderRef, amount, actor }) {
  if (!actor || actor === 'customer')
    throw new PaymentError('cod_needs_courier',
      'A cash settlement has to be recorded by the courier or the shop, not the customer.',
      { orderRef });
  return { providerTxn: `COD-${orderRef}-${Date.now()}`, amount: Math.round(amount) };
}

export async function query({ providerRef }) {
  return { status: 'intent', amount: null, providerTxn: providerRef };
}

/* Refunding cash is a physical act. Recording it is honest; pretending this
   module performed it is not, so the caller gets a reference and the incident
   that it opened stays open until a human closes it. */
export async function refund({ providerRef, amount }) {
  return { providerRef: `COD-REFUND-${providerRef}-${Math.round(amount)}`, manual: true };
}
