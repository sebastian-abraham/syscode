import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../shared/config';
import { logger } from '../shared/logger';

// One shared pool for the process. The worker imports this too, so both the
// API and the background worker draw from the same connection budget.

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

pool.on('error', (err) => logger.error('idle pg client error', { err: err.message }));

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  const result = await pool.query<T>(sql, params as never[]);
  if (Date.now() - started > 250) {
    logger.warn('slow query', { ms: Date.now() - started, sql: sql.slice(0, 80) });
  }
  return result.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

// Run several statements on a single client inside a transaction. Callers give
// us the work; we own BEGIN/COMMIT/ROLLBACK so no service forgets to clean up.
export async function transaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
