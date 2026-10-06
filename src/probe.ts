import { randomUUID } from "node:crypto";
import { formatUnits, parseUnits } from "viem";
import { NO_MARKET, type MarketInfo } from "./adapters/market.js";
import { NotSent, VenueRejected, type Executor } from "./adapters/types.js";
import type { ReceiptFill } from "./chain.js";
import { BSC_BNB, BSC_USDT, type Config } from "./config.js";
import { checkGates } from "./guards.js";
import { usSession } from "./session.js";
import { appendJsonl, fillsPath, floor8, readFills, saveRawSample } from "./store.js";
import type { BalanceSnapshot, FillRecord, OrderState, Quote, RwaToken, Side } from "./types.js";
import { PROVIDER_TYPE, type Provider } from "./types.js";

/** Reads the fill from the receipt: net `receivedToken` into the wallet; `spentToken`, if given, must leave it. */
export type ReceiptReader = (txHash: string, receivedToken: string, spentToken: string | null) => Promise<ReceiptFill>;

export interface AttemptInput {
  cfg: Config;
  exec: Executor;
  token: RwaToken;
  provider: Provider;
  side: Side;
  /** buy: USDT to spend. sell: stock-token quantity to sell. Plain decimal string. */
  qty: string;
  /** buy: USD size for caps and the table (= qty). sell: an estimate, replaced by the quoted USDT out. */
  usd: number;
  liveFlag: boolean;
  readReceipt: ReceiptReader;
  now?: () => Date;
  pollEveryMs?: number;
  pollTimeoutMs?: number;
  allowMock?: boolean; // tests only: let the mock venue through the live gates
  /** Provider market status lookup (the CLI passes `lookupMarket`); best-effort, never gates. Omitted = not looked up. */
  market?: (token: RwaToken) => Promise<MarketInfo>;
  marketTimeoutMs?: number; // default 8 s
  balanceTimeoutMs?: number; // per snapshot, default 20 s
  balanceRetries?: number; // extra after-snapshots while the balance has not moved yet, default 3
  balanceRetryMs?: number; // default 2 s
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 400);
const MAX_POLL_ERRORS = 20; // consecutive; the deadline usually ends it first
/** Receipt vs balance delta of the received token may differ by this fraction before it is flagged. */
export const BALANCE_TOLERANCE = 0.01;

/** Resolve within `ms` or reject: nothing optional may hold an order up for long. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))),
  ]);
}

/** after - before, exact (18-decimal fixed point); null if either side is missing or not a plain number. */
export function delta(before: string | undefined, after: string | undefined): string | null {
  if (before === undefined || after === undefined) return null;
  try {
    return formatUnits(parseUnits(after, 18) - parseUnits(before, 18), 18);
  } catch {
    return null;
  }
}

/** Best-effort compact snapshot. Failure is noted on the row and returns null; it never throws. */
async function snapshot(i: AttemptInput, rec: FillRecord, when: "before" | "after"): Promise<BalanceSnapshot | null> {
  if (!i.exec.balances) return null;
  const keys = { usdt: BSC_USDT, token: i.token.contractAddress, bnb: BSC_BNB };
  try {
    const b = await within(i.exec.balances(Object.values(keys)), i.balanceTimeoutMs ?? 20_000, "balance snapshot");
    const get = (a: string) => b[a.toLowerCase()];
    return { usdt: get(keys.usdt), token: get(keys.token), bnb: get(keys.bnb) };
  } catch (err) {
    rec.balanceError = [rec.balanceError, `${when}: ${msg(err).slice(0, 150)}`].filter(Boolean).join("; ");
    return null;
  }
}

/**
 * One attempt = quote -> (gates) -> SUBMITTING row -> swap -> poll to terminal -> decode receipt -> terminal row.
 * Failures are recorded, not thrown: a failed order is a data point on the tape. A live order is on
 * disk before it is sent, so a crash leaves an unresolved row for `reconcile`, never a lost order.
 */
