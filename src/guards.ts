import { statSync } from "node:fs";
import { formatUnits, parseUnits } from "viem";
import type { Config } from "./config.js";
import { latestById, ledger } from "./store.js";
import { UNRESOLVED, type Adapter, type FillRecord } from "./types.js";

/**
 * Pre-trade gates, ported in spirit from Cinder's runPreTradeChecks():
 * dry-run default, per-trade cap, exposure cap, daily count, cooldown, loss budget,
 * unresolved orders, kill-switch (fail-closed). Returns the failed gates; empty means the order may go.
 * A sell that closes a position the ledger knows about only faces dry-run, kill-switch,
 * mock-adapter and unresolved-order gates: getting out must never be blocked by the caps.
 */
export interface GateInput {
  cfg: Config;
  liveFlag: boolean; // `--live` on the CLI
  usd: number;
  side: "buy" | "sell";
  history: FillRecord[]; // all prior rows, raw (several per id is fine)
  now: Date;
  killFile?: string; // defaults to cfg.killFile
  qty?: string; // sell: token quantity, for the closing-sell exemption
  tokenAddress?: string; // sell: which position it closes
  adapter?: Adapter; // the executor in use; defaults to "baw"
  allowMock?: boolean; // tests only: let the mock venue pass and read mock rows as the ledger
}

const TRUTHY = /^(1|true|yes)$/i;
const fileExists = (p: string) => statSync(p, { throwIfNoEntry: false }) !== undefined;

/**
 * KILL_SWITCH=1/true/yes, or a KILL file, stops new live orders. If the file check itself fails
 * (e.g. permission error) the answer is `killSwitchFailClosed` (default true: treated as active).
 * It is checked once, before each order: it cannot recall an order already sent.
 */
export function isKillSwitchActive(cfg: Config, killFile = cfg.killFile, exists: (p: string) => boolean = fileExists): boolean {
  if (TRUTHY.test(process.env.KILL_SWITCH ?? "")) return true;
  try {
    return exists(killFile);
  } catch {
    return cfg.killSwitchFailClosed; // can't tell: fail closed, as in Cinder
  }
}

/** Validate a CLI amount (`--usd`, `--qty`): finite and > 0, so NaN, "", "abc" and negatives all fail. */
export function parsePositive(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n) || !(n > 0)) {
    throw new Error(`${flag} must be a number > 0, got "${raw ?? ""}"`);
  }
  return n;
}

const units = (s: string | null | undefined): bigint => {
  try {
    return s ? parseUnits(s, 18) : 0n;
  } catch {
    return 0n;
  }
};
const ratio = (a: bigint, b: bigint) => (b > 0n ? Number((a * 1_000_000n) / b) / 1e6 : 0);

interface Position {
  boughtQty: bigint; // tokens received by finished buys with a decoded fill
  boughtUsd: number; // USDT spent on those buys
  driftUsd: number; // their quote-to-fill drift, USD
  soldQty: bigint; // tokens sent by finished sells
  soldUsd: number; // USDT received by those sells (undecoded = 0, which overstates the loss)
}

/** Per-token positions from the live rows of a ledger (last row per id). */
function positions(rows: FillRecord[]): Map<string, Position> {
  const out = new Map<string, Position>();
  for (const r of latestById(rows)) {
    if (r.dryRun || r.status !== "FINISHED") continue;
    const k = r.tokenAddress.toLowerCase();
    const p = out.get(k) ?? { boughtQty: 0n, boughtUsd: 0, driftUsd: 0, soldQty: 0n, soldUsd: 0 };
    // With a balance snapshot, the USDT delta includes fees; take whichever source is worse for us.
    const usdtDelta = Number(r.usdtDelta);
    if (r.side === "buy" && r.fillAmount) {
      p.boughtQty += units(r.fillAmount);
      p.boughtUsd += Math.max(r.usdNotional, usdtDelta < 0 ? -usdtDelta : 0);
      p.driftUsd += Math.max(0, ((r.slippageBps ?? 0) / 1e4) * r.usdNotional);
    } else if (r.side === "sell") {
      p.soldQty += units(r.fromQty);
      const received = Number(r.fillAmount) || 0;
      p.soldUsd += usdtDelta > 0 ? Math.min(received, usdtDelta) : received;
    }
    out.set(k, p);
  }
  return out;
}

/**
 * Token quantity the ledger says is still held from our own buys: finished buys minus finished
 * sells, minus sells still unresolved (they may have gone through). Plain decimal string.
 */
export function openQty(history: FillRecord[], tokenAddress: string): string {
  const rows = latestById(history);
  const p = positions(rows).get(tokenAddress.toLowerCase());
  let q = p ? p.boughtQty - p.soldQty : 0n;
  for (const r of rows) {
    if (!r.dryRun && r.side === "sell" && UNRESOLVED.includes(r.status) && r.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()) {
      q -= units(r.fromQty);
    }
  }
  return formatUnits(q > 0n ? q : 0n, 18);
}

