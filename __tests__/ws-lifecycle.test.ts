/**
 * __tests__/ws-lifecycle.test.ts
 *
 * Tests the full WebSocket lifecycle:
 * - Order submission → Worker processing → Event publishing
 * - Verifies all status transitions (routing, building, submitted, confirmed)
 * - Validates WebSocket events are published correctly
 */

import { Queue, Job } from 'bullmq';
import Redis from 'ioredis';
import { processOrder, ProcessOrderDeps } from '../src/workers/worker';
import MockDexRouter from '../src/lib/mockDexRouter';
import { setRedisClientForTest, publishOrderEvent } from '../src/lib/ws/publisher';

// Mock logger to avoid console noise
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
  silent: jest.fn(),
  level: 'info' as const,
  msgPrefix: '',
} as any;

describe('WebSocket Lifecycle Tests', () => {
  let redisClient: Redis;
  let mockSaveOrderEvent: jest.Mock;
  let mockPublishOrderEvent: jest.Mock;
  let router: MockDexRouter;
  let subscriberClient: Redis;
  
  beforeAll(() => {
    // Create Redis clients for testing
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    
    subscriberClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });

  beforeEach(() => {
    // Reset mocks
    mockSaveOrderEvent = jest.fn().mockResolvedValue(undefined);
    mockPublishOrderEvent = jest.fn().mockResolvedValue(undefined);
    router = new MockDexRouter(false); // deterministic mode
    
    // Clear logger mocks
    jest.clearAllMocks();
  });

  afterAll(async () => {
    // Cleanup Redis connections
    await redisClient.quit();
    await subscriberClient.quit();
  });

  describe('Order Processing with Event Publishing', () => {
    test('should publish all lifecycle events in correct order', async () => {
      const orderId = 'test-order-lifecycle-001';
      const jobData = {
        orderId,
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 100,
      };

      // Create a mock job
      const mockJob = {
        id: 'job-001',
        data: jobData,
        attemptsMade: 0,
      } as Job;

      const deps: ProcessOrderDeps = {
        router,
        saveOrderEvent: mockSaveOrderEvent,
        publishOrderEvent: mockPublishOrderEvent,
        logger: mockLogger,
      };

      // Execute the order processing
      const result = await processOrder(mockJob, deps);

      // Verify the result structure
      expect(result).toMatchObject({
        status: 'filled',
        txHash: expect.any(String),
        executedPrice: expect.any(Number),
        dex: expect.stringMatching(/^(raydium|meteora)$/),
        attempts: 1,
        ok: true,
      });

      // Verify publish was called for each status transition
      const publishCalls = mockPublishOrderEvent.mock.calls;
      
      expect(publishCalls.length).toBeGreaterThanOrEqual(4);
      
      // Check routing event
      expect(publishCalls[0]).toEqual([
        orderId,
        { status: 'routing', attempt: 1 }
      ]);

      // Check building event
      expect(publishCalls[1]).toEqual([
        orderId,
        expect.objectContaining({
          status: 'building',
          chosen: expect.objectContaining({
            dex: expect.stringMatching(/^(raydium|meteora)$/),
            price: expect.any(Number),
          }),
          attempt: 1,
        })
      ]);

      // Check submitted event
      expect(publishCalls[2]).toEqual([
        orderId,
        expect.objectContaining({
          status: 'submitted',
          txHash: expect.any(String),
          attempt: 1,
        })
      ]);

      // Check confirmed event
      expect(publishCalls[3]).toEqual([
        orderId,
        expect.objectContaining({
          status: 'confirmed',
          txHash: expect.any(String),
          executedPrice: expect.any(Number),
          dex: expect.stringMatching(/^(raydium|meteora)$/),
          attempts: 1,
          ok: true,
        })
      ]);
    });

    test('should publish failed event on error', async () => {
      const orderId = 'test-order-failure-001';
      const jobData = {
        orderId,
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 100,
      };

      const mockJob = {
        id: 'job-002',
        data: jobData,
        attemptsMade: 0,
      } as Job;

      // Create a router that fails
      const failingRouter = new MockDexRouter(false);
      jest.spyOn(failingRouter, 'executeSwap').mockRejectedValue(
        new Error('Network timeout')
      );

      const deps: ProcessOrderDeps = {
        router: failingRouter,
        saveOrderEvent: mockSaveOrderEvent,
        publishOrderEvent: mockPublishOrderEvent,
        logger: mockLogger,
      };

      // Execute and expect failure
      await expect(processOrder(mockJob, deps)).rejects.toThrow('Network timeout');

      // Verify failed event was published
      const publishCalls = mockPublishOrderEvent.mock.calls;
      const failedCall = publishCalls.find(call => 
        call[1]?.status === 'failed'
      );

      expect(failedCall).toBeDefined();
      expect(failedCall).toEqual([
        orderId,
        expect.objectContaining({
          status: 'failed',
          error: 'Network timeout',
          attempt: 1,
        })
      ]);
    });
  });

  describe('Real Redis PubSub Integration', () => {
    test('should receive events through Redis pubsub', async () => {
      const orderId = 'test-order-pubsub-001';
      const channel = `order:events:${orderId}`;
      const receivedEvents: any[] = [];

      // Create a promise to wait for all events
      const eventsReceived = new Promise<void>((resolve, reject) => {
        subscriberClient.on('message', (ch, message) => {
          if (ch === channel) {
            receivedEvents.push(JSON.parse(message));
            
            // Check if we received the confirmed event (last one)
            if (receivedEvents.length >= 4) {
              try {
                // Verify event sequence
                expect(receivedEvents[0]).toMatchObject({ status: 'routing' });
                expect(receivedEvents[1]).toMatchObject({ status: 'building' });
                expect(receivedEvents[2]).toMatchObject({ status: 'submitted' });
                expect(receivedEvents[3]).toMatchObject({ 
                  status: 'confirmed',
                  ok: true,
                });
                
                resolve();
              } catch (error) {
                reject(error);
              }
            }
          }
        });
      });

      // Set up subscriber
      await subscriberClient.subscribe(channel);
      
      // Give subscriber time to be ready
      await new Promise(resolve => setTimeout(resolve, 100));

      const jobData = {
        orderId,
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 100,
      };

      const mockJob = {
        id: 'job-003',
        data: jobData,
        attemptsMade: 0,
      } as Job;

      // Inject the real Redis client for publishing
      setRedisClientForTest(redisClient);

      const deps: ProcessOrderDeps = {
        router,
        saveOrderEvent: mockSaveOrderEvent,
        publishOrderEvent, // Use real publisher
        logger: mockLogger,
      };

      // Execute the order
      await processOrder(mockJob, deps);
      
      // Wait for all events to be received
      await eventsReceived;
      
      // Clean up
      await subscriberClient.unsubscribe(channel);
    }, 10000); // 10 second timeout for async test

    test('should handle multiple concurrent orders', async () => {
      const orderIds = ['order-001', 'order-002', 'order-003'];
      const results = new Map<string, any[]>();

      // Set up subscribers for all orders
      const subscribePromises = orderIds.map(async (orderId) => {
        const channel = `order:events:${orderId}`;
        results.set(orderId, []);
        
        // Create a new subscriber for each order
        const sub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        });
        
        await sub.subscribe(channel);
        
        sub.on('message', (ch, message) => {
          if (ch === channel) {
            results.get(orderId)?.push(JSON.parse(message));
          }
        });

        return sub;
      });

      const subscribers = await Promise.all(subscribePromises);

      // Give subscribers time to be ready
      await new Promise(resolve => setTimeout(resolve, 200));

      // Inject real Redis client
      setRedisClientForTest(redisClient);

      // Process all orders concurrently
      const processPromises = orderIds.map(async (orderId, index) => {
        const mockJob = {
          id: `job-${index}`,
          data: {
            orderId,
            tokenIn: 'SOL',
            tokenOut: 'USDC',
            amountIn: 100 + index * 10,
          },
          attemptsMade: 0,
        } as Job;

        const deps: ProcessOrderDeps = {
          router: new MockDexRouter(false),
          saveOrderEvent: mockSaveOrderEvent,
          publishOrderEvent,
          logger: mockLogger,
        };

        return processOrder(mockJob, deps);
      });

      await Promise.all(processPromises);

      // Wait for events to be received
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify each order received all events
      orderIds.forEach(orderId => {
        const events = results.get(orderId) || [];
        expect(events.length).toBeGreaterThanOrEqual(4);
        
        const statuses = events.map(e => e.status);
        expect(statuses).toContain('routing');
        expect(statuses).toContain('building');
        expect(statuses).toContain('submitted');
        expect(statuses).toContain('confirmed');
      });

      // Cleanup subscribers
      await Promise.all(subscribers.map(sub => sub.quit()));
    }, 15000);
  });

  describe('Retry Attempts with Events', () => {
    test('should track attempt count in published events', async () => {
      const orderId = 'test-order-retry-001';
      const attemptNumber = 3;

      const jobData = {
        orderId,
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 100,
      };

      const mockJob = {
        id: 'job-retry-001',
        data: jobData,
        attemptsMade: attemptNumber - 1, // BullMQ starts at 0
      } as Job;

      const deps: ProcessOrderDeps = {
        router,
        saveOrderEvent: mockSaveOrderEvent,
        publishOrderEvent: mockPublishOrderEvent,
        logger: mockLogger,
      };

      await processOrder(mockJob, deps);

      // Verify all published events have correct attempt number
      const publishCalls = mockPublishOrderEvent.mock.calls;
      
      publishCalls.forEach(call => {
        const payload = call[1];
        if (payload.attempt !== undefined) {
          expect(payload.attempt).toBe(attemptNumber);
        }
        if (payload.attempts !== undefined) {
          expect(payload.attempts).toBe(attemptNumber);
        }
      });
    });
  });

  describe('Event Persistence and Publishing', () => {
    test('should continue publishing even if save fails', async () => {
      const orderId = 'test-order-save-fail-001';
      
      // Mock saveOrderEvent to fail only for 'confirmed' status
      // but succeed for others so the job can complete
      const failingSave = jest.fn().mockImplementation((id: string, status: string, data: any) => {
        if (status === 'confirmed') {
          return Promise.reject(new Error('Database connection lost'));
        }
        return Promise.resolve();
      });

      const jobData = {
        orderId,
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 100,
      };

      const mockJob = {
        id: 'job-004',
        data: jobData,
        attemptsMade: 0,
      } as Job;

      const deps: ProcessOrderDeps = {
        router,
        saveOrderEvent: failingSave,
        publishOrderEvent: mockPublishOrderEvent,
        logger: mockLogger,
      };

      // Should still complete successfully even though save failed
      const result = await processOrder(mockJob, deps);

      expect(result).toMatchObject({
        status: 'filled',
        ok: true,
      });

      // Verify publish was still called for confirmed event
      const publishCalls = mockPublishOrderEvent.mock.calls;
      const confirmedCall = publishCalls.find(call => 
        call[1]?.status === 'confirmed'
      );

      expect(confirmedCall).toBeDefined();
      
      // Verify error was logged when save failed
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ 
          orderId,
          persistErr: expect.any(Error),
        }),
        'Worker: failed to persist confirmed event'
      );
    });

    test('should log error if publish fails but continue processing', async () => {
      const orderId = 'test-order-publish-fail-001';
      
      // Mock publishOrderEvent to fail only for 'confirmed' status
      // but succeed for others so the job can complete
      const failingPublish = jest.fn().mockImplementation((id: string, payload: any) => {
        if (payload.status === 'confirmed') {
          return Promise.reject(new Error('Redis connection lost'));
        }
        return Promise.resolve();
      });

      const jobData = {
        orderId,
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 100,
      };

      const mockJob = {
        id: 'job-005',
        data: jobData,
        attemptsMade: 0,
      } as Job;

      const deps: ProcessOrderDeps = {
        router,
        saveOrderEvent: mockSaveOrderEvent,
        publishOrderEvent: failingPublish,
        logger: mockLogger,
      };

      // Should still complete successfully even though publish failed
      const result = await processOrder(mockJob, deps);

      expect(result).toMatchObject({
        status: 'filled',
        ok: true,
      });

      // Verify error was logged when publish failed
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ 
          orderId,
          pubErr: expect.any(Error),
        }),
        'Worker: failed to publish confirmed event'
      );
    });
  });

  describe('Event Payload Validation', () => {
    test('should include all required fields in confirmed event', async () => {
      const orderId = 'test-order-payload-001';

      const jobData = {
        orderId,
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 100,
      };

      const mockJob = {
        id: 'job-006',
        data: jobData,
        attemptsMade: 0,
      } as Job;

      const deps: ProcessOrderDeps = {
        router,
        saveOrderEvent: mockSaveOrderEvent,
        publishOrderEvent: mockPublishOrderEvent,
        logger: mockLogger,
      };

      await processOrder(mockJob, deps);

      const publishCalls = mockPublishOrderEvent.mock.calls;
      const confirmedCall = publishCalls.find(call => 
        call[1]?.status === 'confirmed'
      );

      expect(confirmedCall).toBeDefined();
      const [_, payload] = confirmedCall!;

      // Verify all required fields are present
      expect(payload).toHaveProperty('status', 'confirmed');
      expect(payload).toHaveProperty('txHash');
      expect(payload).toHaveProperty('executedPrice');
      expect(payload).toHaveProperty('dex');
      expect(payload).toHaveProperty('attempts');
      expect(payload).toHaveProperty('ok', true);

      // Verify types
      expect(typeof payload.txHash).toBe('string');
      expect(typeof payload.executedPrice).toBe('number');
      expect(['raydium', 'meteora']).toContain(payload.dex);
      expect(typeof payload.attempts).toBe('number');
    });
  });
});