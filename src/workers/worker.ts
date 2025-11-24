/**
 * src/workers/worker.ts
 *
 * Refactored to:
 * - Return { status, txHash, executedPrice, dex, attempts, ok }
 * - Add retry/attempt counting
 * - Keep same dependency-injection structure
 */

import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger as defaultLogger } from '../lib/logger';
import MockDexRouter from '../lib/mockDexRouter';
// import { saveOrderEvent as defaultSave } from '../lib/db/events';
// import { publishOrderEvent as defaultPublish } from '../lib/ws/publisher';
import { saveOrderEvent as defaultSave } from '../lib/db/events';
import { publishOrderEvent as defaultPublish } from '../lib/ws/publisher'; // KEEP this for factory default


//
// ────────────────────────────────────────────────────────────────
//  PURE PROCESSOR — now returns the required execution object
// ────────────────────────────────────────────────────────────────
//

export interface ProcessOrderDeps {
  router: MockDexRouter;
  saveOrderEvent: (orderId: string, status: string, data: any) => Promise<any>;
  publishOrderEvent: (orderId: string, payload: any) => Promise<any>;
  logger: typeof defaultLogger;
}

export async function processOrder(job: Job, deps: ProcessOrderDeps) {
  const { router, saveOrderEvent, publishOrderEvent, logger } = deps;

  const data = job.data || {};
  const { orderId, tokenIn, tokenOut, amountIn } = data;
  const attempt = (job as any).attemptsMade != null ? (job as any).attemptsMade + 1 : 1;

  logger.info({ jobId: job.id, orderId, attempt }, 'Worker: starting order processing');

  if (!orderId) {
    logger.error({ jobId: job.id, data }, 'Worker: job missing orderId');
    throw new Error('job missing orderId');
  }

  try {
    // routing
    await saveOrderEvent(orderId, 'routing', { startedAt: new Date().toISOString(), attempt });
    await publishOrderEvent(orderId, { status: 'routing', attempt });

    // quotes
    const [ray, met] = await Promise.all([
      router.getRaydiumQuote(tokenIn, tokenOut, amountIn),
      router.getMeteoraQuote(tokenIn, tokenOut, amountIn),
    ]);

    const chosen = ray.price <= met.price ? { ...ray, dex: 'raydium' } : { ...met, dex: 'meteora' };

    await saveOrderEvent(orderId, 'building', { chosen, attempt });
    await publishOrderEvent(orderId, { status: 'building', chosen, attempt });

    // execute
    const exec = await router.executeSwap(chosen.dex, {
      orderId, tokenIn, tokenOut, amountIn,
    });

    // submitted
    await saveOrderEvent(orderId, 'submitted', { txHash: exec.txHash, attempt });
    await publishOrderEvent(orderId, { status: 'submitted', txHash: exec.txHash, attempt });

    // confirmed payload (persist & publish using injected deps)
    const confirmedPayload = {
      txHash: exec.txHash,
      executedPrice: exec.executedPrice,
      dex: chosen.dex,
      attempts: attempt,
      ok: true,
    };

    try {
      await saveOrderEvent(orderId, 'confirmed', confirmedPayload);
    } catch (persistErr) {
      logger.error({ orderId, persistErr }, 'Worker: failed to persist confirmed event');
      // continue — still try to publish so tests can observe publish call
    }

    try {
      await publishOrderEvent(orderId, { status: 'confirmed', ...confirmedPayload });
    } catch (pubErr) {
      logger.error({ orderId, pubErr }, 'Worker: failed to publish confirmed event');
    }

    const returnObj = {
      status: 'filled',
      txHash: exec.txHash,
      executedPrice: exec.executedPrice,
      dex: chosen.dex,
      attempts: attempt,
      ok: true,
    };

    logger.info({ jobId: job.id, orderId, attempt }, 'Worker: completed successfully');
    return returnObj;
  } catch (err: any) {
    logger.error({ jobId: job.id, orderId, attempt, err: err?.message }, 'Worker: error');

    try {
      await saveOrderEvent(orderId, 'failed', { error: err?.message, attempt });
    } catch (persistErr) {
      logger.error({ orderId, persistErr }, 'Worker: failed to persist failed event');
    }

    try {
      await publishOrderEvent(orderId, { status: 'failed', error: err?.message, attempt });
    } catch (pubErr) {
      logger.error({ orderId, pubErr }, 'Worker: failed to publish failed event');
    }

    throw err;
  }
}

//
// ────────────────────────────────────────────────────────────────
//  WORKER FACTORY
// ────────────────────────────────────────────────────────────────
//

export interface WorkerFactoryOptions {
  queueName?: string;
  concurrency?: number;
  logger?: typeof defaultLogger;
  saveOrderEvent?: typeof defaultSave;
  publishOrderEvent?: (orderId: string, payload: any) => Promise<any>;
  router?: MockDexRouter;
  redisConnection?: IORedis;
}

export function createOrderWorker(opts: WorkerFactoryOptions = {}) {
  const {
    queueName = process.env.QUEUE_NAME || 'orders',
    concurrency = parseInt(
      process.env.WORKER_CONCURRENCY || '10',
      10
    ),
    logger = defaultLogger,
    saveOrderEvent = defaultSave,
    publishOrderEvent = defaultPublish,
    router = new MockDexRouter(false),
    redisConnection,
  } = opts;

  const redis =
    redisConnection ||
    new IORedis(
      process.env.REDIS_URL ||
        `redis://${process.env.REDIS_PASSWORD ? process.env.REDIS_PASSWORD + '@' : ''}${process.env.REDIS_HOST ||
          '127.0.0.1'}:${process.env.REDIS_PORT || '6379'}`,
      {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      }
    );

  const worker = new Worker(
    queueName,
    (job) =>
      processOrder(job, {
        router,
        logger,
        saveOrderEvent,
        publishOrderEvent,
      }),
    {
      connection: redis,
      concurrency,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(
      { jobId: job.id, orderId: job.data?.orderId, result },
      'Worker: job completed'
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, orderId: job?.data?.orderId, err },
      'Worker: job failed'
    );
  });

  return { worker, redis };
}

//
// ────────────────────────────────────────────────────────────────
//  PRODUCTION ENTRY
// ────────────────────────────────────────────────────────────────
//

if (require.main === module) {
  const { worker, redis } = createOrderWorker();

  async function shutdown(signal: string) {
    defaultLogger.info({ signal }, 'Worker shutting down...');
    try {
      await worker.close();
    } catch {}
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
