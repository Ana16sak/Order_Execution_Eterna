// __tests__/integration/redis.integration.test.ts
import Redis from 'ioredis';
import fetch from 'node-fetch';
import { Queue, QueueEvents } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const STREAM_KEY = 'bull:orders:events';
const API_BASE = process.env.TEST_API_BASE ?? 'http://127.0.0.1:3000';
const POLL_INTERVAL = 200;
const TIMEOUT = 10000;

// -----------------------------
// Typed helpers
// -----------------------------

type StreamEntry = {
  id: string;
  obj: Record<string, string>;
};

async function waitForCompleted(redis: Redis, jobId: string): Promise<void> {
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    const entries = await redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', 50);

    for (const raw of entries) {
      const parsed = parseEntry(raw as [string, string[]]);
      const obj = parsed.obj;

      if (obj['jobId'] === jobId && obj['event'] === 'completed') {
        return; // success!
      }
    }

    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
  }

  throw new Error(`Timed out waiting for jobId=${jobId} completed event`);
}

function parseEntry(entry: [string, string[]]): StreamEntry {
  const [id, arr] = entry;

  const obj: Record<string, string> = {};
  for (let i = 0; i < arr.length; i += 2) {
    const key = arr[i];
    const value = arr[i + 1];
    obj[key] = value;
  }

  return { id, obj };
}

async function waitForJobEvent(
  redis: Redis,
  queue: Queue,
  orderId: string
): Promise<{ jobId: string; event: string }> {
  const deadline = Date.now() + TIMEOUT;

  while (Date.now() < deadline) {
    const entries = await redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', 50);

    for (const raw of entries) {
      const parsed = parseEntry(raw as [string, string[]]);
      const obj = parsed.obj;

      // safe check — obj.jobId may not exist
      const jobId = obj['jobId'];
      if (!jobId) continue;

      const job = await queue.getJob(jobId);
      if (!job) continue;

      if (job.data && job.data.orderId === orderId) {
        return { jobId, event: obj['event'] ?? '' };
      }
    }

    await new Promise((res) => setTimeout(res, POLL_INTERVAL));
  }

  throw new Error(`Timed out: No Redis/Bull entry for orderId=${orderId}`);
}

// -----------------------------
// TEST
// -----------------------------

describe('Redis/Bull integration', () => {
  let redis: Redis;
  let queue: Queue;
  let queueEvents: QueueEvents;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    queue = new Queue('orders', {
      connection: { host: '127.0.0.1', port: 6379 }
    });

    // QueueEvents is required to publish job lifecycle events to Redis streams
    // This replaces the QueueScheduler's event publishing functionality
    queueEvents = new QueueEvents('orders', {
      connection: { host: '127.0.0.1', port: 6379 }
    });

    // Wait for QueueEvents to be ready
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    // Close QueueEvents first
    if (queueEvents) {
      await queueEvents.close();
    }
    await redis.quit();
    await queue.close();
  });

  test('Bull events appear for newly created order', async () => {
    const orderPayload = {
      userId: 'user-1',
      type: 'market',
      tokenIn: 'SOL',
      tokenOut: 'USDC',
      amountIn: '1000000'
    };

    const res = await fetch(`${API_BASE}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(orderPayload)
    });

    // ALWAYS read the text body (safe even if JSON) so we can log it.
    const raw = await res.text();

    // try to parse JSON for nicer logging and to continue using it
    let parsedBody: any = raw;
    try {
      parsedBody = JSON.parse(raw);
    } catch (e) {
      // leave parsedBody as raw text if not JSON
    }

    if (![200, 201].includes(res.status)) {
      // guaranteed logging before failing the test
      console.error('--- API ERROR ---');
      console.error('URL:', `${API_BASE}/api/orders`);
      console.error('Status:', res.status);
      console.error('Body:', parsedBody);
      console.error('--- end API ERROR ---');

      // Fail with an explicit error so the stacktrace points to the test
      throw new Error(`API returned ${res.status}. See logs above for body.`);
    }

    // OK - parse the json value we already retrieved
    const json = typeof parsedBody === 'object' ? parsedBody : JSON.parse(parsedBody);
    const orderId = json.orderId;
    expect(orderId).toBeTruthy();

    // -----------------------------
    // Wait for job via Redis stream
    // -----------------------------
    const { jobId } = await waitForJobEvent(redis, queue, orderId);

    expect(jobId).toBeDefined();

    // Get the events for this job (recent only)
    const last20 = await redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', 20);
    const jobEvents = last20
      .map((raw) => parseEntry(raw as [string, string[]]))
      .filter((x) => x.obj['jobId'] === jobId)
      .map((x) => x.obj['event']);

    // Should have lifecycle events
    // Must contain added and active before completion
    expect(jobEvents).toContain('added');
    expect(jobEvents).toContain('active');

    // Now wait specifically for the completed event
    await waitForCompleted(redis, jobId);

    // After waiting, re-read the stream to confirm it is now present
    const refreshed = await redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', 50);
    const refreshedEvents = refreshed
      .map((raw) => parseEntry(raw as [string, string[]]))
      .filter((x) => x.obj['jobId'] === jobId)
      .map((x) => x.obj['event']);

    expect(refreshedEvents).toContain('completed');
  });
});
