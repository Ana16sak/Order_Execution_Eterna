// src/workers/processOrder.ts
import { Job } from 'bullmq';
import MockDexRouter from '../lib/mockDexRouter';
import { saveOrderEvent } from '../lib/db/events';
import { publishOrderEvent } from '../lib/ws/publisher';
import {logger} from '../lib/logger';
import processOrderLogic, { ProcessOrderDeps } from './processOrderLogic';

/**
 * Backwards compatible processOrder(job) that constructs actual deps
 * and calls the pure logic. This keeps worker.ts simple.
 */
export async function processOrder(job: Job) {
  const data = (job.data as any) || {};
  const { orderId, tokenIn, tokenOut, amountIn } = data;

  const router = new MockDexRouter({fast: false}); // realistic delays in production

  const deps: ProcessOrderDeps = {
    router,
    events: { saveOrderEvent, publishOrderEvent },
    logger,
  };

  try {
    return await processOrderLogic({ orderId, tokenIn, tokenOut, amountIn }, deps);
  } catch (err) {
    // preserve existing behavior: persist failed event and rethrow
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ jobId: job.id, orderId, err: errMessage }, 'Worker wrapper: error');
    try {
      await saveOrderEvent(orderId, 'failed', { error: errMessage });
      await publishOrderEvent(orderId, { status: 'failed', error: errMessage });
    } catch (inner) {
      logger.error({ orderId, inner }, 'Worker wrapper: failed to persist failure event');
    }
    throw err;
  }
}

export default processOrder;
