import { Router } from 'express';
import { z } from 'zod';
import { createOrder } from '../../orders/create-order';
import { parse } from '../../shared/validation';
import { asyncHandler, sendJson } from '../http';
import { AuthedRequest, requireAuth } from '../middleware';

const checkoutSchema = z.object({
  paymentMethodId: z.string().min(3),
  lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
});

export const checkoutRouter = Router();

checkoutRouter.use(requireAuth);

// POST /checkout -> runs the whole flow and returns the created order.
checkoutRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { user } = req as AuthedRequest;
    const body = parse(checkoutSchema, req.body, 'checkout');
    const order = await createOrder({ user, paymentMethodId: body.paymentMethodId, body });
    sendJson(res, 201, { order });
  }),
);
