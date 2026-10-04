import { Router } from 'express';
import { getOrdersForUser, getOrderOrThrow } from '../../orders/order-repo';
import { canAccessOrder } from '../../auth/permissions';
import { ForbiddenError } from '../../shared/errors';
import { asyncHandler, sendJson } from '../http';
import { AuthedRequest, requireAuth } from '../middleware';

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// GET /orders -> the caller's own order history.
ordersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { user } = req as AuthedRequest;
    const orders = await getOrdersForUser(user.id);
    sendJson(res, 200, { orders });
  }),
);

// GET /orders/:id -> a single order, if the caller is allowed to see it.
ordersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { user } = req as AuthedRequest;
    const order = await getOrderOrThrow(req.params.id);
    if (!canAccessOrder(user, order.user_id)) throw new ForbiddenError('not your order');
    sendJson(res, 200, { order });
  }),
);
