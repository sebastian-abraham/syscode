import React, { useEffect, useState } from 'react';
import { api } from '../api-client';
import type { Order } from '../api-client';

// Order history for the logged-in customer. Fetches once on mount and shows
// the status badge the API returns.
export function Orders(): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listOrders()
      .then(setOrders)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (orders.length === 0) return <p>No orders yet.</p>;

  return (
    <table className="orders">
      <thead>
        <tr>
          <th>Order</th>
          <th>Status</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td>{o.id.slice(0, 8)}</td>
            <td>{o.status}</td>
            <td>${(o.totalCents / 100).toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
