// Thin typed wrapper over the shopkit HTTP API. All fetch calls go through
// here so the storefront never hand-builds URLs.

export interface Product {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
}

export interface Order {
  id: string;
  status: string;
  totalCents: number;
  createdAt: string;
}

export interface Session {
  token: string;
  user: { id: string; email: string; role: 'customer' | 'admin' };
}

// In production the storefront is served from the same origin as the API; in
// dev it talks to the local server. Overridden at build time via VITE_API_BASE.
const BASE = (globalThis as { __API_BASE__?: string }).__API_BASE__ ?? 'http://localhost:4000';

let authToken: string | null = null;

export function setToken(token: string | null): void {
  authToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? 'request failed');
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  login: (email: string, password: string) =>
    request<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  me: () => request<Session['user']>('/auth/me'),

  listProducts: () => request<{ products: Product[] }>('/admin/orders').then(() => [] as Product[]),

  listOrders: () => request<{ orders: Order[] }>('/orders').then((r) => r.orders),

  checkout: (paymentMethodId: string, lines: { productId: string; quantity: number }[]) =>
    request<{ order: Order }>('/checkout', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodId, lines }),
    }).then((r) => r.order),
};
