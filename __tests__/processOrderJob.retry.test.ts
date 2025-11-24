/**
 * __tests__/worker.retry.test.ts
 *
 * Tests around retry-like behavior for processOrder in src/workers/worker.ts
 *
 * Notes:
 * - processOrder(job, deps) is pure and expects the router to be injected via deps.
 * - The current processOrder implementation does not perform internal retries;
 *   retry semantics are normally handled by Bull (job attempts). To unit-test
 *   retry behaviour you can either:
 *     1) exercise processOrder multiple times (simulate repeated attempts), or
 *     2) test the worker/queue layer that actually drives retries.
 *
 * This test file demonstrates both approaches in a minimal, deterministic way.
 */

import { processOrder } from '../src/workers/worker';
import type { Job } from 'bullmq';

describe('processOrder basic / retry-simulation', () => {
  const makeJob = (data: any, attemptsMade = 0): Job => {
    return {
      id: 'job-1',
      data,
      attemptsMade,
    } as unknown as Job;
  };

  const makeDeps = (routerOverrides?: Partial<Record<string, any>>) => {
    const saveOrderEvent = jest.fn().mockResolvedValue(undefined);
    const publishOrderEvent = jest.fn().mockResolvedValue(undefined);
    const logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    // lightweight stub router (no sleeps, fully controlled in tests)
    const router = {
      getRaydiumQuote: jest.fn().mockResolvedValue({ price: 100, fee: 0.003, dex: 'raydium' }),
      getMeteoraQuote: jest.fn().mockResolvedValue({ price: 105, fee: 0.002, dex: 'meteora' }),
      executeSwap: jest.fn(),
      ...routerOverrides,
    } as any;

    return { saveOrderEvent, publishOrderEvent, logger, router };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('successful execution (single attempt)', async () => {
    const { saveOrderEvent, publishOrderEvent, logger, router } = makeDeps({
      executeSwap: jest.fn().mockResolvedValue({
        txHash: 'tx123',
        executedPrice: 123,
        dex: 'raydium',
      }),
    });

    const job = makeJob({
      orderId: 'order-1',
      tokenIn: 'TKNA',
      tokenOut: 'TKNB',
      amountIn: 100,
    }, /* attemptsMade */ 0);

    const res = await processOrder(job, {
      router,
      saveOrderEvent,
      publishOrderEvent,
      logger,
    });

    // processOrder currently uses job.attemptsMade + 1 as attempts
    expect(res.attempts).toBe(1);
    expect(res.status).toBe('filled');
    expect(res.txHash).toBe('tx123');
    expect(res.executedPrice).toBe(123);
    expect(res.dex).toBe('raydium');

    // router.executeSwap called once
    expect(router.executeSwap).toHaveBeenCalledTimes(1);

    // lifecycle persisted & published (at least routing/submitted/confirmed)
    expect(saveOrderEvent).toHaveBeenCalledWith('order-1', 'routing', expect.any(Object));
    expect(publishOrderEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ status: 'routing' }));
    expect(saveOrderEvent).toHaveBeenCalledWith('order-1', 'submitted', expect.any(Object));
    expect(publishOrderEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ status: 'submitted' }));
    expect(saveOrderEvent).toHaveBeenCalledWith('order-1', 'confirmed', expect.any(Object));
    expect(publishOrderEvent).toHaveBeenCalledWith('order-1', expect.objectContaining({ status: 'confirmed' }));
  });

  test('simulate worker retries: first two attempts fail, third succeeds', async () => {
    // Create a router instance where executeSwap fails twice then succeeds.
    const executeSwapMock = jest.fn()
      .mockRejectedValueOnce(new Error('err-1'))
      .mockRejectedValueOnce(new Error('err-2'))
      .mockResolvedValueOnce({ txHash: 'tx-retry', executedPrice: 200, dex: 'raydium' });

    const { saveOrderEvent, publishOrderEvent, logger, router } = makeDeps({
      executeSwap: executeSwapMock,
    });

    // Simulate Bull's retry behaviour by calling processOrder three times,
    // increasing attemptsMade each time. In production, Bull would re-enqueue
    // with attemptsMade incremented. This keeps the unit test focused and deterministic.
    const baseData = {
      orderId: 'order-retry-1',
      tokenIn: 'TKNA',
      tokenOut: 'TKNB',
      amountIn: 50,
    };

    // Attempt 1 (will reject)
    const job1 = makeJob(baseData, /* attemptsMade */ 0);
    await expect(
      processOrder(job1, { router, saveOrderEvent, publishOrderEvent, logger })
    ).rejects.toThrow('err-1');

    // Attempt 2 (will reject)
    const job2 = makeJob(baseData, /* attemptsMade */ 1);
    await expect(
      processOrder(job2, { router, saveOrderEvent, publishOrderEvent, logger })
    ).rejects.toThrow('err-2');

    // Attempt 3 (will resolve)
    const job3 = makeJob(baseData, /* attemptsMade */ 2);
    const res = await processOrder(job3, { router, saveOrderEvent, publishOrderEvent, logger });

    // executeSwap should have been called 3 times across the three attempts
    expect(executeSwapMock).toHaveBeenCalledTimes(3);

    // final attempt returns filled result
    expect(res.status).toBe('filled');
    expect(res.txHash).toBe('tx-retry');
    expect(res.executedPrice).toBe(200);
    expect(res.dex).toBe('raydium');
    expect(res.attempts).toBe(3);
  });

  test('permanent failure after repeated attempts (simulate three failures)', async () => {
    const executeSwapMock = jest.fn()
      .mockRejectedValue(new Error('always failing')); // always reject

    const { saveOrderEvent, publishOrderEvent, logger, router } = makeDeps({
      executeSwap: executeSwapMock,
    });

    const baseData = {
      orderId: 'order-fail-1',
      tokenIn: 'TKNA',
      tokenOut: 'TKNB',
      amountIn: 5,
    };

    // Simulate three attempts that all fail
    const job1 = makeJob(baseData, 0);
    await expect(
      processOrder(job1, { router, saveOrderEvent, publishOrderEvent, logger })
    ).rejects.toThrow('always failing');

    const job2 = makeJob(baseData, 1);
    await expect(
      processOrder(job2, { router, saveOrderEvent, publishOrderEvent, logger })
    ).rejects.toThrow('always failing');

    const job3 = makeJob(baseData, 2);
    await expect(
      processOrder(job3, { router, saveOrderEvent, publishOrderEvent, logger })
    ).rejects.toThrow('always failing');

    // executeSwap called three times
    expect(executeSwapMock).toHaveBeenCalledTimes(3);

    // Each failing attempt should have attempted to persist a failed event
    expect(saveOrderEvent).toHaveBeenCalledWith('order-fail-1', 'failed', expect.objectContaining({ error: expect.any(String) }));
    expect(publishOrderEvent).toHaveBeenCalledWith('order-fail-1', expect.objectContaining({ status: 'failed', error: expect.any(String) }));
  });
});
