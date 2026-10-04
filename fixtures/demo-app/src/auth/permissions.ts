import { ForbiddenError } from '../shared/errors';
import type { User } from '../db/models/user';

export type Role = 'customer' | 'admin';

export type Action =
  | 'order:read'
  | 'order:read_own'
  | 'order:refund'
  | 'admin:stats'
  | 'admin:users';

const MATRIX: Record<Role, Action[]> = {
  customer: ['order:read_own'],
  admin: ['order:read', 'order:read_own', 'order:refund', 'admin:stats', 'admin:users'],
};

export function can(user: Pick<User, 'role'>, action: Action): boolean {
  return MATRIX[user.role].includes(action);
}

export function requirePermission(user: Pick<User, 'role'> | null, action: Action): void {
  if (!user) throw new ForbiddenError('not authenticated');
  if (!can(user, action)) throw new ForbiddenError(`role ${user.role} may not ${action}`);
}

// Customers may only touch their own orders; admins may touch any.
export function canAccessOrder(user: Pick<User, 'role' | 'id'>, orderUserId: string): boolean {
  if (user.role === 'admin') return true;
  return user.id === orderUserId;
}
