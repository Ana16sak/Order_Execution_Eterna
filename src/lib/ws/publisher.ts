// src/lib/ws/publisher.ts
import Redis from 'ioredis';

let redisClient: Redis | null = null;
let createdInternally = false;

/**
 * Internal helper: create a redis client lazily.
 * We avoid creating a client at module import so tests don't hang.
 */
function getRedis(): Redis {
  if (redisClient) return redisClient;

  const url = process.env.REDIS_URL || 'redis://redis:6379';
  // create and cache client
  redisClient = new Redis(url, {
    // safe defaults used elsewhere in the app - adjust if needed
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  createdInternally = true;
  return redisClient;
}

/**
 * Test / integration hook: inject a Redis-like client.
 * Useful in tests to inject a mock that doesn't keep the event loop alive.
 */
export function setRedisClientForTest(client: Redis | null) {
  // if provided null, we clear client (useful for teardown)
  if (redisClient && createdInternally) {
    // try to clean up internally created client when replacing it
    try {
      redisClient.quit().catch(() => redisClient?.disconnect());
    } catch {}
  }
  redisClient = client;
  createdInternally = false;
}

/**
 * Publish event for an order.
 * Lazily creates the Redis client if none injected.
 */
export async function publishOrderEvent(orderId: string, payload: any) {
  const channel = `order:events:${orderId}`;
  const cli = getRedis();
  await cli.publish(channel, JSON.stringify(payload));
}

/**
 * Close the internal client if it was created by this module.
 * Useful for graceful shutdown or afterAll in tests.
 */
export async function closePublisherRedis() {
  if (!redisClient) return;
  try {
    if (createdInternally) {
      await redisClient.quit();
    }
  } catch (err) {
    try {
      redisClient.disconnect();
    } catch {}
  } finally {
    redisClient = null;
    createdInternally = false;
  }
}
