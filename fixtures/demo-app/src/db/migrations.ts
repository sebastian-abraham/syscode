import { query } from './pool';
import { logger } from '../shared/logger';

// Migrations are plain SQL strings applied in order. We track the highest
// applied index in a single-row table rather than pulling in a full framework.

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     email TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'customer',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS products (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     sku TEXT UNIQUE NOT NULL,
     name TEXT NOT NULL,
     price_cents INTEGER NOT NULL,
     stock INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES users(id),
     status TEXT NOT NULL,
     total_cents INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS order_lines (
     order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     product_id UUID NOT NULL REFERENCES products(id),
     quantity INTEGER NOT NULL,
     unit_price_cents INTEGER NOT NULL,
     PRIMARY KEY (order_id, product_id)
   )`,
  `CREATE TABLE IF NOT EXISTS payments (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     order_id UUID NOT NULL REFERENCES orders(id),
     stripe_charge_id TEXT,
     amount_cents INTEGER NOT NULL,
     status TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

const META = `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)`;

export async function migrate(): Promise<number> {
  await query(META);
  const current = await query<{ version: number }>(
    'SELECT COALESCE(MAX(version), -1) AS version FROM schema_migrations',
  );
  let version = current[0]?.version ?? -1;

  for (let i = version + 1; i < MIGRATIONS.length; i++) {
    logger.info('applying migration', { version: i });
    await query(MIGRATIONS[i]);
    await query('INSERT INTO schema_migrations (version) VALUES ($1)', [i]);
    version = i;
  }
  return version;
}

export const migrationCount = MIGRATIONS.length;
