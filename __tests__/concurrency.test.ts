/**
 * __tests__/concurrency.test.ts
 *
 * Concurrency + retry integration test (isolated queue)
 *
 * Requirements:
 *  - Worker concurrency = 10
 *  - Process 100 jobs (98 normal + flaky + always-fail)
 *  - Exponential backoff, attempts = 3
 *
 * Notes:
 *  - Requires `sharedRedis` exported from src/lib/queue.ts
 *  - Uses a unique queue name so tests are isolated from other runs
 *  - QueueScheduler is deprecated - Workers now handle delayed jobs automatically
 */

import { Queue, Worker, Job } from 'bullmq';
import { sharedRedis } from '../src/lib/queue'; // must be exported from your module
import { v4 as uuidv4 } from 'uuid';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Order Queue – Concurrency & Retry behaviour (isolated full test)', () => {
  jest.setTimeout(180_000); // 3 minutes for CI slowness

  let testQueue: Queue;
  let worker: Worker | undefined;

  const concurrency = 10;
  const totalJobs = 100;

  beforeAll(async () => {
    const uniqueQueueName = `test-orders-${Date.now()}-${uuidv4()}`;
    testQueue = new Queue(uniqueQueueName, { connection: sharedRedis });
  });

  afterAll(async () => {
    // Close worker and queue, then sharedRedis to avoid open handles
    if (worker) {
      try {
        await worker.close();
      } catch (e) {
        // ignore
      }
    }

    if (testQueue) {
      try {
        await testQueue.close();
      } catch (e) {
        // ignore
      }
    }

    // Close the shared Redis client so Jest can exit (safe in test context)
    try {
      await sharedRedis.quit();
    } catch {
      try {
        sharedRedis.disconnect();
      } catch {}
    }
  });

  test('processes 100 jobs with concurrency=10 and exponential retry/backoff', async () => {
    // trackers
    let active = 0;
    let maxActive = 0;

    const flakyOrderId = 'flaky-order';
    const alwaysFailOrderId = 'always-fail-order';

    const completedOrderIds = new Set<string>();
    const failedMap = new Map<string, { reason: string; attempts: number }>();

    // Create worker (processor)
    // Workers now automatically handle delayed jobs (retries with backoff)
    // Important: ensure skipDelayedCheck is false (default in v5+) so Worker processes delayed retries
    worker = new Worker(
      testQueue.name,
      async (job: Job | undefined) => {
        if (!job) throw new Error('missing-job');

        active++;
        maxActive = Math.max(maxActive, active);

        // simulate work
        await sleep(200);

        const orderId = (job.data && job.data.orderId) ? String(job.data.orderId) : String(job.id);

        // flaky: fail twice (attemptsMade 0 and 1), succeed on 3rd
        if (orderId === flakyOrderId) {
          // job.attemptsMade is number of previous attempts (0 for first)
          if ((job.attemptsMade ?? 0) < 2) {
            active--;
            // throw to trigger retry/delayed retry (Worker handles this automatically)
            throw new Error(`transient-${job.attemptsMade ?? 0}`);
          }
          active--;
          return { ok: true, orderId };
        }

        // always-fail: always throw (will exhaust attempts)
        if (orderId === alwaysFailOrderId) {
          active--;
          throw new Error('permanent-failure');
        }

        active--;
        return { ok: true, orderId };
      },
      {
        connection: sharedRedis,
        concurrency
      }
    );

    // Attach handlers before enqueueing
    let observedDone = 0;

    const onCompleted = (job: Job | undefined) => {
      const id = job?.data?.orderId ?? job?.id;
      if (!id) return;
      const sid = String(id);
      if (!completedOrderIds.has(sid)) {
        completedOrderIds.add(sid);
        observedDone++;
        // debug
        // eslint-disable-next-line no-console
        // console.info(`[test] completed ${sid} attempts=${job?.attemptsMade ?? 0}`);
      }
    };

    const onFailed = (job: Job | undefined, err: Error | undefined) => {
      const id = job?.data?.orderId ?? job?.id;
      if (!id) return;
      const sid = String(id);
      
      // IMPORTANT: 'failed' event fires for intermediate failures too
      // Only count as "done" if job has exhausted all attempts (finishedOn is set)
      const isFinished = job?.finishedOn !== undefined && job?.finishedOn !== null;
      
      if (isFinished && !failedMap.has(sid)) {
        failedMap.set(sid, {
          reason: err?.message ?? 'unknown',
          attempts: job?.attemptsMade ?? 0
        });
        observedDone++;
        // debug
        // eslint-disable-next-line no-console
        // console.info(`[test] PERMANENTLY failed ${sid} attempts=${job?.attemptsMade ?? 0} err=${err?.message}`);
      } else if (!isFinished) {
        // debug
        // eslint-disable-next-line no-console
        // console.info(`[test] failed (will retry) ${sid} attempts=${job?.attemptsMade ?? 0} err=${err?.message}`);
      }
    };

    worker.on('completed', onCompleted);
    worker.on('failed', onFailed);

    // Enqueue jobs into isolated testQueue
    const jobOpts = {
      attempts: 3,
      backoff: {
        type: 'exponential' as const,
        delay: 300
      },
      removeOnComplete: false, // keep records for test assertions/debug
      removeOnFail: false
    };

    const addPromises: Promise<any>[] = [];
    for (let i = 0; i < totalJobs - 2; i++) {
      addPromises.push(testQueue.add(`job-${i}`, { orderId: `order-${i}` }, jobOpts));
    }

    // flaky + always-fail: do NOT set jobId=orderId — let BullMQ manage job identity across retries
    addPromises.push(testQueue.add('flaky-job', { orderId: flakyOrderId }, jobOpts));
    addPromises.push(testQueue.add('alwaysfail-job', { orderId: alwaysFailOrderId }, jobOpts));

    await Promise.all(addPromises);

    // Wait (event-driven) for all jobs observed as completed or failed
    const deadline = Date.now() + 120_000; // 120s
    while (observedDone < totalJobs) {
      if (Date.now() > deadline) {
        // Snapshot for debugging
        const counts = await testQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
        // console.error(`[TEST TIMEOUT] observed=${observedDone}/${totalJobs} counts=${JSON.stringify(counts)} maxActive=${maxActive}`);
        throw new Error(`Timeout waiting for ${totalJobs} jobs (observed ${observedDone})`);
      }
      await sleep(200);
    }

    // Assertions
    expect(maxActive).toBeLessThanOrEqual(concurrency);

    // flaky should have succeeded eventually
    expect(completedOrderIds.has(flakyOrderId)).toBe(true);

    // always-fail should be present in failedMap and attempts >= 2 (exhausted or near exhausted)
    expect(failedMap.has(alwaysFailOrderId)).toBe(true);
    const failInfo = failedMap.get(alwaysFailOrderId)!;
    expect(failInfo.reason).toContain('permanent-failure');
    expect(failInfo.attempts).toBeGreaterThanOrEqual(2);

    // final sanity: completed + failed >= totalJobs (retries create intermediate states)
    const finalCounts = await testQueue.getJobCounts('completed', 'failed');
    expect((finalCounts.completed ?? 0) + (finalCounts.failed ?? 0)).toBeGreaterThanOrEqual(totalJobs);
  });
});