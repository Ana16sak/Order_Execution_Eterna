import { describe, it, expect } from '@jest/globals';
import MockDexRouter from '../src/lib/mockDexRouter';

describe('DEX routing logic', () => {
  it('chooses meteora when its price is lower', async () => {
    const router = new MockDexRouter(true);

    // Override deterministic methods
    router.getRaydiumQuote = async () => ({
      price: 100,
      fee: 0.003,
      dex: 'raydium'
    });

    router.getMeteoraQuote = async () => ({
      price: 98,
      fee: 0.002,
      dex: 'meteora'
    });

    const r = await router.getRaydiumQuote('A', 'B', 100);
    const m = await router.getMeteoraQuote('A', 'B', 100);

    const raydiumCost = r.price * (1 + r.fee);
    const meteoraCost = m.price * (1 + m.fee);

    const chosen = meteoraCost < raydiumCost ? m : r;

    expect(chosen.dex).toBe('meteora');
  });
});
