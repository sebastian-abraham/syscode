import { findUserById } from '../db/models/user';
import { logger } from '../shared/logger';
import { dequeue, connectQueue } from './queue';
import { render } from './templates';
import { sendEmail } from './send-email';

// Long-running background process: npm run worker. It drains the Redis queue
// and turns each order event into an email to the customer.

let running = true;

export async function stopWorker(): Promise<void> {
  running = false;
}

export async function processOnce(): Promise<boolean> {
  const message = await dequeue();
  if (!message) return false;

  const email = render(message);
  if (!email) {
    logger.warn('no template for event', { name: message.name });
    return true;
  }

  const userId = message.payload.userId as string | undefined;
  const user = userId ? await findUserById(userId) : null;
  if (!user) {
    logger.warn('dropping event with unknown user', { name: message.name });
    return true;
  }

  await sendEmail(user.email, email);
  return true;
}

async function main(): Promise<void> {
  await connectQueue();
  logger.info('notification worker started');
  while (running) {
    try {
      await processOnce();
    } catch (err) {
      logger.error('worker iteration failed', { err: String(err) });
    }
  }
  logger.info('notification worker stopped');
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('worker crashed', { err: String(err) });
    process.exit(1);
  });
}
