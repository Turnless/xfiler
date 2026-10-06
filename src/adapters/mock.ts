import { BSC_BNB, BSC_USDT } from "../config.js";
import type { OrderState, Quote } from "../types.js";
import type { Executor, SwapArgs } from "./types.js";

/** Deterministic fake venue for tests and offline demos. Its rows are tagged `adapter: "mock"` and never published. */
export class MockExecutor implements Executor {
  readonly name = "mock" as const;
  private orders = new Map<string, { polls: number; fail: boolean; args: SwapArgs; settled: boolean }>();
  /** Fake wallet, lower-cased address -> amount. Updated when an order finishes. */
  private wallet = new Map<string, number>([[BSC_USDT.toLowerCase(), 100], [BSC_BNB.toLowerCase(), 0.05]]);
  constructor(
    // gasBnb: BNB each settled order "pays" (default 0, a gasless fake)
    private opts: { price?: number; failEvery?: number; slippageBps?: number; gasBnb?: number } = {},
  ) {}

  private n = 0;
  private isBuy = (a: SwapArgs) => a.fromToken.toLowerCase() === BSC_USDT.toLowerCase();
  private out(a: SwapArgs): number {
    const price = this.opts.price ?? 100;
    // buy: USDT in, tokens out; sell: qty tokens in, qty * price USDT out
    return this.isBuy(a) ? Number(a.fromQty) / price : Number(a.fromQty) * price;
  }

  async quote(a: SwapArgs): Promise<Quote> {
    const buy = this.isBuy(a);
    return {
      fromSymbol: buy ? "USDT" : "MOCK",
      fromAmount: a.fromQty,
      toSymbol: buy ? "MOCK" : "USDT",
      toAmount: this.out(a).toFixed(8),
      slippage: 0.005,
      raw: { mock: true },
    };
  }
  async swap(a: SwapArgs) {
    const orderId = `mock-${++this.n}`;
    const fail = !!this.opts.failEvery && this.n % this.opts.failEvery === 0;
    this.orders.set(orderId, { polls: 0, fail, args: a, settled: false });
    return { orderId, raw: { mock: true } };
  }
  async order(orderId: string): Promise<OrderState> {
    const o = this.orders.get(orderId)!;
    o.polls += 1;
    if (o.polls < 2) return { orderId, status: "PENDING", txHash: null, raw: {} };
    if (!o.settled) {
      o.settled = true;
      const add = (t: string, v: number) => this.wallet.set(t.toLowerCase(), (this.wallet.get(t.toLowerCase()) ?? 0) + v);
      add(BSC_BNB, -(this.opts.gasBnb ?? 0));
      if (!o.fail) {
        add(o.args.fromToken, -Number(o.args.fromQty));
        add(o.args.toToken, this.out(o.args) * (1 - (this.opts.slippageBps ?? 0) / 1e4));
      }
    }
    return o.fail
      ? { orderId, status: "FAILED", txHash: null, raw: {} }
      : { orderId, status: "FINISHED", txHash: "0x" + orderId.padEnd(64, "0").replace(/[^0-9a-f]/g, "a"), raw: {} };
  }
  async balances(tokens: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(tokens.map((t) => [t.toLowerCase(), (this.wallet.get(t.toLowerCase()) ?? 0).toFixed(8)]));
  }
}
