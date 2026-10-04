import { requirePermission } from '../auth/permissions';
import type { User } from '../db/models/user';
import { charge } from '../payments/charge';
import { enqueue } from '../notifications/queue';
import { logger } from '../shared/logger';
import { parse, cartSchema } from '../shared/validation';
import { validateCart } from './validate-cart';
import { reserveStock } from './reserve-stock';
import { createOrderRecord } from './order-repo';
import { assertTransition } from './order-status';
import type { OrderRow } from '../db/models/order';

export interface CheckoutInput {
  user: Pick<User, 'id' | 'role'>;
  paymentMethodId: string;
  body: unknown;
}

// The checkout flow itself: validate -> reserve -> charge -> persist -> notify.
// If the charge fails we release the reservation and rethrow; the caller sees a
// failed checkout and the stock is back on the shelf.
export async function createOrder(input: CheckoutInput): Promise<OrderRow> {
  requirePermission(input.user, 'order:read_own');

  const cart = parse(cartSchema, input.body, 'cart');
  const priced = await validateCart(cart);
  const release = await reserveStock(priced.lines);

  let chargeId: string;
  try {
    const result = await charge({
      userId: input.user.id,
      amountCents: priced.totalCents,
      paymentMethodId: input.paymentMethodId,
    });
    chargeId = result.chargeId;
  } catch (err) {
    await release();
    throw err;
  }

  const order = await createOrderRecord(input.user.id, 'pending', priced.lines, priced.totalCents);
  assertTransition('pending', 'paid');

  await enqueue('order.created', {
    orderId: order.id,
    userId: input.user.id,
    totalCents: priced.totalCents,
    chargeId,
  });

  logger.info('order created', { orderId: order.id, userId: input.user.id });
  return order;
}
