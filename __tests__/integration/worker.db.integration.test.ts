// __tests__/integration/order_retries.db.test.ts
/**
 * Integration test: orders retry reporting (DB)
 *
 * - NO app_users table; assume a single fixed user id is acceptable
 * - order_events columns: id, order_id, event, meta, created_at
 * - orders columns: id, user_id, type, token_in, token_out, amount_in, amount_out,
 *   min_amount_out, chosen_dex, route_meta, retries, max_retries, status,
 *   status_timeline, tx_hash, error_reason, metadata, created_at, updated_at
 *
 * The test:
 *  - Inserts a minimal orders row (with a fixed user_id)
 *  - Simulates 3 failing attempts by calling processOrder with attemptsMade = 0,1,2
 *  - saveOrderEventInline inserts into order_events (using event/meta) and updates orders
 *  - Asserts retries = 3, status = 'failed', error_reason contains last failure,
 *    status_timeline contains three failed entries, and order_events has 3 failed rows.
 *
 * Spec ref: /mnt/data/Backend Task 2_ Order Execution Engine.pdf
 */

import { Pool } from 'pg';
import { processOrder } from '../../src/workers/worker';
import type { Job } from 'bullmq';

jest.setTimeout(20000);

function makeJob(orderId: string, attemptsMade: number): Job {
  return {
    id: `job-${attemptsMade}`,
    data: {
      orderId,
      tokenIn: 'TKNA',
      tokenOut: 'TKNB',
      amountIn: 100,
    },
    attemptsMade,
  } as any;
}

describe('integration: orders retry reporting (DB) - schema-aligned', () => {
  const pool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'orders',
  });

  const truncateAll = async () => {
    // truncate order_events and orders for a clean slate
    await pool.query('TRUNCATE order_events, orders RESTART IDENTITY CASCADE;');
  };

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await truncateAll();
    await pool.end();
  });

  it('increments retries and records failed events and timeline after repeated failures', async () => {
    // 1) Insert a minimal order row. Use a fixed user_id (no app_users table).
    const orderId = '00000000-0000-0000-0000-00000000abcd';
    const fixedUserId = '00000000-0000-0000-0000-000000000001';

    await pool.query(
      `INSERT INTO orders (
         id, user_id, type, token_in, token_out, amount_in,
         amount_out, min_amount_out, chosen_dex, route_meta,
         retries, max_retries, status, status_timeline,
         tx_hash, error_reason, metadata, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'market', 'TKNA', 'TKNB', 100,
         NULL, NULL, NULL, '{}'::jsonb,
         0, 3, $3::order_status, '[]'::jsonb,
         NULL, NULL, '{}'::jsonb, now(), now()
       )`,
      [orderId, fixedUserId, 'queued']
    );

    // 2) Router stub that fails every time to simulate repeated errors
    let call = 0;
    const router = {
      getRaydiumQuote: jest.fn().mockResolvedValue({ price: 100, fee: 0.003 }),
      getMeteoraQuote: jest.fn().mockResolvedValue({ price: 110, fee: 0.002 }),
      executeSwap: jest.fn().mockImplementation(async () => {
        call += 1;
        throw new Error(`simulated failure ${call}`);
      }),
    } as any;

    const publishOrderEvent = jest.fn().mockResolvedValue(undefined);

    // 3) Inline saveOrderEvent that writes into order_events (event/meta) and updates orders table.
    //    Uses explicit casts and JSON.stringify for meta to avoid inference/type issues.
    const saveOrderEventInline = async (id: string, eventType: string, payload: any) => {
      const metaJson = JSON.stringify(payload ?? {});

      // Insert into order_events using event/meta columns
      try {
        await pool.query(
          `INSERT INTO order_events (order_id, event, meta, created_at)
           VALUES ($1::uuid, $2::text, $3::jsonb, now())`,
          [id, eventType, metaJson]
        );
      } catch (err) {
        console.error('INSERT INTO order_events failed:', err);
        throw err;
      }

      // Update orders depending on event type
      try {
        if (eventType === 'failed') {
          // increment retries, set status to 'failed', set error_reason, and append to status_timeline
          await pool.query(
            `UPDATE orders
             SET
               retries = COALESCE(retries,0) + 1,
               status = $2::order_status,
               error_reason = $3::text,
               status_timeline = status_timeline || jsonb_build_array(
                 jsonb_build_object(
                   'status', 'failed',
                   'error', $3::text,
                   'attempt', $4::int,
                   'at', now()
                 )
               ),
               updated_at = now()
             WHERE id = $1::uuid`,
            [id, 'failed', payload?.error ?? null, payload?.attempt ?? null]
          );
        } else {
          // normal status transition: update status and append a timeline entry
          await pool.query(
            `UPDATE orders
             SET
               status = $2::order_status,
               status_timeline = status_timeline || jsonb_build_array(
                 jsonb_build_object(
                   'status', $2::text,
                   'meta', $3::jsonb,
                   'attempt', $4::int,
                   'at', now()
                 )
               ),
               updated_at = now()
             WHERE id = $1::uuid`,
            [id, eventType, metaJson, payload?.attempt ?? null]
          );
        }
      } catch (err) {
        console.error('UPDATE orders failed:', err);
        throw err;
      }
    };

    // 4) Simulate 3 attempts (attemptsMade: 0,1,2)
    for (let attemptsMade = 0; attemptsMade < 3; attemptsMade++) {
      const job = makeJob(orderId, attemptsMade);
      const logger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        } as any;
      await expect(
        processOrder(job, {
          router,
          saveOrderEvent: saveOrderEventInline,
          publishOrderEvent,
          logger,
        })
      ).rejects.toThrow(/simulated failure/);
    }

    // 5) Validate DB state: orders table
    const { rows } = await pool.query(`SELECT id, retries, status, error_reason, status_timeline FROM orders WHERE id = $1`, [orderId]);
    expect(rows.length).toBe(1);
    const order = rows[0];

    expect(order.retries).toBe(3);
    expect(order.status).toBe('failed');
    expect(order.error_reason).toMatch(/simulated failure 3/);

    const timeline = order.status_timeline || [];
    const failedEntries = (timeline as any[]).filter((e: any) => e.status === 'failed');
    expect(failedEntries.length).toBe(3);

    // 6) Validate order_events rows (event column = 'failed')
    const { rows: eventRows } = await pool.query(
      `SELECT event, meta FROM order_events WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );
    const failedEvents = eventRows.filter((r: any) => r.event === 'failed');
    expect(failedEvents.length).toBe(3);

    // 7) Ensure publishOrderEvent was invoked for the events
    expect(publishOrderEvent.mock.calls.length).toBeGreaterThanOrEqual(3);
    const publishedFailedCalls = publishOrderEvent.mock.calls.filter((c: any[]) => c[1]?.status === 'failed');
    expect(publishedFailedCalls.length).toBeGreaterThanOrEqual(1);
  });
});