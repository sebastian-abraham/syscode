import Stripe from 'stripe';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { PaymentError } from './types';

// The only file that imports the Stripe SDK. Everything else talks to
// charge.ts / refund.ts, which use this thin client.

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!client) {
    if (!config.stripeSecretKey) throw new PaymentError('stripe is not configured');
    client = new Stripe(config.stripeSecretKey, { apiVersion: '2024-04-10' });
  }
  return client;
}

export async function createStripeCharge(
  amountCents: number,
  paymentMethodId: string,
  idempotencyKey?: string,
): Promise<Stripe.PaymentIntent> {
  try {
    return await stripe().paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        payment_method: paymentMethodId,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;
    logger.error('stripe charge failed', { code: stripeErr.code });
    throw new PaymentError(stripeErr.message, stripeErr.decline_code ?? null);
  }
}

export async function createStripeRefund(chargeId: string, amountCents: number): Promise<Stripe.Refund> {
  return stripe().refunds.create({ payment_intent: chargeId, amount: amountCents });
}

export function constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(payload, signature, config.stripeWebhookSecret);
}