export async function runAttempt(i: AttemptInput): Promise<FillRecord> {
  const now = i.now ?? (() => new Date());
  const startedAt = now();
  const [from, to] =
    i.side === "buy" ? [BSC_USDT, i.token.contractAddress] : [i.token.contractAddress, BSC_USDT];
  const swapArgs = { fromToken: from, toToken: to, fromQty: i.qty, slippage: i.cfg.slippage };

  const rec: FillRecord = {
    id: randomUUID(),
    ts: startedAt.toISOString(),
    adapter: i.exec.name,
    provider: i.provider,
    symbol: i.token.symbol,
    ticker: i.token.ticker,
    tokenAddress: i.token.contractAddress,
    side: i.side,
    session: usSession(startedAt),
    dryRun: true,
    usdNotional: i.usd,
    fromQty: i.qty,
    multiplier: i.token.multiplier ?? null,
    quoteToAmount: null,
    quoteSlippage: null,
    quotePrice: null,
    fillAmount: null,
    fillPrice: null,
    slippageBps: null,
    quoteLatencyMs: null,
    submitLatencyMs: null,
    settleLatencyMs: null,
    orderId: null,
    txHash: null,
    status: "DRY_RUN",
    route: null,
    error: null,
  };

  const save = () => appendJsonl(fillsPath(i.cfg.dataDir), { ...rec });
  const quoteFailed = (code: string) => {
    rec.status = "QUOTE_FAILED";
    rec.error = code;
    save();
    return rec;
  };
  // Raw response shapes are evidence: keep the first of each kind from the real venue only.
  const sample = (kind: "quote" | "swap" | "list", raw: unknown) => {
    if (i.exec.name === "baw") saveRawSample(i.cfg.dataDir, i.provider, i.side, kind, raw);
  };

  // 0. Provider market status, in parallel with the quote. Best-effort: it never gates or aborts.
  const marketP: Promise<MarketInfo> = i.market
    ? within(i.market(i.token), i.marketTimeoutMs ?? 8_000, "market status").catch((err) => NO_MARKET(msg(err).slice(0, 150)))
    : Promise.resolve(NO_MARKET("not looked up"));

  // 1. Quote. An unusable quote stops here, before the gates, and is still recorded.
  let q: Quote;
  try {
    const t0 = Date.now();
    q = await i.exec.quote(swapArgs);
    rec.quoteLatencyMs = Date.now() - t0;
  } catch (err) {
    Object.assign(rec, await marketP);
    return quoteFailed(`QUOTE_ERROR: ${msg(err)}`);
  }
  Object.assign(rec, await marketP);
  sample("quote", q.raw);
  rec.quoteToAmount = q.toAmount ?? null;
  rec.quoteSlippage = q.slippage ?? null;
  const routeField = (q.raw as { route?: unknown } | null)?.route;
  rec.route = routeField ? JSON.stringify(routeField) : null;
  const toAmount = Number(q.toAmount);
  if (!(Number.isFinite(toAmount) && toAmount > 0)) return quoteFailed("QUOTE_NO_AMOUNT");
  if (rec.quoteSlippage !== null && rec.quoteSlippage > i.cfg.maxQuoteSlippage) {
    return quoteFailed(`QUOTE_SLIPPAGE_HIGH: ${rec.quoteSlippage} > ${i.cfg.maxQuoteSlippage}`);
  }
  const stockQty = i.side === "buy" ? toAmount : Number(i.qty);
  const usdLeg = i.side === "buy" ? Number(i.qty) : toAmount;
  rec.quotePrice = stockQty > 0 ? usdLeg / stockQty : null;
  if (i.side === "sell") rec.usdNotional = toAmount;

  // 2. Gates. If the ledger cannot be read, fail closed.
  let failed: string[];
  try {
    failed = checkGates({
      cfg: i.cfg, liveFlag: i.liveFlag, usd: rec.usdNotional, side: i.side, history: readFills(i.cfg.dataDir),
      now: startedAt, qty: i.qty, tokenAddress: i.token.contractAddress, adapter: i.exec.name, allowMock: i.allowMock,
    });
  } catch (err) {
    failed = [`GATE_ERROR: ${msg(err)}`];
  }
  if (failed.length) {
    rec.status = failed.includes("DRY_RUN") && failed.length === 1 ? "DRY_RUN" : "ABORTED";
    rec.error = failed.join(",");
    save();
    return rec;
  }

  // 3. Live. Balance snapshot first (best-effort), then the SUBMITTING row is on disk before anything is sent.
  rec.balancesBefore = await snapshot(i, rec, "before");
  rec.dryRun = false;
  rec.status = "SUBMITTING";
  save();
  const onSigint = () => {
    rec.status = "UNKNOWN";
    rec.error = "INTERRUPTED: SIGINT after submit started; run `reconcile`";
    save();
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    await submitAndSettle(i, rec, swapArgs, save, sample);
  } catch (err) {
    rec.status = "UNKNOWN"; // unexpected local error after submission started
    rec.error = `local error after submit: ${msg(err)}`;
  } finally {
    process.off("SIGINT", onSigint);
  }
  save();
  return rec;
}

