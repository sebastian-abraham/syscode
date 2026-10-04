import { one, query } from '../pool';

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  price_cents: number;
  stock: number;
}

export async function findProductById(id: string): Promise<ProductRow | null> {
  return one<ProductRow>('SELECT * FROM products WHERE id = $1', [id]);
}

export async function findProductsByIds(ids: string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return [];
  return query<ProductRow>('SELECT * FROM products WHERE id = ANY($1)', [ids]);
}

export async function listProducts(limit = 100): Promise<ProductRow[]> {
  return query<ProductRow>('SELECT * FROM products ORDER BY name ASC LIMIT $1', [limit]);
}

// Decrements stock only if enough is available, in one statement, so two
// concurrent checkouts cannot oversell the last unit.
export async function decrementStock(productId: string, quantity: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING id',
    [quantity, productId],
  );
  return rows.length === 1;
}

export async function restock(productId: string, quantity: number): Promise<void> {
  await query('UPDATE products SET stock = stock + $1 WHERE id = $2', [quantity, productId]);
}
