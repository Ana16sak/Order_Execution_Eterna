/**
 * src/workers/worker.ts
 *
 * BullMQ worker process for processing "processOrder" jobs.
 * Ensures ioredis used by BullMQ has `maxRetriesPerRequest: null`.
 */

import { Worker, QueueEvents, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../lib/logger';
import MockDexRouter from '../lib/mockDexRouter';
import { saveOrderEvent } from '../lib/db/events'; // adjust to your path
import { publishOrderEvent } from '../lib/ws/publisher'; // adjust to your path

const {
  REDIS_URL,
  REDIS_HOST = '127.0.0.1',
  REDIS_PORT = '6379',
  REDIS_PASSWORD,
  QUEUE_NAME = 'orders',
  QUEUE_PREFIX = 'bull',
  WORKER_CONCURRENCY = '10',
} = process.env;

// Build redis connection string
const redisConnectionString =
  REDIS_URL ||
  `redis://${REDIS_PASSWORD ? REDIS_PASSWORD + '@' : ''}${REDIS_HOST}:${REDIS_PORT}`;

/**
 * Every ioredis instance passed to BullMQ must have:
 *   - maxRetriesPerRequest: null
 *   - enableReadyCheck: false
 */
const redis = new IORedis(redisConnectionString, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Optional: QueueEvents for logging job lifecycle
const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redis,
  prefix: QUEUE_PREFIX,
});

/**
 * Inline job processor
 * Replace this with your real Mock DEX routing later.
 */
export async function processOrder(job: Job) {
  const data = job.data as any || {};
  const { orderId, tokenIn, tokenOut, amountIn } = data;

  logger.info({ jobId: job.id, orderId }, 'Worker: starting order processing');

  if (!orderId) {
    logger.error({ jobId: job.id, data }, 'Worker: job missing orderId - aborting');
    throw new Error('job missing orderId');
  }

  const router = new MockDexRouter();

  try {
    // 1) ROUTING
    await saveOrderEvent(orderId, 'routing', { startedAt: new Date().toISOString() });
    await publishOrderEvent(orderId, { status: 'routing' });
    logger.info({ orderId }, 'Worker: routing - fetching quotes');

    const [ray, met] = await Promise.all([
      router.getRaydiumQuote(tokenIn, tokenOut, amountIn),
      router.getMeteoraQuote(tokenIn, tokenOut, amountIn),
    ]);
    logger.info({ orderId, ray, met }, 'Worker: quotes received');

    const chosen = ray.price <= met.price ? { ...ray } : { ...met };
    chosen.dex = chosen.dex || (ray.price <= met.price ? 'raydium' : 'meteora');

    // 2) BUILDING
    await saveOrderEvent(orderId, 'building', { chosen });
    await publishOrderEvent(orderId, { status: 'building', chosen });
    logger.info({ orderId, chosen }, 'Worker: building tx');

    // 3) EXECUTE (simulated)
    const execRes = await router.executeSwap(chosen.dex, { orderId, tokenIn, tokenOut, amountIn });

    // 4) SUBMITTED
    await saveOrderEvent(orderId, 'submitted', { txHash: execRes.txHash });
    await publishOrderEvent(orderId, { status: 'submitted', txHash: execRes.txHash });
    logger.info({ orderId, txHash: execRes.txHash }, 'Worker: tx submitted');

    // 5) CONFIRMED
    await saveOrderEvent(orderId, 'confirmed', execRes);
    await publishOrderEvent(orderId, { status: 'confirmed', ...execRes });
    logger.info({ orderId, execRes }, 'Worker: confirmed');

    logger.info({ jobId: job.id, orderId }, 'Worker: finished order processing');
    return { ok: true, txHash: execRes.txHash };
  } catch (err: any) {
    logger.error({ jobId: job.id, orderId, err: err?.message || String(err) }, 'Worker: error');
    try {
      await saveOrderEvent(orderId, 'failed', { error: err?.message || String(err) });
      await publishOrderEvent(orderId, { status: 'failed', error: err?.message || String(err) });
    } catch (innerErr) {
      logger.error({ orderId, innerErr }, 'Worker: failed to persist failure event');
    }
    throw err;
  }
}

// Worker instance — uses the properly configured redis client
const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    try {
      return await processOrder(job);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'Worker: job error');
      throw err;
    }
  },
  {
    connection: redis,
    concurrency: parseInt(WORKER_CONCURRENCY, 10) || 10,
  }
);

// Worker event logs
worker.on('completed', (job) => {
  logger.info({ jobId: job.id, orderId: job.data?.orderId }, 'Worker: job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, orderId: job?.data?.orderId, err }, 'Worker: job failed');
});

worker.on('error', (err) => {
  logger.error({ err }, 'Worker: internal error');
});

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Worker shutting down — closing worker and redis');

  try {
    await worker.close();
  } catch (err) {
    logger.warn({ err }, 'Error closing worker');
  }

  try {
    await queueEvents.close();
  } catch (err) {
    logger.warn({ err }, 'Error closing queueEvents');
  }

  try {
    await redis.quit();
  } catch (err) {
    logger.warn({ err }, 'Error quitting redis, forcing disconnect');
    redis.disconnect();
  }

  logger.info('Worker shutdown complete');
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('beforeExit', () => shutdown('beforeExit'));
