import { one, query } from '../pool';

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

export interface PaymentRow {
  id: string;
  order_id: string;
  stripe_charge_id: string | null;
  amount_cents: number;
  status: PaymentStatus;
  created_at: Date;
}

export async function insertPayment(
  orderId: string,
  amountCents: number,
  status: PaymentStatus,
  stripeChargeId: string | null,
): Promise<PaymentRow> {
  const row = await one<PaymentRow>(
    `INSERT INTO payments (order_id, amount_cents, status, stripe_charge_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [orderId, amountCents, status, stripeChargeId],
  );
  if (!row) throw new Error('insertPayment returned no row');
  return row;
}

export async function findPaymentByOrder(orderId: string): Promise<PaymentRow | null> {
  return one<PaymentRow>('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [
    orderId,
  ]);
}

export async function markPaymentStatus(orderId: string, status: PaymentStatus): Promise<void> {
  await query('UPDATE payments SET status = $1 WHERE order_id = $2', [status, orderId]);
}
