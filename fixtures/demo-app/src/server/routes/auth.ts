import { Router } from 'express';
import { login } from '../../auth/login';
import { destroySession } from '../../auth/session';
import { parse, emailSchema } from '../../shared/validation';
import { asyncHandler, sendJson } from '../http';
import { z } from 'zod';
import { authenticate } from '../middleware';

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(8),
});

export const authRouter = Router();

// POST /auth/login -> { token, sessionToken, user }
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body, 'login');
    const result = await login(body.email, body.password);
    res.cookie?.('session', result.sessionToken, { httpOnly: true, sameSite: 'lax' });
    sendJson(res, 200, { token: result.token, user: result.user });
  }),
);

// POST /auth/logout -> clears the browser session row.
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = (req as typeof req & { cookies?: Record<string, string> }).cookies?.session;
    if (token) await destroySession(token);
    sendJson(res, 204, null);
  }),
);

// GET /auth/me -> the caller's identity, or 401 if unauthenticated.
authRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = await authenticate(req);
    sendJson(res, user ? 200 : 401, user ?? { error: 'unauthorized' });
  }),
);
