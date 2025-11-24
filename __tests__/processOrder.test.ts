// __tests__/processOrder.test.ts
import { processOrder } from '../src/workers/worker';
import type { Job } from 'bullmq';
import { setRedisClientForTest, closePublisherRedis } from '../src/lib/ws/publisher';
import * as wsPub from '../src/lib/ws/publisher';

beforeAll(() => {
    const fakeRedisClient = {
        publish: jest.fn().mockResolvedValue(1),
        quit: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
    } as any;
    setRedisClientForTest(fakeRedisClient);
});

describe('processOrder (unit)', () => {
    const makeJob = (data: any, attemptsMade = 0): Job => {
        return {
            id: 'job-1',
            data,
            attemptsMade,
        } as unknown as Job;
    };

    const makeDeps = () => {
        const saveOrderEvent = jest.fn().mockResolvedValue(undefined);
        const publishOrderEvent = jest.fn().mockResolvedValue(undefined);
        const logger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        } as any;

        // lightweight stub router (no sleeps, fully controlled in tests)
        const router = {
            getRaydiumQuote: jest.fn(),
            getMeteoraQuote: jest.fn(),
            executeSwap: jest.fn(),
        } as any;

        return { saveOrderEvent, publishOrderEvent, logger, router };
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('chooses Raydium when ray.price <= met.price and completes successfully', async () => {
        const { saveOrderEvent, publishOrderEvent, logger, router } = makeDeps();

        // Ray cheaper
        router.getRaydiumQuote.mockResolvedValue({ price: 100, fee: 0.003, dex: 'raydium' });
        router.getMeteoraQuote.mockResolvedValue({ price: 105, fee: 0.002, dex: 'meteora' });
        router.executeSwap.mockResolvedValue({
            txHash: 'tx-ray-123',
            executedPrice: 100.2,
            dex: 'raydium',
        });

        const job = makeJob({
            orderId: 'order-ray-1',
            tokenIn: 'TKNA',
            tokenOut: 'TKNB',
            amountIn: 1000,
        }, /* attemptsMade */ 0);

        // BEFORE calling processOrder
        // console.log('IN TEST - injected publish fn:', publishOrderEvent);
        // console.log('IN TEST - module publish fn:', wsPub.publishOrderEvent);

        const res = await processOrder(job, {
            router,
            saveOrderEvent,
            publishOrderEvent,
            logger,
        });

        // // AFTER
        // console.log('publishOrderEvent.mock.calls:', publishOrderEvent.mock.calls);
        // console.log('module publishOrderEvent.mock?.calls:', (wsPub.publishOrderEvent as any)?.mock?.calls);

        // console.log('--- SAVE CALLS ---');
        // saveOrderEvent.mock.calls.forEach((c, i) => console.log(i, JSON.stringify(c)));
        // console.log('--- PUBLISH CALLS ---');
        // publishOrderEvent.mock.calls.forEach((c, i) => console.log(i, JSON.stringify(c)));

        // Also log the module publisher (if present)

        // console.log('module publish fn === injected mock?', wsPub.publishOrderEvent === publishOrderEvent);
        // console.log('module publish calls (if mocked):', (wsPub.publishOrderEvent as any)?.mock?.calls);

        // result shape
        expect(res.ok).toEqual(true);
        expect(res.txHash).toEqual('tx-ray-123');
        expect(res.executedPrice).toEqual(100.2);
        expect(res.dex).toEqual('raydium');
        expect(res.attempts).toEqual(1);

        // lifecycle events persisted & published (include attempt)
        expect(saveOrderEvent).toHaveBeenCalledWith('order-ray-1', 'routing', expect.any(Object));
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-ray-1',
            expect.objectContaining({ status: 'routing', attempt: expect.any(Number) })
        );

        expect(saveOrderEvent).toHaveBeenCalledWith('order-ray-1', 'building', expect.any(Object));
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-ray-1',
            expect.objectContaining({ status: 'building', attempt: expect.any(Number) })
        );
        expect(saveOrderEvent).toHaveBeenCalledWith('order-ray-1', 'submitted', expect.any(Object));
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-ray-1',
            expect.objectContaining({ status: 'submitted', attempt: expect.any(Number) })
        );

        expect(saveOrderEvent).toHaveBeenCalledWith(
            'order-ray-1',
            'confirmed',
            expect.objectContaining({
                txHash: 'tx-ray-123',
                executedPrice: 100.2,
                dex: 'raydium',
                attempts: 1,
                ok: true,
            })
        );
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-ray-1',
            expect.objectContaining({
                status: 'confirmed',
                txHash: 'tx-ray-123',
                executedPrice: 100.2,
                dex: 'raydium',
                attempts: 1,
                ok: true,
            })
        );

    });

    it('chooses Meteora when meteora price is lower', async () => {
        const { saveOrderEvent, publishOrderEvent, logger, router } = makeDeps();

        // Meteora cheaper
        router.getRaydiumQuote.mockResolvedValue({ price: 120, fee: 0.003, dex: 'raydium' });
        router.getMeteoraQuote.mockResolvedValue({ price: 110, fee: 0.002, dex: 'meteora' });
        router.executeSwap.mockResolvedValue({
            txHash: 'tx-met-999',
            executedPrice: 110.5,
            dex: 'meteora',
        });

        const job = makeJob({
            orderId: 'order-met-1',
            tokenIn: 'TKNC',
            tokenOut: 'TKND',
            amountIn: 500,
        });

        const res = await processOrder(job, {
            router,
            saveOrderEvent,
            publishOrderEvent,
            logger,
        });

        expect(res.ok).toEqual(true);
        expect(res.txHash).toEqual('tx-met-999');
        expect(res.executedPrice).toEqual(110.5);
        expect(res.dex).toEqual('meteora');
        expect(res.attempts).toEqual(1);

        // lifecycle events persisted & published (include attempt)
        expect(saveOrderEvent).toHaveBeenCalledWith('order-met-1', 'routing', expect.any(Object));
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-met-1',
            expect.objectContaining({ status: 'routing', attempt: expect.any(Number) })
        );

        expect(saveOrderEvent).toHaveBeenCalledWith('order-met-1', 'building', expect.any(Object));
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-met-1',
            expect.objectContaining({ status: 'building', attempt: expect.any(Number) })
        );
        expect(saveOrderEvent).toHaveBeenCalledWith('order-met-1', 'submitted', expect.any(Object));
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-met-1',
            expect.objectContaining({ status: 'submitted', attempt: expect.any(Number) })
        );

        expect(saveOrderEvent).toHaveBeenCalledWith('order-met-1', 'confirmed', expect.any(Object));
        expect(saveOrderEvent).toHaveBeenCalledWith(
            'order-met-1',
            'confirmed',
            expect.objectContaining({
                txHash: 'tx-met-999',
                executedPrice: 110.5,
                dex: 'meteora',
                attempts: 1,
                ok: true,
            })
        );
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-met-1',
            expect.objectContaining({
                status: 'confirmed',
                txHash: 'tx-met-999',
                executedPrice: 110.5,
                dex: 'meteora',
                attempts: 1,
                ok: true,
            })
        );
    });

    it('persists failed event and publishes failed when executeSwap throws', async () => {
        const { saveOrderEvent, publishOrderEvent, logger, router } = makeDeps();

        // network error
        router.getRaydiumQuote.mockResolvedValue({ price: 120, fee: 0.003, dex: 'raydium' });
        router.getMeteoraQuote.mockResolvedValue({ price: 110, fee: 0.002, dex: 'meteora' });
        router.executeSwap.mockRejectedValue(new Error('network error'));

        const job = makeJob({
            orderId: 'order-fail-1',
            tokenIn: 'TKNE',
            tokenOut: 'TKNF',
            amountIn: 10_000,
        });

        await expect(
            processOrder(job, {
                router, saveOrderEvent, publishOrderEvent, logger
            })
        ).rejects.toThrow('network error');

        // ensure failed event was saved & published (include attempt)
        expect(saveOrderEvent).toHaveBeenCalledWith(
            'order-fail-1',
            'failed',
            expect.objectContaining({
                error: expect.stringContaining('network error'),
                attempt: expect.any(Number),
            })
        );
        expect(publishOrderEvent).toHaveBeenCalledWith(
            'order-fail-1',
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('network error'),
                attempt: expect.any(Number),
            })
        );
    });

    it('throws when job is missing orderId', async () => {
        const { saveOrderEvent, publishOrderEvent, logger, router } = makeDeps();

        const job = makeJob({
            // missing orderId intentionally
            tokenIn: 'X',
            tokenOut: 'Y',
            amountIn: 1,
        });

        await expect(processOrder(job, {
            router, saveOrderEvent, publishOrderEvent, logger
        })).rejects.toThrow('job missing orderId');

        // should not persist lifecycle (we throw early)
        expect(saveOrderEvent).not.toHaveBeenCalled();
        expect(publishOrderEvent).not.toHaveBeenCalled();
    });
});

afterAll(async () => {
    // clean up so Jest can exit
    await closePublisherRedis();
});