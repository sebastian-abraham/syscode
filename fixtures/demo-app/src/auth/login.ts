import { findUserByEmail } from '../db/models/user';
import type { User } from '../db/models/user';
import { UnauthorizedError } from '../shared/errors';
import { logger } from '../shared/logger';
import { verifyPassword } from './password';
import { signToken } from './jwt';
import { createSession } from './session';

export interface LoginResult {
  user: User;
  token: string; // JWT for API clients
  sessionToken: string; // opaque token for the browser cookie
}

// One entry point for both auth styles. We always do a password comparison even
// when the user is missing to keep the response time flat.
export async function login(email: string, password: string): Promise<LoginResult> {
  const row = await findUserByEmail(email);
  const storedHash = row?.password_hash ?? 'scrypt$00$00';
  const ok = await verifyPassword(password, storedHash);

  if (!row || !ok) {
    logger.warn('failed login', { email });
    throw new UnauthorizedError('invalid email or password');
  }

  const user: User = { id: row.id, email: row.email, role: row.role };
  const [token, sessionToken] = await Promise.all([
    Promise.resolve(signToken({ sub: user.id, role: user.role, email: user.email })),
    createSession(user.id),
  ]);

  logger.info('login ok', { userId: user.id });
  return { user, token, sessionToken };
}
