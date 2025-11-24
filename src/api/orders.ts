// src/api/orders.ts
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { pgPool } from '../lib/postgre';
import { orderQueue } from '../lib/queue';

export default async function routes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions
) {
  fastify.post('/orders', async (request, reply) => {
    const body = request.body as any;

    // Basic validation -> 400 Bad Request
    if (
      !body ||
      typeof body.userId !== 'string' ||
      typeof body.tokenIn !== 'string' ||
      typeof body.tokenOut !== 'string' ||
      typeof body.amountIn !== 'string'
    ) {
      return reply.status(400).send({ error: 'Invalid order payload' });
    }

    const orderId = uuidv4();

    // Simplify: single INSERT (no manual client/transaction) for this flow.
    // If you later need atomicity with other writes, switch back to client + BEGIN/COMMIT.
    const insertSql = `
      INSERT INTO orders (
        id, user_id, type, token_in, token_out, amount_in, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'queued')
    `;

    try {
      await pgPool.query(insertSql, [
        orderId,
        body.userId,
        'market',
        body.tokenIn,
        body.tokenOut,
        body.amountIn
      ]);

      // Enqueue job and set jobId = orderId to make correlation deterministic for tests
      await orderQueue.add(
        'processOrder',
        {
          orderId,
          userId: body.userId,
          tokenIn: body.tokenIn,
          tokenOut: body.tokenOut,
          amountIn: body.amountIn
        },
        {
          jobId: orderId,
          removeOnComplete: true,
          removeOnFail: false
        }
      );

      return reply.status(201).send({ orderId });
    } catch (err: any) {
      fastify.log.error({ err }, 'Failed to submit order');
      // keep message short but useful for tests; avoid leaking stack in prod
      return reply.status(500).send({ error: 'Failed to submit order', message: err?.message });
    }
  });
}
