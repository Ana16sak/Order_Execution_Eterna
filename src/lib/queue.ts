/**
 * src/lib/queue.ts
 *
 * BullMQ queue + helper for enqueuing jobs (NO QueueScheduler — deprecated in BullMQ ≥2).
 *
 * Exports:
 *  - orderQueue: Queue instance for producing jobs
 *  - addOrderJob: helper to add an order-processing job with sane defaults
 *  - closeQueue: graceful shutdown helper
 *
 * Env:
 *  - REDIS_URL or REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 *  - QUEUE_NAME (default: 'orders')
 *  - QUEUE_PREFIX (default: 'bull')
 *  - JOB_RETRY_LIMIT (default: 3)
 *  - JOB_BACKOFF_MS (default: 500)
 */

import { Queue, QueueOptions, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from './logger';

const {
  REDIS_URL,
  REDIS_HOST = '127.0.0.1',
  REDIS_PORT = '6379',
  REDIS_PASSWORD,
  QUEUE_NAME = 'orders',
  QUEUE_PREFIX = 'bull',
  JOB_RETRY_LIMIT = '3',
  JOB_BACKOFF_MS = '500'
} = process.env;

// Build redis URL
const redisConnectionString =
  REDIS_URL ||
  `redis://${REDIS_PASSWORD ? REDIS_PASSWORD + '@' : ''}${REDIS_HOST}:${REDIS_PORT}`;

/**
 * Important:
 * BullMQ requires: maxRetriesPerRequest: null
 * Without this, BullMQ throws:
 * "Error: BullMQ: Your redis options maxRetriesPerRequest must be null."
 *
 * enableReadyCheck:false is recommended for Docker and avoids startup hangs.
 */
export const sharedRedis = new IORedis(redisConnectionString, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
 });

// BullMQ queue options
const queueOpts: QueueOptions = {
  connection: sharedRedis,
  prefix: QUEUE_PREFIX
};

// Create queue (no QueueScheduler required in BullMQ ≥2)
export const orderQueue = new Queue(QUEUE_NAME, queueOpts);

/**
 * Default job options.
 * Modern BullMQ handles retries, stalls, backoff internally in Worker.
 */
const defaultJobOptions: JobsOptions = {
  attempts: parseInt(JOB_RETRY_LIMIT, 10) || 3,
  backoff: {
    type: 'exponential',
    delay: parseInt(JOB_BACKOFF_MS, 10) || 500
  },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: false
};

/**
 * addOrderJob
 * - Convenience helper to enqueue "processOrder" jobs
 */
export async function addOrderJob(payload: any, opts?: Partial<JobsOptions>) {
  if (!payload || !payload.orderId) {
    throw new Error('orderId must be provided in job payload');
  }

  const jobOptions: JobsOptions = { ...defaultJobOptions, ...(opts || {}) };

  logger.info({ orderId: payload.orderId }, 'Enqueuing order job');

  const job = await orderQueue.add('processOrder', payload, jobOptions);

  logger.info({ jobId: job.id, orderId: payload.orderId }, 'Enqueued job');
  return job;
}

/**
 * closeQueue
 * - Gracefully closes queue and Redis connections
 */
export async function closeQueue() {
  try {
    logger.info('Closing BullMQ queue');

    await orderQueue.close();

    try {
      await sharedRedis.quit();
    } catch (e) {
      logger.warn({ err: e }, 'Error during Redis quit, forcing disconnect');
      sharedRedis.disconnect();
    }

    logger.info('BullMQ queue closed');
  } catch (err) {
    logger.error({ err }, 'Error closing BullMQ resources');
  }
}

// graceful shutdown handlers
let shuttingDown = false;

async function shutdownHandler(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutting down queue resources');

  try {
    await closeQueue();
  } catch (err) {
    logger.error({ err }, 'Error during queue shutdown');
  }
}

process.on('SIGINT', () => shutdownHandler('SIGINT'));
process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
process.on('beforeExit', () => shutdownHandler('beforeExit'));
