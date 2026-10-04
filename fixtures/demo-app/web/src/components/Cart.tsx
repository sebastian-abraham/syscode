import React, { useState } from 'react';
import type { Product } from '../api-client';

interface CartProps {
  products: Product[];
  onCheckout: (lines: { productId: string; quantity: number }[]) => void;
}

// Client-side cart. It holds quantities only; prices are always re-resolved on
// the server during checkout.
export function Cart({ products, onCheckout }: CartProps): React.JSX.Element {
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const total = products.reduce((sum, p) => sum + (quantities[p.id] ?? 0) * p.priceCents, 0);

  function setQuantity(id: string, delta: number): void {
    setQuantities((prev) => {
      const next = Math.max(0, (prev[id] ?? 0) + delta);
      return { ...prev, [id]: next };
    });
  }

  const lines = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([productId, quantity]) => ({ productId, quantity }));

  return (
    <section className="cart">
      <h2>Your cart</h2>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            <span>{p.name}</span>
            <button onClick={() => setQuantity(p.id, -1)}>-</button>
            <span>{quantities[p.id] ?? 0}</span>
            <button onClick={() => setQuantity(p.id, 1)}>+</button>
          </li>
        ))}
      </ul>
      <p>Total: ${(total / 100).toFixed(2)}</p>
      <button disabled={lines.length === 0} onClick={() => onCheckout(lines)}>
        Checkout
      </button>
    </section>
  );
}
