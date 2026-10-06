import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BSC_CHAIN_ID, type Config } from "../config.js";
import { logApiCall } from "../store.js";
import type { OrderState, Quote } from "../types.js";
import { NotSent, VenueRejected, type Executor, type SwapArgs } from "./types.js";

/** Runs the CLI; injectable so tests never spawn `baw`. Rejects like execFile (err.stdout / err.stderr / err.killed). */
export type Runner = (bin: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

const execFileP = promisify(execFile);
const defaultRunner: Runner = (bin, args, timeout) =>
  execFileP(bin, args, { shell: process.platform === "win32", timeout, maxBuffer: 4 << 20, encoding: "utf8" });

// Arguments reach a shell on Windows (baw is an npm .cmd shim), so only allow plain tokens.
const SAFE = /^[A-Za-z0-9._x-]+$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

// A swap only submits, but give it more room than reads: a timeout after sending is recorded as
// UNKNOWN (on Windows the shell is killed, not necessarily `baw`, so the order may still go out).
const TIMEOUT_MS = 60_000;
const SWAP_TIMEOUT_MS = 120_000;
const BALANCE_TIMEOUT_MS = 15_000;

/** Parse from the first `{` to the last `}`: tolerates a banner or warning line around the JSON. */
function parseJson(stdout: string): any {
  const a = stdout.indexOf("{");
  const b = stdout.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`no JSON in baw output: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(a, b + 1));
}

/**
 * Wraps the `baw` CLI (npm: @binance/agentic-wallet). Command shapes come from the official
 * binance-agentic-wallet skill (references/market-order.md). Not exercised against the live
 * service yet: see README "Verified vs unverified". Response shapes are read defensively.
 */
export class BawExecutor implements Executor {
  readonly name = "baw" as const;
  constructor(
    private cfg: Config,
    private runner: Runner = defaultRunner,
  ) {}

  private async baw(call: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<any> {
    for (const a of args) if (!SAFE.test(a)) throw new NotSent(`refusing unsafe argument: ${a}`);
    const started = Date.now();
    const ts = new Date().toISOString();
    let stdout = "";
    let stderr = "";
    let json: any;
    try {
      ({ stdout, stderr } = await this.runner(this.cfg.bawBin, [...args, "--json"], timeoutMs));
      json = parseJson(stdout);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      stderr = e.stderr ?? stderr;
      // A non-zero exit can still carry a JSON `{ success: false, error }` answer on stdout.
      try {
        json = e.killed ? undefined : parseJson(e.stdout ?? stdout);
      } catch {
        json = undefined;
      }
      if (json === undefined) {
        const msg = e.killed ? `timed out after ${timeoutMs} ms` : (e.message ?? String(err));
        logApiCall(this.cfg.dataDir, { ts, call, ms: Date.now() - started, ok: false, error: msg.slice(0, 500), stderr: stderr.slice(0, 500) || undefined });
        throw new Error(`${call}: ${msg}`);
      }
    }
    const ok = json?.success === true;
    logApiCall(this.cfg.dataDir, {
      ts, call, ms: Date.now() - started, ok,
      error: ok ? undefined : JSON.stringify(json?.error ?? json).slice(0, 500),
      stderr: stderr.slice(0, 500) || undefined,
    });
    if (!ok) throw new VenueRejected(JSON.stringify(json?.error ?? json).slice(0, 400));
    return json.data;
  }

  private orderArgs(a: SwapArgs): string[] {
    return [
      "--fromTokenQty", a.fromQty,
      "--fromToken", a.fromToken,
      "--toToken", a.toToken,
      "--binanceChainId", BSC_CHAIN_ID,
      "--slippage", a.slippage,
    ];
  }

  async quote(a: SwapArgs): Promise<Quote> {
    const d = await this.baw("market-order quote", ["market-order", "quote", ...this.orderArgs(a)]);
    const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
    const slip = d?.slippage === undefined || d?.slippage === null || d?.slippage === "" ? NaN : Number(d.slippage);
    return {
      fromSymbol: str(d?.fromCoinSymbol),
      fromAmount: str(d?.fromCoinAmount),
      toSymbol: str(d?.toCoinSymbol),
      toAmount: str(d?.toCoinAmount),
      slippage: Number.isFinite(slip) ? slip : null,
      raw: d,
    };
  }

  async swap(a: SwapArgs) {
    const d = await this.baw("market-order swap", ["market-order", "swap", ...this.orderArgs(a)], SWAP_TIMEOUT_MS);
    const id = d?.orderId;
    const valid = (typeof id === "string" && id.trim() !== "") || (typeof id === "number" && Number.isSafeInteger(id));
    // success without a usable orderId: the order may exist, so this is NOT a rejection (-> UNKNOWN)
    if (!valid) throw new Error(`swap succeeded without a usable orderId: ${JSON.stringify(d).slice(0, 200)}`);
    return { orderId: String(id).trim(), raw: d };
  }

  /**
   * `baw wallet balance --binanceChainId 56 --json` (references/wallet-view.md): data is a list of
   * { symbol, address, binanceChainId, balance, price, value }. Tokens worth < $0.01 are hidden, so
   * a missing token reads as "0". Short timeout: a snapshot must never hold up an order.
   */
  async balances(tokens: string[]): Promise<Record<string, string>> {
    const d = await this.baw("wallet balance", ["wallet", "balance", "--binanceChainId", BSC_CHAIN_ID], BALANCE_TIMEOUT_MS);
    const list: any[] = Array.isArray(d) ? d : Array.isArray(d?.list) ? d.list : [];
    const out: Record<string, string> = {};
    for (const t of tokens) {
      const hit = list.find(
        (x) => x && typeof x.address === "string" && x.address.toLowerCase() === t.toLowerCase() &&
          (x.binanceChainId === undefined || String(x.binanceChainId) === BSC_CHAIN_ID),
      );
      const b = hit?.balance;
      out[t.toLowerCase()] = typeof b === "string" || typeof b === "number" ? String(b) : "0";
    }
    return out;
  }

  async order(orderId: string): Promise<OrderState> {
    const d = await this.baw("market-order list", ["market-order", "list", "--orderId", orderId]);
    const list: any[] = Array.isArray(d?.list) ? d.list : Array.isArray(d) ? d : [];
    const o = list.find((x) => x && String(x.orderId) === orderId);
    if (!o) return { orderId, status: "PENDING", txHash: null, raw: d };
    const s = String(o.status ?? "").toUpperCase();
    const status = s === "FINISHED" || s === "FAILED" ? s : "PENDING"; // anything else is not terminal
    return { orderId, status, txHash: typeof o.txHash === "string" && TX.test(o.txHash) ? o.txHash : null, raw: o };
  }
}
