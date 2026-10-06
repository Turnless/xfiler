export type Provider = "bstock" | "ondo" | "xstock";

// From the official binance-agentic-wallet skill: type=1 Ondo, type=2 xStocks-style, type=3 bStock.
export const PROVIDER_TYPE: Record<Provider, number> = { ondo: 1, xstock: 2, bstock: 3 };

export type Session = "regular" | "pre" | "post" | "overnight" | "weekend";
export type Side = "buy" | "sell";
export type Adapter = "baw" | "mock";
/** What the venue reports. Anything other than FINISHED / FAILED is treated as PENDING (not terminal). */
export type OrderStatus = "PENDING" | "FINISHED" | "FAILED";
/**
 * Row status. SUBMITTING is written before the swap is sent; UNKNOWN means something broke after
 * the order may have been sent (swap timeout, poll errors, Ctrl-C). Both, and PENDING, are
 * unresolved: they count as exposure and block new live orders until `reconcile` resolves them.
 */
export type RowStatus = OrderStatus | "SUBMITTING" | "UNKNOWN" | "DRY_RUN" | "ABORTED" | "QUOTE_FAILED";
export const UNRESOLVED: readonly RowStatus[] = ["SUBMITTING", "PENDING", "UNKNOWN"];

export interface RwaToken {
  chainId: string;
  contractAddress: string;
  symbol: string;
  ticker: string;
  type: number;
  multiplier: string;
}

export interface Quote {
  fromSymbol: string;
  fromAmount: string;
  toSymbol: string;
  toAmount: string;
  slippage: number | null;
  raw: unknown;
}

export interface OrderState {
  orderId: string;
  status: OrderStatus;
  txHash: string | null;
  raw: unknown;
}

/**
 * One row of the published tape. The file is append-only: a live order writes a SUBMITTING row,
 * then later rows with the same `id` (PENDING with the orderId, then terminal, then any
 * `reconcile` correction). Readers take the LAST row per id (see `latestById`).
 */
export interface FillRecord {
  id: string;
  ts: string; // ISO time the attempt started (UTC)
  adapter: Adapter; // only "baw" rows are real; mock rows are ignored by stats, table and gates
  provider: Provider;
  symbol: string;
  ticker: string;
  tokenAddress: string;
  side: Side;
  session: Session;
  dryRun: boolean;
  usdNotional: number; // size in USD terms (USDT assumed = $1); sells: the quoted USDT out
  fromQty: string; // amount sent: buy = USDT, sell = stock tokens
  multiplier: string | null; // the provider's token multiplier from the token list
  quoteToAmount: string | null;
  quoteSlippage: number | null; // slippage field of the quote itself, as returned (assumed a fraction)
  quotePrice: number | null; // USD per stock token implied by the quote
  fillAmount: string | null; // actual amount received, decoded from the tx receipt
  fillPrice: number | null;
  slippageBps: number | null; // positive = worse than quote
  quoteLatencyMs: number | null;
  submitLatencyMs: number | null;
  settleLatencyMs: number | null; // submit -> terminal status
  orderId: string | null;
  txHash: string | null;
  status: RowStatus;
  route: string | null; // only filled if the API exposes it; null otherwise
  error: string | null;
  gasUsed?: string; // from the receipt, when it was read
  effectiveGasPrice?: string; // wei, from the receipt
  reconciledAt?: string; // set on rows appended by `reconcile`

  // Wallet balance snapshots (`baw wallet balance`), best-effort, live orders only.
  balancesBefore?: BalanceSnapshot | null;
  balancesAfter?: BalanceSnapshot | null;
  balanceError?: string; // why a snapshot is missing; a snapshot never blocks an order
  usdtDelta?: string; // after - before, includes any fee taken in USDT
  bnbDelta?: string; // after - before; negative = gas paid in BNB
  fillSource?: "receipt" | "balance"; // where fillAmount came from
  receiptError?: string; // receipt problem when the balance delta was used instead
  fillMismatchError?: string; // receipt and balance deltas disagree beyond tolerance (receipt kept)

  // Provider market status (securities-info API), best-effort, never gates an order.
  marketStatus?: "open" | "closed" | null; // overall provider market
  marketReason?: string | null; // reasonCode[: reasonMsg]
  assetStatus?: string | null; // per-asset marketStatus, as returned
  assetReason?: string | null; // reasonCode[: reasonMsg], e.g. "ASSET_PAUSED: cash_dividend"
  providerSession?: ProviderSession | null; // assetStatus if it is one of the documented values
  marketError?: string | null; // why any of the above is null
  referencePrice?: number | null; // per share: tokenInfo.price / sharesMultiplier
  referenceMultiplier?: string | null; // the sharesMultiplier used, so per-token = referencePrice * it
}

/** Compact balances: only the tokens an order touches, plus BNB for gas. Missing = hidden (< $0.01) or zero. */
export interface BalanceSnapshot {
  usdt?: string;
  token?: string;
  bnb?: string;
}

// Documented values of `marketStatus` in the Asset Market Status API.
export const PROVIDER_SESSIONS = ["premarket", "regular", "postmarket", "overnight", "closed", "pause"] as const;
export type ProviderSession = (typeof PROVIDER_SESSIONS)[number];
