import { query } from '../db/pool';

// Read-only reporting. These queries run against the same pool as the API but
// never write; the admin dashboard calls them directly.

export interface SalesSummary {
  orderCount: number;
  grossCents: number;
  refundedCents: number;
  averageOrderCents: number;
}

export async function salesSummary(sinceDays = 30): Promise<SalesSummary> {
  const rows = await query<{ orders: string; gross: string; refunded: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status <> 'cancelled') AS orders,
       COALESCE(SUM(total_cents) FILTER (WHERE status <> 'cancelled'), 0) AS gross,
       COALESCE(SUM(total_cents) FILTER (WHERE status = 'refunded'), 0) AS refunded
     FROM orders
     WHERE created_at >= now() - ($1 || ' days')::interval`,
    [sinceDays],
  );

  const row = rows[0];
  const orderCount = Number(row?.orders ?? 0);
  const grossCents = Number(row?.gross ?? 0);
  const refundedCents = Number(row?.refunded ?? 0);

  return {
    orderCount,
    grossCents,
    refundedCents,
    averageOrderCents: orderCount === 0 ? 0 : Math.round(grossCents / orderCount),
  };
}

export async function topProducts(limit = 10): Promise<{ productId: string; units: number }[]> {
  const rows = await query<{ product_id: string; units: string }>(
    `SELECT product_id, SUM(quantity) AS units
     FROM order_lines GROUP BY product_id ORDER BY units DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ productId: r.product_id, units: Number(r.units) }));
}
