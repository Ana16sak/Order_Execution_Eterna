// __tests__/helpers/testDb.ts
import { Pool } from 'pg';
import { logger } from '../src/lib/logger';

/**
 * Test-specific database pool that won't auto-shutdown
 * This prevents "Cannot use a pool after calling end" errors in integration tests
 */

let testPool: Pool | null = null;

export function getTestPool(): Pool {
  if (!testPool) {
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

    testPool = new Pool(poolConfig);

    testPool.on('error', (err) => {
      logger.error({ err }, 'Test pool: Unexpected error on Postgres idle client');
    });
  }

  return testPool;
}

export async function closeTestPool(): Promise<void> {
  if (testPool) {
    try {
      await testPool.end();
      testPool = null;
    } catch (err) {
      logger.error({ err }, 'Error closing test pool');
    }
  }
}

export async function resetTestPool(): Promise<void> {
  await closeTestPool();
  // Next call to getTestPool() will create a fresh pool
}