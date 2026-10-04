import { constructWebhookEvent } from './stripe-client';
import { markPaymentStatus, findPaymentByOrder } from '../db/models/payment';
import { enqueue } from '../notifications/queue';
import { logger } from '../shared/logger';
import { ValidationError } from '../shared/errors';

// Stripe calls this on payment_intent events. The order id rides along in
// payment_intent metadata, which is how we map back to our own records.
export async function handleStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
  if (!signature) throw new ValidationError('missing stripe signature');

  const event = constructWebhookEvent(rawBody, signature);
  logger.info('stripe webhook', { type: event.type });

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object as { id: string; metadata?: { orderId?: string } };
      const orderId = intent.metadata?.orderId;
      if (!orderId) break;
      await markPaymentStatus(orderId, 'succeeded');
      await enqueue('payment.succeeded', { orderId, chargeId: intent.id });
      break;
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as { id: string; metadata?: { orderId?: string } };
      if (!intent.metadata?.orderId) break;
      await markPaymentStatus(intent.metadata.orderId, 'failed');
      await enqueue('payment.failed', { orderId: intent.metadata.orderId });
      break;
    }
    default:
      // Ignore event types we do not act on rather than 500-ing back to Stripe.
      break;
  }
}

export { findPaymentByOrder };
