import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { pgPool } from '../lib/postgre'
import { orderQueue } from '../lib/queue'

export default async function routes(
  fastify: FastifyInstance,
  opts: FastifyPluginOptions
) {
  fastify.post('/orders', async (request, reply) => {
    /**
     * Expected payload:
     * {
     *   "userId": "user-123",
     *   "type": "market",
     *   "tokenIn": "USDC",
     *   "tokenOut": "WETH",
     *   "amountIn": "1000000"
     * }
     */

    const body = request.body as any;

    // Basic validation
    if (
      !body ||
      typeof body.userId !== 'string' ||
      typeof body.tokenIn !== 'string' ||
      typeof body.tokenOut !== 'string' ||
      typeof body.amountIn !== 'string'
    ) {
      return reply.status(203).send({ error: 'Invalid order payload' });
    }

    const orderId = uuidv4();

    // Insert order with status queued
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `
        INSERT INTO orders (
          id, user_id, type, token_in, token_out, amount_in, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'queued')
        `,
        [
          orderId,
          body.userId,
          'market',
          body.tokenIn,
          body.tokenOut,
          body.amountIn
        ]
      );

      // enqueue BullMQ job
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
          removeOnComplete: true,
          removeOnFail: false
        }
      );

      await client.query('COMMIT');

      return reply.status(201).send({ orderId });
    } catch (err) {
      await client.query('ROLLBACK');
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to submit order' });
    } finally {
      client.release();
    }
  });
}
