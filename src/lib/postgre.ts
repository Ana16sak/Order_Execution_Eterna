// src/lib/postgre.ts
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

// singleton pool
export const pgPool = new Pool(poolConfig);

pgPool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on Postgres idle client');
});

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

export async function getClient(): Promise<PoolClient> {
  const client = await pgPool.connect();
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

let shuttingDown = false;
export async function shutdownPool(signal?: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (signal) logger.info({ signal }, 'Shutting down Postgres pool');
    await pgPool.end();
    logger.info('Postgres pool has ended');
  } catch (err) {
    logger.error({ err }, 'Error while shutting down Postgres pool');
    throw err;
  }
}

/**
 * Attach handlers only when not running tests. Tests set NODE_ENV=test
 * to avoid accidental pool shutdown during test lifecycle.
 */
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGINT', () => shutdownPool('SIGINT'));
  process.on('SIGTERM', () => shutdownPool('SIGTERM'));
  // intentionally do NOT use 'beforeExit'
}
