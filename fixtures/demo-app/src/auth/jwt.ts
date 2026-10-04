import jwt from 'jsonwebtoken';
import { config } from '../shared/config';
import { UnauthorizedError } from '../shared/errors';
import type { Role } from './permissions';

export interface TokenClaims {
  sub: string; // user id
  role: Role;
  email: string;
}

export function signToken(claims: TokenClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: config.jwtTtlSeconds });
}

export function verifyToken(token: string): TokenClaims {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload & TokenClaims;
    return { sub: decoded.sub as string, role: decoded.role, email: decoded.email };
  } catch {
    throw new UnauthorizedError('invalid or expired token');
  }
}

export function bearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('missing bearer token');
  return header.slice('Bearer '.length);
}
