import { ledger } from "./store.js";
import { UNRESOLVED, type FillRecord, type Provider, type ProviderSession, type Session, type Side } from "./types.js";

export interface StatsFilter {
  provider?: Provider;
  symbol?: string;
  session?: Session; // New York clock label
  providerSession?: ProviderSession; // the provider's own session label at quote time
  side?: Side;
}

export type StatsMode = "fills" | "quotes";

/** Quote-only view, for when no live fill happened: what the venue quoted, how fast, how often it failed. */
export interface QuoteStats {
  mode: "quotes";
  filter: StatsFilter;
  quotes: number; // quote attempts (usable + failed)
  usable: number;
  quoteFailures: number;
  quoteLatencyMs: { median: number | null; p95: number | null };
  quoteFailureReasons: Record<string, number>;
  // quote price vs the provider's reference price (same token units), positive = worse for the trader
  vsReferenceBps: { n: number; median: number | null; p95: number | null; worst: number | null };
  note: string;
}

export interface FillStats {
  mode: "fills";
  filter: StatsFilter;
  attempts: number;
  filled: number;
  failed: number;
  pending: number; // SUBMITTING / PENDING / UNKNOWN: outcome not known yet
  quoteFailures: number; // quotes that came back unusable (no order was sent)
  successRate: number | null;
  slippageBps: { median: number | null; p95: number | null; worst: number | null };
  settleLatencyMs: { median: number | null; p95: number | null };
  quoteLatencyMs: { median: number | null };
  failureReasons: Record<string, number>;
  txHashes: string[]; // last 50 filled
  note: string;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)] ?? null;
}

const nums = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null);

// Raw error text stays in the row; stats group by these short, stable codes (first match wins).
const CODES: Array<[RegExp, string]> = [
  [/^INTERRUPTED/, "INTERRUPTED"],
  [/^manual/i, "MANUAL"],
  [/^receipt decode failed/, "RECEIPT_DECODE_FAILED"],
  [/still PENDING/, "POLL_TIMEOUT"],
  [/slippage/i, "SLIPPAGE"],
  [/insufficient|balance/i, "INSUFFICIENT_BALANCE"],
  [/timed out|timeout|ETIMEDOUT/i, "TIMEOUT"],
  [/^swap rejected/, "SWAP_REJECTED"],
  [/^swap outcome unknown/, "SWAP_UNKNOWN"],
  [/^poll failed/, "POLL_ERROR"],
  [/^order FAILED/, "VENUE_FAILED"],
];

export function failureCode(error: string | null, status: string): string {
  if (!error) return status === "FAILED" ? "VENUE_FAILED" : status;
  return CODES.find(([re]) => re.test(error))?.[1] ?? "OTHER";
}

const matches = (filter: StatsFilter) => (r: FillRecord) =>
  (!filter.provider || r.provider === filter.provider) &&
  (!filter.symbol || r.symbol.toLowerCase() === filter.symbol.toLowerCase()) &&
  (!filter.session || r.session === filter.session) &&
  (!filter.providerSession || r.providerSession === filter.providerSession) &&
  (!filter.side || r.side === filter.side);

/** Quote price vs reference, bps, positive = worse for the trader. Null without a reference on the row. */
export function vsReferenceBps(r: FillRecord): number | null {
  const ref = r.referencePrice != null && r.referenceMultiplier ? r.referencePrice * Number(r.referenceMultiplier) : NaN; // per token
  if (!(ref > 0) || !(r.quotePrice != null && r.quotePrice > 0)) return null;
  return (r.side === "buy" ? r.quotePrice / ref - 1 : ref / r.quotePrice - 1) * 1e4;
}

/**
 * `get_fill_stats`. mode "fills" (default): real (`baw`, non-dry-run) attempts, last row per id.
 * mode "quotes": quote-only rows from the real venue (no order sent), for when there are no fills.
 */
export function summarize(all: FillRecord[], filter?: StatsFilter, includeMock?: boolean, mode?: "fills"): FillStats;
export function summarize(all: FillRecord[], filter: StatsFilter, includeMock: boolean, mode: "quotes"): QuoteStats;
export function summarize(all: FillRecord[], filter?: StatsFilter, includeMock?: boolean, mode?: StatsMode): FillStats | QuoteStats;
export function summarize(all: FillRecord[], filter: StatsFilter = {}, includeMock = false, mode: StatsMode = "fills"): FillStats | QuoteStats {
  return mode === "quotes" ? summarizeQuotes(all, filter, includeMock) : summarizeFills(all, filter, includeMock);
}

