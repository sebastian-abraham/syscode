import { decrementStock, restock } from '../db/models/product';
import { ConflictError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { PricedLine } from './validate-cart';

// Reserve stock for a checkout. Reservation is optimistic: we decrement up
// front and hand back a release function the caller can use if a later step
// (the charge) fails.
export async function reserveStock(lines: PricedLine[]): Promise<() => Promise<void>> {
  const reserved: PricedLine[] = [];

  for (const line of lines) {
    const ok = await decrementStock(line.productId, line.quantity);
    if (!ok) {
      await release(reserved);
      throw new ConflictError(`out of stock: ${line.name}`);
    }
    reserved.push(line);
  }

  logger.info('stock reserved', { lines: reserved.length });

  return async () => {
    await release(reserved);
    logger.warn('stock reservation released', { lines: reserved.length });
  };
}

async function release(lines: PricedLine[]): Promise<void> {
  for (const line of lines) {
    await restock(line.productId, line.quantity);
  }
}
