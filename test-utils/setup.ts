// __tests__/integration/setup.ts
/**
 * Integration test setup
 * 
 * This file ensures:
 * 1. Database pool stays alive during tests
 * 2. Mock the pgPool to prevent shutdowns
 * 3. Proper cleanup after all tests
 */

import { Pool } from 'pg';

// Store the original pool
let originalPool: Pool | null = null;

/**
 * Mock the pgPool module to prevent shutdown during tests
 */
export function setupTestEnvironment() {
  // Ensure NODE_ENV is set to test
  process.env.NODE_ENV = 'test';
  
  // Create a mock shutdown function that does nothing during tests
  const mockShutdownPool = jest.fn(async (signal?: string) => {
    console.log(`[TEST] Ignoring shutdownPool call with signal: ${signal}`);
    // Do nothing - we'll handle cleanup in afterAll
  });

  // Mock the postgres module
  jest.mock('../../src/lib/postgre', () => {
    const actual = jest.requireActual('../../src/lib/postgre');
    return {
      ...actual,
      shutdownPool: mockShutdownPool,
    };
  });
}

/**
 * Clean up test environment
 */
export async function teardownTestEnvironment() {
  // Import the actual pool to close it
  const { pgPool } = await import('../src/lib/postgre');
  
  try {
    if (pgPool && !(pgPool as any).ended) {
      await pgPool.end();
    }
  } catch (err) {
    console.error('Error closing pool in teardown:', err);
  }
}