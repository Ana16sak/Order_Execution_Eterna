/**
 * src/lib/pg.ts
 *
 * Postgres pool wrapper used across the app.
 *
 * Exports:
 *  - pgPool: the singleton Pool instance
 *  - query: convenience wrapper for pool.query
 *  - getClient: get a PoolClient for manual transactions
 *
 * Behavior:
 *  - Reads config from environment variables:
 *      PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_CONNECTION_STRING
 *  - Installs graceful shutdown handlers to close the pool on SIGINT/SIGTERM
 */

import { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { logger } from './logger';

const {
  PG_CONNECTION_STRING,
  PG_HOST = 'localhost',
  PG_PORT = '5432',
  PG_USER = 'postgres',
  PG_PASSWORD = 'postgres',
  PG_DATABASE = 'orders',
  PG_MAX_CLIENTS = '10',
  PG_IDLE_TIMEOUT_MS = '30000'
} = process.env;

const poolConfig = PG_CONNECTION_STRING
  ? {
      connectionString: PG_CONNECTION_STRING,
      max: parseInt(PG_MAX_CLIENTS, 10),
      idleTimeoutMillis: parseInt(PG_IDLE_TIMEOUT_MS, 10)
    }
  : {
      host: PG_HOST,
      port: parseInt(PG_PORT, 10),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
      max: parseInt(PG_MAX_CLIENTS, 10),
      idleTimeoutMillis: parseInt(PG_IDLE_TIMEOUT_MS, 10)
    };

export const pgPool = new Pool(poolConfig);

pgPool.on('error', (err) => {
  // This is a generic error on an idle client — log it for visibility
  logger.error({ err }, 'Unexpected error on Postgres idle client');
});

/**
 * Convenience wrapper around pool.query with typed generics.
 *
 * Usage:
 *   const res = await query<{ id: string }>('INSERT ... RETURNING id', [..]);
 */
export async function query<T extends QueryResultRow = any>(
  text: string | QueryConfig,
  params?: any[]
): Promise<QueryResult<T>> {
  try {
    return await pgPool.query<T>(text as any, params);
  } catch (err) {
    logger.error({ err, text, params }, 'Postgres query error');
    throw err;
  }
}

/**
 * Get a client for manual transaction control.
 *
 * Example:
 *  const client = await getClient();
 *  try {
 *    await client.query('BEGIN');
 *    ...
 *    await client.query('COMMIT');
 *  } catch (e) {
 *    await client.query('ROLLBACK');
 *    throw e;
 *  } finally {
 *    client.release();
 *  }
 */
export async function getClient(): Promise<PoolClient> {
  const client = await pgPool.connect();
  // Optional: attach quick debug logging helpers
  const originalQuery = client.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).query = async (text: any, params?: any[]) => {
    try {
      return (originalQuery as any).apply(client, [text, params]);
    } catch (err) {
      logger.error({ err, text, params }, 'Postgres client query error');
      throw err;
    }
  };
  return client;
}

/**
 * Graceful shutdown: close pool on SIGINT / SIGTERM
 */
let shuttingDown = false;
async function shutdownPool(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down Postgres pool');
  try {
    await pgPool.end();
    logger.info('Postgres pool has ended');
  } catch (err) {
    logger.error({ err }, 'Error while shutting down Postgres pool');
  } finally {
    // allow process to exit; not calling process.exit here to keep caller in control
  }
}

process.on('SIGINT', () => shutdownPool('SIGINT'));
process.on('SIGTERM', () => shutdownPool('SIGTERM'));
process.on('beforeExit', () => shutdownPool('beforeExit'));
