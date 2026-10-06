import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, from this file's location: .env, KILL and DATA_DIR never depend on the cwd. */
export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line);
    // `KEY="value"` and `KEY='value'` mean the value without the quotes
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
}

const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return process.env[k] && Number.isFinite(v) ? v : d;
};

export interface Config {
  live: boolean;
  maxUsdPerFill: number;
  maxOpenUsd: number;
  maxFillsPerDay: number;
  cooldownSeconds: number;
  budgetUsd: number;
  killSwitchFailClosed: boolean;
  killFile: string;
  adapter: "baw" | "mock";
  bawBin: string;
  bscRpcUrl: string;
  walletAddress: string;
  slippage: string; // percent, sent to `baw --slippage`
  maxQuoteSlippage: number; // fraction: abort if the quote's own slippage is above this
  bnbUsd: number; // only used to price gas into the loss budget; 0 = gas not counted
  dataDir: string;
}

/** Max SLIPPAGE (percent) accepted at all. A $3 order should never be sent with more. */
export const SLIPPAGE_CEILING = 3;

export function loadConfig(envFile = join(PROJECT_ROOT, ".env")): Config {
  loadDotEnv(envFile);
  const e = process.env;
  const slippage = e.SLIPPAGE || "1";
  const s = Number(slippage);
  if (!Number.isFinite(s) || s <= 0 || s > SLIPPAGE_CEILING) {
    throw new Error(`SLIPPAGE must be a percent in (0, ${SLIPPAGE_CEILING}], e.g. 1 for 1%; got "${slippage}"`);
  }
  return {
    live: e.LIVE === "1",
    maxUsdPerFill: num("MAX_USD_PER_FILL", 5),
    maxOpenUsd: num("MAX_OPEN_USD", 8),
    maxFillsPerDay: num("MAX_FILLS_PER_DAY", 12),
    cooldownSeconds: num("COOLDOWN_SECONDS", 20),
    budgetUsd: num("BUDGET_USD", 3),
    killSwitchFailClosed: e.KILL_SWITCH_FAIL_CLOSED !== "false",
    killFile: join(PROJECT_ROOT, "KILL"),
    adapter: e.ADAPTER === "mock" ? "mock" : "baw",
    bawBin: e.BAW_BIN || "baw",
    bscRpcUrl: e.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org",
    walletAddress: e.WALLET_ADDRESS || "",
    slippage,
    maxQuoteSlippage: num("MAX_QUOTE_SLIPPAGE", 0.01),
    bnbUsd: num("BNB_USD", 0),
    dataDir: resolve(PROJECT_ROOT, e.DATA_DIR || "data"),
  };
}

// Verified from the official binance-agentic-wallet skill (Common Token Addresses, BSC).
export const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
export const BSC_CHAIN_ID = "56";
// Native BNB as the wallet APIs name it (same skill, Common Token Addresses).
export const BSC_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
