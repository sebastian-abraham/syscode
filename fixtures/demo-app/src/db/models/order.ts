import { one, query } from '../pool';
import { OrderStatus } from '../../orders/order-status';

export interface OrderRow {
  id: string;
  user_id: string;
  status: OrderStatus;
  total_cents: number;
  created_at: Date;
}

export interface OrderLineRow {
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price_cents: number;
}

export async function insertOrder(
  userId: string,
  status: OrderStatus,
  totalCents: number,
): Promise<OrderRow> {
  const row = await one<OrderRow>(
    `INSERT INTO orders (user_id, status, total_cents)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, status, total_cents, created_at`,
    [userId, status, totalCents],
  );
  if (!row) throw new Error('insertOrder returned no row');
  return row;
}

export async function insertOrderLines(
  orderId: string,
  lines: { productId: string; quantity: number; unitPriceCents: number }[],
): Promise<void> {
  for (const line of lines) {
    await query(
      `INSERT INTO order_lines (order_id, product_id, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4)`,
      [orderId, line.productId, line.quantity, line.unitPriceCents],
    );
  }
}

export async function findOrderById(id: string): Promise<OrderRow | null> {
  return one<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
}

export async function listOrdersForUser(userId: string): Promise<OrderRow[]> {
  return query<OrderRow>('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
}

export async function listRecentOrders(limit = 100): Promise<OrderRow[]> {
  return query<OrderRow>('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1', [limit]);
}
