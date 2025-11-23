// src/lib/mockDexRouter.ts
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function generateMockTxHash() { return '0x' + Math.random().toString(16).slice(2, 34); }

export default class MockDexRouter {
  basePrice = 20;
  async getRaydiumQuote(tokenIn: string, tokenOut: string, amount: number) {
    await sleep(200);
    return { price: this.basePrice * (0.98 + Math.random() * 0.04), fee: 0.003, dex: 'raydium' };
  }
  async getMeteoraQuote(tokenIn: string, tokenOut: string, amount: number) {
    await sleep(200);
    return { price: this.basePrice * (0.97 + Math.random() * 0.05), fee: 0.002, dex: 'meteora' };
  }
  async executeSwap(dex: string, order: any) {
    await sleep(2000 + Math.random() * 1000);
    const executedPrice = this.basePrice * (0.98 + Math.random() * 0.04);
    return { txHash: generateMockTxHash(), executedPrice, dex };
  }
}
