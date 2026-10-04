import type { Request, Response, NextFunction } from 'express';
import { verifyToken, bearerToken } from '../auth/jwt';
import { resolveSession } from '../auth/session';
import { findUserById } from '../db/models/user';
import { UnauthorizedError } from '../shared/errors';
import { logger } from '../shared/logger';
import { requestId } from './http';
import type { RequestContext } from './http';

export type AuthedRequest = Request & RequestContext & { user: NonNullable<RequestContext['user']> };

// Resolve the caller from either an Authorization: Bearer JWT or the session
// cookie the browser flow sets. The user is attached to the request so routes
// can pass it straight into permission checks.
export async function authenticate(req: Request): Promise<RequestContext['user'] | null> {
  const header = req.headers.authorization;
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.session;

  if (header) {
    const claims = verifyToken(bearerToken(header));
    return { id: claims.sub, email: claims.email, role: claims.role };
  }
  if (cookie) {
    const userId = await resolveSession(cookie);
    if (!userId) return null;
    const user = await findUserById(userId);
    return user ? { id: user.id, email: user.email, role: user.role } : null;
  }
  return null;
}

export const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
  authenticate(req)
    .then((user) => {
      (req as AuthedRequest).user = user as NonNullable<RequestContext['user']>;
      if (!user) throw new UnauthorizedError();
      next();
    })
    .catch(next);
};

// Attaches an id and logs the request once the response is finished.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const id = requestId();
  (req as Request & RequestContext).requestId = id;
  const started = Date.now();
  res.on('finish', () => {
    logger.info('http', { id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
  });
  next();
}
