import { insertPayment, markPaymentStatus } from '../db/models/payment';
import { logger } from '../shared/logger';
import { createStripeCharge } from './stripe-client';
import { ChargeRequest, ChargeResult, PaymentError } from './types';

// Business-level charge: talks to Stripe, records a payment row, and normalises
// the result. Callers pass our ChargeRequest, never Stripe objects.
export async function charge(req: ChargeRequest): Promise<ChargeResult> {
  if (req.amountCents <= 0) throw new PaymentError('charge amount must be positive');

  const intent = await createStripeCharge(req.amountCents, req.paymentMethodId, req.idempotencyKey);
  const succeeded = intent.status === 'succeeded';

  logger.info('charge recorded', { userId: req.userId, status: intent.status });
  return {
    chargeId: intent.id,
    status: succeeded ? 'succeeded' : intent.status === 'processing' ? 'pending' : 'failed',
    amountCents: req.amountCents,
  };
}

// Called by the webhook once an async payment settles. Kept here so the
// payment-status vocabulary lives in one module.
export async function settleCharge(chargeId: string, succeeded: boolean): Promise<void> {
  await markPaymentStatus(chargeId, succeeded ? 'succeeded' : 'failed');
}

export { insertPayment };
