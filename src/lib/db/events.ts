// src/lib/db/events.ts
import { pool } from './pool'; // Your db connection (pg Pool)

export async function saveOrderEvent(
  orderId: string,
  event: string,
  meta?: any
) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO order_events (order_id, event, meta)
       VALUES ($1, $2, $3)`,
      [orderId, event, meta ? JSON.stringify(meta) : null]
    );
  } finally {
    client.release();
  }
}
