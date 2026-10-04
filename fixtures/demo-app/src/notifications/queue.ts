import { createClient } from 'redis';
import { config } from '../shared/config';
import { logger } from '../shared/logger';

// Minimal Redis list queue. Producers LPUSH, the worker BRPOPs. We keep the
// payload as JSON and the event name as a field so a single queue can carry
// several event types.

export type EventName =
  | 'order.created'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'order.shipped';

export interface QueueMessage {
  name: EventName;
  payload: Record<string, unknown>;
  enqueuedAt: string;
}

const QUEUE_KEY = 'shopkit:events';

const client = createClient({ url: config.redisUrl });
client.on('error', (err) => logger.error('redis error', { err: String(err) }));

export async function connectQueue(): Promise<void> {
  if (!client.isOpen) await client.connect();
}

export async function enqueue(name: EventName, payload: Record<string, unknown>): Promise<void> {
  await connectQueue();
  const message: QueueMessage = { name, payload, enqueuedAt: new Date().toISOString() };
  await client.lPush(QUEUE_KEY, JSON.stringify(message));
  logger.debug('event enqueued', { name });
}

// Blocking pop with a timeout so the worker loop can also check for shutdown.
export async function dequeue(timeoutSeconds = 5): Promise<QueueMessage | null> {
  await connectQueue();
  const raw = await client.brPop(QUEUE_KEY, timeoutSeconds);
  return raw ? (JSON.parse(raw.element) as QueueMessage) : null;
}

export async function queueDepth(): Promise<number> {
  await connectQueue();
  return client.lLen(QUEUE_KEY);
}
