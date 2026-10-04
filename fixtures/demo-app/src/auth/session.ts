import { randomUUID } from 'crypto';
import { one, query } from '../db/pool';
import { config } from '../shared/config';
import { hashPassword, verifyPassword } from './password';

// Server-side sessions back the browser flow; the JWT path (see jwt.ts) is for
// API clients. A session is just an opaque token row with an expiry.

export interface SessionRow {
  token: string;
  user_id: string;
  expires_at: Date;
}

export async function createSession(userId: string): Promise<string> {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + config.jwtTtlSeconds * 1000);
  await query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    userId,
    expiresAt,
  ]);
  return token;
}

export async function resolveSession(token: string): Promise<string | null> {
  const row = await one<SessionRow>(
    'SELECT * FROM sessions WHERE token = $1 AND expires_at > now()',
    [token],
  );
  return row?.user_id ?? null;
}

export async function destroySession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function pruneExpiredSessions(): Promise<number> {
  const rows = await query<{ token: string }>(
    'DELETE FROM sessions WHERE expires_at <= now() RETURNING token',
  );
  return rows.length;
}

// Re-exported so callers have one place for credential handling.
export { hashPassword, verifyPassword };
