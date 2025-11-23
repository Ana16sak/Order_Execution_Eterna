// src/lib/ws/publisher.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

export async function publishOrderEvent(orderId: string, payload: any) {
  const channel = `order:events:${orderId}`;
  await redis.publish(channel, JSON.stringify(payload));
}
