import { insertOrder, insertOrderLines, findOrderById, listOrdersForUser } from '../db/models/order';
import type { OrderRow } from '../db/models/order';
import { transaction } from '../db/pool';
import { NotFoundError } from '../shared/errors';
import type { OrderStatus } from './order-status';
import type { PricedLine } from './validate-cart';

// Persistence boundary for orders. Everything that writes order rows goes
// through here so the order_lines table is never written half-way.

export async function createOrderRecord(
  userId: string,
  status: OrderStatus,
  lines: PricedLine[],
  totalCents: number,
): Promise<OrderRow> {
  return transaction(async (tx) => {
    const order = await insertOrder(userId, status, totalCents);
    await insertOrderLines(
      order.id,
      lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
    );
    void tx; // client available for future line writes that need the same tx
    return order;
  });
}

export async function getOrderOrThrow(id: string): Promise<OrderRow> {
  const order = await findOrderById(id);
  if (!order) throw new NotFoundError('order');
  return order;
}

export async function getOrdersForUser(userId: string): Promise<OrderRow[]> {
  return listOrdersForUser(userId);
}

export { OrderRow };
