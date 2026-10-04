import { query } from '../db/pool';

// Shop funnel: how many people got from a cart to a paid order this week.
// We approximate "carts started" from orders plus abandoned checkouts, which
// the app records as cancelled orders with no payment.

export interface FunnelStep {
  stage: 'checkout_started' | 'payment_succeeded' | 'orders_fulfilled';
  count: number;
}

export async function checkoutFunnel(sinceDays = 7): Promise<FunnelStep[]> {
  const rows = await query<{ started: string; paid: string; fulfilled: string }>(
    `SELECT
       COUNT(*) AS started,
       COUNT(*) FILTER (WHERE status IN ('paid','fulfilled','refunded')) AS paid,
       COUNT(*) FILTER (WHERE status = 'fulfilled') AS fulfilled
     FROM orders
     WHERE created_at >= now() - ($1 || ' days')::interval`,
    [sinceDays],
  );

  const row = rows[0];
  return [
    { stage: 'checkout_started', count: Number(row?.started ?? 0) },
    { stage: 'payment_succeeded', count: Number(row?.paid ?? 0) },
    { stage: 'orders_fulfilled', count: Number(row?.fulfilled ?? 0) },
  ];
}

export function conversionRate(steps: FunnelStep[]): number {
  const first = steps[0]?.count ?? 0;
  const last = steps[steps.length - 1]?.count ?? 0;
  return first === 0 ? 0 : last / first;
}
