import type { QueueMessage } from './queue';

// Every event maps to a subject/body pair. Templates are plain strings here;
// a real store would load them from a template directory, but this keeps the
// worker dependency-free.

export interface Email {
  subject: string;
  body: string;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function render(message: QueueMessage): Email | null {
  switch (message.name) {
    case 'order.created':
      return {
        subject: 'Your shopkit order is confirmed',
        body: `Thanks for your order. Total: ${money(Number(message.payload.totalCents))}.`,
      };
    case 'payment.succeeded':
      return {
        subject: 'Payment received',
        body: `We've received your payment for order ${message.payload.orderId}.`,
      };
    case 'payment.failed':
      return {
        subject: 'Payment problem',
        body: `We could not process payment for order ${message.payload.orderId}. Please retry checkout.`,
      };
    case 'order.shipped':
      return {
        subject: 'Your order has shipped',
        body: `Order ${message.payload.orderId} is on its way.`,
      };
    default:
      return null;
  }
}
