import { findProductsByIds } from '../db/models/product';
import { NotFoundError, ValidationError } from '../shared/errors';
import type { Cart } from '../shared/validation';

export interface PricedLine {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  name: string;
}

export interface PricedCart {
  lines: PricedLine[];
  totalCents: number;
}

// Turn a client cart into priced lines. We re-read every price from the
// database so a tampered client cannot set its own unit price.
export async function validateCart(cart: Cart): Promise<PricedCart> {
  const ids = [...new Set(cart.lines.map((l) => l.productId))];
  const products = await findProductsByIds(ids);
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines: PricedLine[] = [];
  for (const line of cart.lines) {
    const product = byId.get(line.productId);
    if (!product) throw new NotFoundError(`product ${line.productId}`);
    if (product.stock < line.quantity) {
      throw new ValidationError(`only ${product.stock} left of ${product.sku}`);
    }
    lines.push({
      productId: product.id,
      quantity: line.quantity,
      unitPriceCents: product.price_cents,
      name: product.name,
    });
  }

  const totalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  if (totalCents <= 0) throw new ValidationError('cart total must be positive');
  return { lines, totalCents };
}
