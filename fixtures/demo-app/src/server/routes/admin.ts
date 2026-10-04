import { Router } from 'express';
import { listRecentOrders } from '../../db/models/order';
import { listUsers } from '../../db/models/user';
import { refundOrder } from '../../payments/refund';
import { requirePermission } from '../../auth/permissions';
import { salesSummary, topProducts } from '../../analytics/sales-summary';
import { asyncHandler, sendJson } from '../http';
import { AuthedRequest, requireAuth } from '../middleware';

export const adminRouter = Router();

adminRouter.use(requireAuth);

// GET /admin/stats -> recent sales totals plus best sellers.
adminRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const { user } = req as AuthedRequest;
    requirePermission(user, 'admin:stats');
    const [summary, best] = await Promise.all([salesSummary(), topProducts(5)]);
    sendJson(res, 200, { summary, topProducts: best });
  }),
);

// GET /admin/orders -> the newest orders across all customers.
adminRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const { user } = req as AuthedRequest;
    requirePermission(user, 'order:read');
    sendJson(res, 200, { orders: await listRecentOrders(50) });
  }),
);

// GET /admin/users -> support view of the user table.
adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { user } = req as AuthedRequest;
    requirePermission(user, 'admin:users');
    sendJson(res, 200, { users: await listUsers() });
  }),
);

// POST /admin/orders/:id/refund -> issue a Stripe refund.
adminRouter.post(
  '/orders/:id/refund',
  asyncHandler(async (req, res) => {
    const { user } = req as AuthedRequest;
    requirePermission(user, 'order:refund');
    const result = await refundOrder(req.params.id);
    sendJson(res, 200, result);
  }),
);
