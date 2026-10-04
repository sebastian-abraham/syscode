import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../shared/logger';
import { isAppError } from '../shared/errors';

// HTTP-level helpers shared by every route. Routes never write to res directly
// for errors; they throw and the middleware maps the error to a status.

export interface RequestContext {
  requestId: string;
  user?: { id: string; email: string; role: 'customer' | 'admin' };
}

export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

// Wrap an async handler so rejected promises reach the error middleware instead
// of crashing the process.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export function readRawBody(req: Request): Buffer {
  return (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
}

export function requestId(): string {
  return randomUUID();
}

// Central error translator. AppError carries its own status; anything else is a
// 500 and gets logged with the request id for correlation.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (isAppError(err)) {
    sendJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  logger.error('unhandled error', { requestId: (req as Request & RequestContext).requestId, err: String(err) });
  sendJson(res, 500, { error: 'internal_error', message: 'something went wrong' });
}
