import { z } from 'zod';
import { ValidationError } from './errors';

// Small helpers shared by routes and services. We keep the zod schemas next to
// the parse helper so a route never has to import zod directly.

export const emailSchema = z.string().trim().toLowerCase().email();
export const moneySchema = z.number().int().nonnegative(); // amounts in cents

export const cartLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
});

export const cartSchema = z.object({
  lines: z.array(cartLineSchema).min(1).max(50),
});

export type CartLine = z.infer<typeof cartLineSchema>;
export type Cart = z.infer<typeof cartSchema>;

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, what = 'payload'): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ValidationError(`${what}: ${first.path.join('.')} ${first.message}`);
  }
  return result.data;
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`);
  }
}