/**
 * Net open exposure, USD, from our own ledger. Conservative: an unresolved buy (SUBMITTING,
 * PENDING, UNKNOWN) or a finished buy whose fill could not be decoded counts in full.
 */
export function openExposureUsd(history: FillRecord[]): number {
  const rows = latestById(history);
  let open = 0;
  for (const r of rows) {
    if (r.dryRun || r.side !== "buy") continue;
    if (UNRESOLVED.includes(r.status) || (r.status === "FINISHED" && !r.fillAmount)) open += r.usdNotional;
  }
  for (const p of positions(rows).values()) {
    const left = p.boughtQty - p.soldQty;
    if (left > 0n) open += p.boughtUsd * ratio(left, p.boughtQty);
  }
  return Math.max(0, open);
}

/**
 * Estimated money lost, USD: for closed buy/sell pairs, USDT spent minus USDT received (pro rata
 * by quantity; the worse of receipt and balance delta); for what is still open, the quote-to-fill
 * drift; plus gas (receipt or BNB balance drop, the larger) when BNB_USD is set.
 */
export function estimatedLossUsd(history: FillRecord[], bnbUsd = 0): number {
  const rows = latestById(history);
  let loss = 0;
  for (const p of positions(rows).values()) {
    const closed = p.soldQty < p.boughtQty ? p.soldQty : p.boughtQty;
    if (closed > 0n) loss += p.boughtUsd * ratio(closed, p.boughtQty) - p.soldUsd * ratio(closed, p.soldQty);
    loss += p.driftUsd * ratio(p.boughtQty - closed, p.boughtQty);
  }
  if (bnbUsd > 0) {
    for (const r of rows) {
      if (r.dryRun) continue;
      // Gas in BNB: from the receipt, or the wallet's BNB drop if a snapshot pair exists; the larger one.
      let receiptGas = 0;
      try {
        if (r.gasUsed && r.effectiveGasPrice) receiptGas = Number(formatUnits(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), 18));
      } catch {
        // malformed gas fields: skip, the receipt is still on chain
      }
      const bnbDrop = Number(r.bnbDelta) < 0 ? -Number(r.bnbDelta) : 0;
      loss += Math.max(receiptGas, bnbDrop) * bnbUsd;
    }
  }
  return Math.max(0, loss);
}

/** True when this sell is covered by a position the ledger knows about. */
export function closesOpenBuy(history: FillRecord[], side: "buy" | "sell", tokenAddress?: string, qty?: string): boolean {
  if (side !== "sell" || !tokenAddress || !qty) return false;
  const want = units(qty);
  return want > 0n && want <= units(openQty(history, tokenAddress));
}

export function checkGates(i: GateInput): string[] {
  const failed: string[] = [];
  const rows = ledger(i.history, i.allowMock);
  const live = rows.filter((r) => !r.dryRun);

  if (!i.liveFlag || !i.cfg.live) failed.push("DRY_RUN"); // both switches needed for a real order
  if (i.liveFlag && (i.adapter ?? "baw") === "mock" && !i.allowMock) failed.push("MOCK_ADAPTER"); // fake venue never trades live
  if (live.some((r) => UNRESOLVED.includes(r.status))) failed.push("UNRESOLVED_ORDER"); // run `reconcile` first
  if (isKillSwitchActive(i.cfg, i.killFile ?? i.cfg.killFile)) failed.push("KILL_SWITCH_ACTIVE");
  if (closesOpenBuy(rows, i.side, i.tokenAddress, i.qty)) return failed;

  if (i.usd > i.cfg.maxUsdPerFill) failed.push("PER_FILL_CAP");
  if (!(i.usd > 0)) failed.push("BAD_AMOUNT");
  if (i.side === "buy" && openExposureUsd(rows) + i.usd > i.cfg.maxOpenUsd) failed.push("OPEN_EXPOSURE_CAP");
  if (estimatedLossUsd(rows, i.cfg.bnbUsd) >= i.cfg.budgetUsd) failed.push("BUDGET_EXHAUSTED");

  const dayAgo = i.now.getTime() - 24 * 3600 * 1000;
  if (live.filter((r) => new Date(r.ts).getTime() >= dayAgo).length >= i.cfg.maxFillsPerDay) {
    failed.push("DAILY_COUNT_CAP");
  }
  const lastTs = Math.max(...live.map((r) => new Date(r.ts).getTime()));
  if (live.length && i.now.getTime() - lastTs < i.cfg.cooldownSeconds * 1000) {
    failed.push("COOLDOWN_ACTIVE");
  }
  return failed;
}
