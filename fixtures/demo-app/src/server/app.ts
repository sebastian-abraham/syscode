import express from 'express';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { requestLogger } from './middleware';
import { errorHandler } from './http';
import { authRouter } from './routes/auth';
import { ordersRouter } from './routes/orders';
import { checkoutRouter } from './routes/checkout';
import { adminRouter } from './routes/admin';
import { handleStripeWebhook } from '../payments/webhook';

// Build the Express app. Kept separate from the listen() call so tests can
// import the app without binding a port.
export function createApp(): express.Express {
  const app = express();

  app.use(requestLogger);
  // Stripe webhooks need the raw body for signature verification, so that route
  // gets express.raw before the JSON parser is mounted.
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res, next) => {
    handleStripeWebhook(req.body as Buffer, req.headers['stripe-signature'] as string)
      .then(() => res.status(200).json({ received: true }))
      .catch(next);
  });

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, env: config.env }));

  app.use('/auth', authRouter);
  app.use('/orders', ordersRouter);
  app.use('/checkout', checkoutRouter);
  app.use('/admin', adminRouter);

  app.use(errorHandler);
  return app;
}

if (require.main === module) {
  createApp().listen(config.port, () => {
    logger.info('shopkit api listening', { port: config.port });
  });
}
