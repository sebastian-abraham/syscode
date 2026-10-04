import React, { useState } from 'react';
import { api } from '../api-client';

interface CheckoutProps {
  lines: { productId: string; quantity: number }[];
  onDone: (orderId: string) => void;
}

// Collects the payment method id and calls the checkout endpoint. In a real
// storefront the method id comes from Stripe Elements; for now it is a field.
export function Checkout({ lines, onDone }: CheckoutProps): React.JSX.Element {
  const [paymentMethodId, setPaymentMethodId] = useState('pm_card_visa');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const order = await api.checkout(paymentMethodId, lines);
      onDone(order.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'checkout failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="checkout"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Payment method
        <input value={paymentMethodId} onChange={(e) => setPaymentMethodId(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Placing order…' : `Pay for ${lines.length} item(s)`}
      </button>
    </form>
  );
}
