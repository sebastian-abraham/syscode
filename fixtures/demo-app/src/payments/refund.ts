import { getOrderOrThrow } from '../orders/order-repo';
import { findPaymentByOrder, markPaymentStatus } from '../db/models/payment';
import { ConflictError } from '../shared/errors';
import { logger } from '../shared/logger';
import { createStripeRefund } from './stripe-client';
import { PaymentError, RefundResult } from './types';

// Refund the charge attached to an order. Admins trigger this from the admin
// route; there is no customer-facing refund endpoint yet.
export async function refundOrder(orderId: string): Promise<RefundResult> {
  const order = await getOrderOrThrow(orderId);
  const payment = await findPaymentByOrder(orderId);

  if (!payment) throw new PaymentError('no payment on file for this order');
  if (payment.status === 'refunded') throw new ConflictError('order is already refunded');
  if (!payment.stripe_charge_id) throw new PaymentError('payment has no charge id');

  const result = await createStripeRefund(payment.stripe_charge_id, order.total_cents);
  await markPaymentStatus(orderId, 'refunded');

  logger.info('order refunded', { orderId, amountCents: order.total_cents });
  return { refundId: result.id, amountCents: order.total_cents, status: 'refunded' };
}
