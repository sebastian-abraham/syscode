import { one, query } from '../pool';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'customer' | 'admin';
  created_at: Date;
}

export interface User {
  id: string;
  email: string;
  role: 'customer' | 'admin';
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, role: row.role };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
}

export async function findUserById(id: string): Promise<User | null> {
  const row = await one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return row ? toUser(row) : null;
}

export async function insertUser(email: string, passwordHash: string, role = 'customer'): Promise<User> {
  const row = await one<UserRow>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
     RETURNING id, email, password_hash, role, created_at`,
    [email, passwordHash, role],
  );
  if (!row) throw new Error('insertUser returned no row');
  return toUser(row);
}

export async function listUsers(limit = 50): Promise<User[]> {
  const rows = await query<UserRow>('SELECT * FROM users ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map(toUser);
}
