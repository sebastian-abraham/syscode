// Payment domain types. Kept free of any Stripe import so the rest of the
// app depends on our shape, not the vendor's.

export interface ChargeRequest {
  userId: string;
  amountCents: number;
  paymentMethodId: string;
  idempotencyKey?: string;
}

export interface ChargeResult {
  chargeId: string;
  status: 'succeeded' | 'pending' | 'failed';
  amountCents: number;
}

export interface RefundResult {
  refundId: string;
  amountCents: number;
  status: 'refunded' | 'failed';
}

export interface PaymentProvider {
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  refund(chargeId: string, amountCents: number): Promise<RefundResult>;
}

export class PaymentError extends Error {
  readonly declineCode: string | null;

  constructor(message: string, declineCode: string | null = null) {
    super(message);
    this.name = 'PaymentError';
    this.declineCode = declineCode;
  }
}