async function submitAndSettle(
  i: AttemptInput,
  rec: FillRecord,
  swapArgs: { fromToken: string; toToken: string; fromQty: string; slippage: string },
  save: () => void,
  sample: (kind: "swap" | "list", raw: unknown) => void,
): Promise<void> {
  const t1 = Date.now();
  let orderId: string;
  try {
    const res = await i.exec.swap(swapArgs);
    orderId = res.orderId;
    sample("swap", res.raw);
  } catch (err) {
    rec.submitLatencyMs = Date.now() - t1;
    if (err instanceof VenueRejected) {
      rec.status = "FAILED";
      rec.error = `swap rejected: ${msg(err)}`;
    } else if (err instanceof NotSent) {
      rec.status = "ABORTED";
      rec.dryRun = true;
      rec.error = `not sent: ${msg(err)}`;
    } else {
      rec.status = "UNKNOWN"; // timeout, crash, unreadable answer: the order may exist
      rec.error = `swap outcome unknown: ${msg(err)}`;
    }
    return;
  }
  rec.submitLatencyMs = Date.now() - t1;
  rec.orderId = orderId;
  rec.status = "PENDING";
  save(); // orderId on disk: `reconcile` can find it even if we die while polling

  // Poll until FINISHED / FAILED. Errors are retried with short backoff until the deadline.
  const deadline = Date.now() + (i.pollTimeoutMs ?? 120_000);
  const every = i.pollEveryMs ?? 2_000;
  let state: OrderState | null = null;
  let pollErr: string | null = null;
  let errors = 0;
  for (;;) {
    try {
      state = await i.exec.order(orderId);
      pollErr = null;
      errors = 0;
    } catch (err) {
      pollErr = msg(err);
      errors += 1;
    }
    if (!pollErr && state && state.status !== "PENDING") break;
    if (Date.now() >= deadline || errors >= MAX_POLL_ERRORS) break;
    const wait = errors ? Math.min(every * 2 ** errors, 10_000) : every;
    await sleep(Math.max(0, Math.min(wait, deadline - Date.now())));
  }
  rec.settleLatencyMs = Date.now() - t1;

  if (pollErr) {
    rec.status = "UNKNOWN";
    rec.error = `poll failed: ${pollErr}`;
    return;
  }
  if (!state || state.status === "PENDING") {
    rec.status = "PENDING";
    rec.error = "still PENDING at poll timeout";
    return;
  }
  sample("list", state.raw);

  // After-snapshot. Balances can lag the chain: on FINISHED, retry briefly until the received token moves.
  if (rec.balancesBefore) {
    const key = rec.side === "buy" ? "token" : "usdt";
    for (let n = 0; ; n++) {
      rec.balancesAfter = await snapshot(i, rec, "after");
      const moved = Number(delta(rec.balancesBefore[key], rec.balancesAfter?.[key])) > 0;
      if (state.status !== "FINISHED" || moved || n >= (i.balanceRetries ?? 3)) break;
      await sleep(i.balanceRetryMs ?? 2_000);
    }
    rec.usdtDelta = delta(rec.balancesBefore.usdt, rec.balancesAfter?.usdt) ?? undefined;
    rec.bnbDelta = delta(rec.balancesBefore.bnb, rec.balancesAfter?.bnb) ?? undefined;
  }
  await applyState(rec, state, i.readReceipt);
}

/**
 * Apply a terminal venue state to a row. A FINISHED order stays FINISHED even when the receipt
 * cannot be read or decoded: that is our trouble, not the venue's, and it goes in `error`.
 */
