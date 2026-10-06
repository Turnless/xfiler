import type { Adapter, OrderState, Quote } from "../types.js";

export interface SwapArgs {
  fromToken: string;
  toToken: string;
  fromQty: string; // human-readable units, plain decimal (never exponent notation)
  slippage: string; // percent, e.g. "1" = 1%
}

/** The venue boundary. `baw` talks to the real Agentic Wallet; `mock` makes tests and dry demos possible. */
export interface Executor {
  readonly name: Adapter;
  quote(a: SwapArgs): Promise<Quote>;
  swap(a: SwapArgs): Promise<{ orderId: string; raw: unknown }>;
  order(orderId: string): Promise<OrderState>;
  /**
   * Wallet balances on BSC for the given token addresses (lower-cased keys, human units).
   * A token the venue does not list is "0" (baw hides balances under $0.01). Optional, best-effort.
   */
  balances?(tokens: string[]): Promise<Record<string, string>>;
}

/** The venue answered and said no: the order was not accepted. Recorded as FAILED. */
export class VenueRejected extends Error {}

/** Refused locally before anything reached the venue. Recorded as ABORTED (nothing sent). */
export class NotSent extends Error {}

// Any other error thrown by swap() means the outcome is unknown (timeout, crash, unreadable
// output, missing orderId): the order may exist, so the row is recorded as UNKNOWN.