function summarizeQuotes(all: FillRecord[], filter: StatsFilter, includeMock: boolean): QuoteStats {
  // A dry-run row with a quote is a quote sample, even if a gate (not the quote) made it ABORTED.
  const rows = ledger(all, includeMock)
    .filter(matches(filter))
    .filter((r) => r.dryRun && (r.status === "DRY_RUN" || r.status === "QUOTE_FAILED" || (r.status === "ABORTED" && r.quotePrice !== null)));
  const failed = rows.filter((r) => r.status === "QUOTE_FAILED");
  const usable = rows.filter((r) => r.status !== "QUOTE_FAILED");
  const reasons: Record<string, number> = {};
  for (const r of failed) {
    const k = (r.error ?? "QUOTE_FAILED").split(":")[0]!.trim();
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const lat = nums(rows.map((r) => r.quoteLatencyMs));
  const ref = nums(usable.map(vsReferenceBps));
  return {
    mode: "quotes",
    filter,
    quotes: rows.length,
    usable: usable.length,
    quoteFailures: failed.length,
    quoteLatencyMs: { median: percentile(lat, 50), p95: percentile(lat, 95) },
    quoteFailureReasons: reasons,
    vsReferenceBps: { n: ref.length, median: percentile(ref, 50), p95: percentile(ref, 95), worst: ref.length ? Math.max(...ref) : null },
    note:
      "Quote-only: no order was sent and no fill occurred for these rows; this is what the venue quoted, not what it executed." +
      (rows.length < 20 ? " With fewer than 20 quotes, p95 is the maximum observed value." : "") +
      (ref.length < usable.length ? ` ${usable.length - ref.length} quote(s) had no reference price.` : ""),
  };
}

function summarizeFills(all: FillRecord[], filter: StatsFilter, includeMock: boolean): FillStats {
  const tape = ledger(all, includeMock).filter(matches(filter));
  const rows = tape.filter((r) => !r.dryRun && r.status !== "ABORTED");
  const filled = rows.filter((r) => r.status === "FINISHED");
  const failed = rows.filter((r) => r.status === "FAILED");
  const pending = rows.filter((r) => UNRESOLVED.includes(r.status));
  const reasons: Record<string, number> = {};
  for (const r of [...failed, ...pending]) {
    const k = failureCode(r.error, r.status);
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const slip = nums(filled.map((r) => r.slippageBps));
  const notes = [
    rows.length < 5
      ? "Fewer than 5 real attempts for this filter: treat as anecdote, not a distribution."
      : "Measured from real BSC mainnet micro-fills; sizes are small, so slippage at larger sizes will differ.",
  ];
  if (filled.length < 20) notes.push("With fewer than 20 fills, p95 is the maximum observed value.");
  if (pending.length) notes.push(`${pending.length} order(s) unresolved (pending): outcome not known yet.`);
  if (!rows.length) notes.push('No real fills for this filter: mode "quotes" shows quote-only data.');
  return {
    mode: "fills",
    filter,
    attempts: rows.length,
    filled: filled.length,
    failed: failed.length,
    pending: pending.length,
    quoteFailures: tape.filter((r) => r.status === "QUOTE_FAILED").length,
    successRate: rows.length ? filled.length / rows.length : null,
    slippageBps: {
      median: percentile(slip, 50),
      p95: percentile(slip, 95),
      worst: slip.length ? Math.max(...slip) : null,
    },
    settleLatencyMs: {
      median: percentile(nums(filled.map((r) => r.settleLatencyMs)), 50),
      p95: percentile(nums(filled.map((r) => r.settleLatencyMs)), 95),
    },
    quoteLatencyMs: { median: percentile(nums(rows.map((r) => r.quoteLatencyMs)), 50) },
    failureReasons: reasons,
    txHashes: filled.map((r) => r.txHash).filter((h): h is string => !!h).slice(-50),
    note: notes.join(" "),
  };
}