export async function applyState(rec: FillRecord, state: OrderState, readReceipt: ReceiptReader): Promise<void> {
  rec.status = state.status;
  rec.txHash = state.txHash;
  if (state.status === "FAILED") rec.error = rec.error ?? "order FAILED (txHash may be null)";
  if (state.status !== "FINISHED") return;

  // Balance delta of the token we should have received: the fallback, and the cross-check.
  const key = rec.side === "buy" ? "token" : "usdt";
  const bal = rec.balancesBefore && rec.balancesAfter ? delta(rec.balancesBefore[key], rec.balancesAfter[key]) : null;
  const balOk = bal !== null && Number(bal) > 0;

  let receiptErr: string | null = null;
  let fill: ReceiptFill | null = null;
  if (!state.txHash) receiptErr = "venue gave no txHash";
  else {
    const receivedToken = rec.side === "buy" ? rec.tokenAddress : BSC_USDT;
    const spentToken = rec.side === "buy" ? BSC_USDT : null; // proves WALLET_ADDRESS is the wallet that paid
    try {
      fill = await readReceipt(state.txHash, receivedToken, spentToken);
      if (fill.gasUsed) rec.gasUsed = fill.gasUsed;
      if (fill.effectiveGasPrice) rec.effectiveGasPrice = fill.effectiveGasPrice;
      if (!(Number(fill.amount) > 0)) receiptErr = `decoded amount ${fill.amount}`;
    } catch (err) {
      receiptErr = msg(err);
    }
  }

  let amount: string;
  if (!receiptErr && fill) {
    amount = fill.amount;
    rec.fillSource = "receipt";
    // Disagreement is flagged, not resolved: the receipt stays the fill, the balance delta stays in the snapshots.
    if (bal !== null && Math.abs(Number(bal) - Number(amount)) > BALANCE_TOLERANCE * Number(amount)) {
      rec.fillMismatchError = `receipt ${amount} vs balance delta ${bal} (> ${BALANCE_TOLERANCE * 100}%)`;
    }
  } else if (balOk) {
    amount = bal!;
    rec.fillSource = "balance";
    rec.receiptError = `receipt decode failed: ${receiptErr}`;
  } else {
    rec.error = `receipt decode failed: ${receiptErr}`;
    return;
  }
  const got = Number(amount);
  rec.error = null;
  rec.fillAmount = amount;
  const stock = rec.side === "buy" ? got : Number(rec.fromQty);
  const usdFilled = rec.side === "buy" ? Number(rec.fromQty) : got;
  rec.fillPrice = stock > 0 ? usdFilled / stock : null;
  if (rec.fillPrice && rec.quotePrice) {
    // positive = worse than quote for the trader
    rec.slippageBps =
      rec.side === "buy"
        ? (rec.fillPrice / rec.quotePrice - 1) * 1e4
        : (rec.quotePrice / rec.fillPrice - 1) * 1e4;
  }
}

/**
 * Re-poll one unresolved row. Returns the corrected row to append, or null if the venue still
 * says PENDING. Throws if the poll itself fails (the caller reports it and leaves the row as is).
 */
export async function reconcileRow(row: FillRecord, exec: Executor, readReceipt: ReceiptReader): Promise<FillRecord | null> {
  if (!row.orderId) return null;
  const state = await exec.order(row.orderId);
  if (state.status === "PENDING") return null;
  const rec: FillRecord = { ...row, error: null, reconciledAt: new Date().toISOString() };
  await applyState(rec, state, readReceipt);
  return rec;
}

/** Quantity for the round-trip sell after a buy, rounded down to 8 decimals; null if there is nothing to sell. */
export function sellQtyAfterBuy(buy: FillRecord): string | null {
  if (buy.status !== "FINISHED" || !buy.fillAmount || !(Number(buy.fillAmount) > 0)) return null;
  try {
    const q = floor8(buy.fillAmount);
    return Number(q) > 0 ? q : null;
  } catch {
    return null; // not a plain decimal: do not guess a quantity
  }
}

export function describeProviders(): string {
  return Object.entries(PROVIDER_TYPE)
    .map(([p, t]) => `${p} (type=${t})`)
    .join(", ");
}
