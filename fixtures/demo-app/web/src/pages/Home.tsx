import React, { useState } from 'react';
import { Cart } from '../components/Cart';
import { Checkout } from '../components/Checkout';
import type { Product } from '../api-client';

// Hardcoded demo catalogue; a real build would call the catalog endpoint.
const DEMO_PRODUCTS: Product[] = [
  { id: '11111111-1111-1111-1111-111111111111', sku: 'TEE-001', name: 'Logo Tee', priceCents: 2500 },
  { id: '22222222-2222-2222-2222-222222222222', sku: 'MUG-002', name: 'Enamel Mug', priceCents: 1400 },
  { id: '33333333-3333-3333-3333-333333333333', sku: 'CAP-003', name: 'Canvas Cap', priceCents: 1900 },
];

export function Home(): React.JSX.Element {
  const [lines, setLines] = useState<{ productId: string; quantity: number }[] | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  if (confirmation) {
    return <p className="confirmation">Order {confirmation.slice(0, 8)} placed. Thank you!</p>;
  }

  return (
    <main>
      <h1>shopkit</h1>
      <Cart products={DEMO_PRODUCTS} onCheckout={setLines} />
      {lines && <Checkout lines={lines} onDone={setConfirmation} />}
    </main>
  );
}
