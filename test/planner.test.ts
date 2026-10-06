import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupMarket, type MarketInfo } from "../src/adapters/market.js";
import { MockExecutor } from "../src/adapters/mock.js";
import type { Executor } from "../src/adapters/types.js";
import { BSC_BNB, BSC_USDT, type Config } from "../src/config.js";
import { estimatedLossUsd } from "../src/guards.js";
import { runAttempt, type AttemptInput, type ReceiptReader } from "../src/probe.js";
import { summarize, vsReferenceBps } from "../src/stats.js";
import { appendJsonl, fillsPath, readFills, redact, renderTable, saveRawSample } from "../src/store.js";
import { getFillStats, getFillStatsArgs } from "../src/tool.js";
import type { FillRecord, RwaToken } from "../src/types.js";

// Hermetic: temp dirs, no real network (fetch is stubbed where used), env restored after each test.
const ENV0 = { ...process.env };
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(process.env)) if (!(k in ENV0)) delete process.env[k];
  Object.assign(process.env, ENV0);
});

const cfg = (over: Partial<Config> = {}): Config => {
  const dir = mkdtempSync(join(tmpdir(), "ft-p-"));
  return {
    live: true, maxUsdPerFill: 5, maxOpenUsd: 8, maxFillsPerDay: 12, cooldownSeconds: 20, budgetUsd: 3,
    killSwitchFailClosed: true, killFile: join(dir, "KILL"), adapter: "mock", bawBin: "baw", bscRpcUrl: "",
    walletAddress: "0x2222222222222222222222222222222222222222", slippage: "1", maxQuoteSlippage: 0.01, bnbUsd: 0,
    dataDir: dir, ...over,
  };
};
const token: RwaToken = { chainId: "56", contractAddress: "0x1111111111111111111111111111111111111111", symbol: "TSLAon", ticker: "TSLA", type: 1, multiplier: "1" };
const TX = "0x" + "ab".repeat(32);
const receipt = (amount: string): ReceiptReader => async () => ({ amount });
const broken: ReceiptReader = async () => { throw new Error("rpc down"); };

const attempt = (c: Config, exec: Executor, over: Partial<AttemptInput> = {}) =>
  runAttempt({
    cfg: c, exec, token, provider: "ondo", side: "buy", qty: "4", usd: 4, liveFlag: true, readReceipt: receipt("0.04"),
    pollEveryMs: 1, pollTimeoutMs: 200, allowMock: true, balanceRetryMs: 1, ...over,
  });

const fakeExec = (o: Partial<Executor> = {}): Executor => ({
  name: "mock",
  quote: (a) => new MockExecutor({ price: 100 }).quote(a),
  swap: async () => ({ orderId: "o1", raw: { orderId: "o1" } }),
  order: async (id) => ({ orderId: id, status: "FINISHED", txHash: TX, raw: { orderId: id, status: "FINISHED" } }),
  ...o,
});

const row = (o: Partial<FillRecord>): FillRecord => ({
  id: Math.random().toString(36).slice(2), ts: "2026-10-07T15:00:00Z", adapter: "baw", provider: "ondo", symbol: "TSLAon", ticker: "TSLA",
  tokenAddress: token.contractAddress, side: "buy", session: "regular", dryRun: false, usdNotional: 4, fromQty: "4", multiplier: "1",
  quoteToAmount: null, quoteSlippage: null, quotePrice: 100, fillAmount: "0.04", fillPrice: 100, slippageBps: 0, quoteLatencyMs: 400,
  submitLatencyMs: 300, settleLatencyMs: 5000, orderId: "1", txHash: "0xabc", status: "FINISHED", route: null, error: null, ...o,
});

describe("balance snapshots", () => {
  it("fall back to the balance delta when the receipt cannot be decoded", async () => {
    const r = await attempt(cfg(), new MockExecutor({ price: 100, gasBnb: 0.0002 }), { readReceipt: broken });
    expect(r).toMatchObject({
      status: "FINISHED", fillSource: "balance", fillAmount: "0.04", error: null, receiptError: "receipt decode failed: rpc down",
      balancesBefore: { usdt: "100.00000000", token: "0.00000000", bnb: "0.05000000" }, usdtDelta: "-4", bnbDelta: "-0.0002",
    });
    expect(r.fillPrice).toBeCloseTo(100, 6);
  });

  it("use the receipt when it decodes, and flag a disagreement instead of picking one", async () => {
    const off = await attempt(cfg(), new MockExecutor({ price: 100 }), { readReceipt: receipt("0.03") });
    expect(off).toMatchObject({ fillSource: "receipt", fillAmount: "0.03", error: null });
    expect(off.fillMismatchError).toMatch(/receipt 0\.03 vs balance delta 0\.04/);
    const close = await attempt(cfg(), new MockExecutor({ price: 100 }), { readReceipt: receipt("0.0401") });
    expect(close.fillMismatchError).toBeUndefined();
  });

  it("a failing or hanging snapshot never blocks the order, and is noted on the row", async () => {
    const swap = vi.fn(async () => ({ orderId: "o1", raw: {} }));
    const failing = await attempt(cfg(), fakeExec({ swap, balances: async () => { throw new Error("wallet balance: timed out"); } }));
    expect(failing).toMatchObject({ status: "FINISHED", fillSource: "receipt", balancesBefore: null });
    expect(failing.balanceError).toMatch(/^before: /);
    const hanging = await attempt(cfg(), fakeExec({ swap, balances: () => new Promise(() => {}) }), { balanceTimeoutMs: 20 });
    expect(hanging.status).toBe("FINISHED");
    expect(hanging.balanceError).toMatch(/timed out after 20 ms/);
    expect(swap).toHaveBeenCalledTimes(2);
  });

  it("retry the after-snapshot while the balance lags", async () => {
    let calls = 0;
    const lagging = fakeExec({
      balances: async (ts) => {
        calls += 1; // 1 = before, 2 = after (stale), 3 = after (moved)
        const tok = calls >= 3 ? "0.04" : "0";
        return Object.fromEntries(ts.map((t) => [t.toLowerCase(), t === token.contractAddress ? tok : t === BSC_USDT ? "10" : "0.05"]));
      },
    });
    const r = await attempt(cfg(), lagging, { readReceipt: broken });
    expect(calls).toBe(3);
    expect(r).toMatchObject({ fillSource: "balance", fillAmount: "0.04" });
  });

  it("feed the worse of receipt and USDT delta, and the BNB drop (only with BNB_USD), into the loss budget", () => {
    const rows = [
      row({ usdtDelta: "-4.02", bnbDelta: "-0.0003" }),
      row({ side: "sell", fromQty: "0.04", fillAmount: "3.95", usdtDelta: "3.9", bnbDelta: "-0.0003" }),
    ];
    expect(estimatedLossUsd(rows)).toBeCloseTo(4.02 - 3.9, 6);
    expect(estimatedLossUsd(rows, 600)).toBeCloseTo(4.02 - 3.9 + 0.0006 * 600, 6);
    expect(BSC_BNB).toMatch(/^0xEeee/);
  });
});

describe("provider market status", () => {
  const json = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => ({ code: "000000", success: ok, data }) });

  it("records market, asset status and reference price from mocked fetch, and logs each call", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(u);
      if (u.includes("/asset/market/status/")) return json({ openState: false, marketStatus: "premarket", reasonCode: "ASSET_LIMITED", reasonMsg: "earnings" });
      if (u.includes("/market/status/")) return json({ openState: false, reasonCode: "MARKET_PAUSED", reasonMsg: "Paused for session transition" });
      if (u.includes("/dynamic/")) return json({ tokenInfo: { price: "303", sharesMultiplier: "1.01" }, statusInfo: {} });
      throw new Error(`unexpected ${u}`);
    }));
    const dir = cfg().dataDir;
    const m = await lookupMarket(token, dir);
    expect(m).toMatchObject({
      marketStatus: "closed", marketReason: "MARKET_PAUSED: Paused for session transition",
      assetStatus: "premarket", assetReason: "ASSET_LIMITED: earnings", providerSession: "premarket",
      referenceMultiplier: "1.01", marketError: null,
    });
    expect(m.referencePrice).toBeCloseTo(300, 9);
    expect(urls.every((u) => u.startsWith("https://www.binance.com/bapi/defi/"))).toBe(true);
    expect(readFileSync(join(dir, "api-calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("never throws: a failed lookup gives nulls plus a reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const dir = cfg().dataDir;
    const m = await lookupMarket(token, dir, 50);
    expect(m).toMatchObject({ marketStatus: null, assetStatus: null, providerSession: null, referencePrice: null });
    expect(m.marketError).toMatch(/market: ECONNRESET/);
    const log = readFileSync(join(dir, "api-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.every((e) => e.ok === false)).toBe(true);
  });

  it("a failing or hanging lookup never blocks the order", async () => {
    const swap = vi.fn(async () => ({ orderId: "o1", raw: {} }));
    const failed = await attempt(cfg(), fakeExec({ swap }), { market: async () => { throw new Error("HTTP 503"); } });
    expect(failed).toMatchObject({ status: "FINISHED", marketStatus: null, providerSession: null, marketError: "HTTP 503" });
    const hung = await attempt(cfg(), fakeExec({ swap }), { market: () => new Promise<MarketInfo>(() => {}), marketTimeoutMs: 20 });
    expect(hung.status).toBe("FINISHED");
    expect(hung.marketError).toMatch(/timed out/);
    expect(swap).toHaveBeenCalledTimes(2);
  });
});

describe("raw samples", () => {
  it("are written once per provider/side/kind and redacted", () => {
    const dir = cfg().dataDir;
    const raw = {
      orderId: "123", sessionToken: "abc", apiKey: "k", nested: { Authorization: "Bearer x", clientId: "c", ok: 1 },
      list: [{ jwt: "eyJhbGciOi.eyJzdWIi.sig" }], fromToken: "0x55d3",
    };
    expect(saveRawSample(dir, "ondo", "buy", "swap", raw)).toBe(true);
    expect(saveRawSample(dir, "ondo", "buy", "swap", { orderId: "second" })).toBe(false);
    const saved = JSON.parse(readFileSync(join(dir, "raw", "ondo-buy-swap.json"), "utf8"));
    expect(saved.raw).toEqual({
      orderId: "123", sessionToken: "[REDACTED string]", apiKey: "[REDACTED string]",
      nested: { Authorization: "[REDACTED string]", clientId: "[REDACTED string]", ok: 1 },
      list: [{ jwt: "[REDACTED jwt]" }], fromToken: "[REDACTED string]",
    });
    expect(JSON.stringify(saved)).not.toMatch(/abc|Bearer|eyJ/);
    expect(redact({ a: null, key: null })).toEqual({ a: null, key: null });
  });

  it("are taken from the real venue only (quote, swap, list)", async () => {
    const c = cfg();
    await attempt(c, fakeExec({ name: "baw" }), { allowMock: false });
    expect(readdirSync(join(c.dataDir, "raw")).sort()).toEqual(["ondo-buy-list.json", "ondo-buy-quote.json", "ondo-buy-swap.json"]);
    const m = cfg();
    await attempt(m, fakeExec());
    expect(existsSync(join(m.dataDir, "raw"))).toBe(false);
  });
});

describe("quote-only stats", () => {
  const q = (o: Partial<FillRecord>) =>
    row({ dryRun: true, status: "DRY_RUN", fillAmount: null, fillPrice: null, slippageBps: null, orderId: null, txHash: null, ...o });

  it("dry-run rows persist the fields quote mode needs", async () => {
    const c = cfg();
    const market = async (): Promise<MarketInfo> => ({
      marketStatus: "open", marketReason: "TRADING", assetStatus: "regular", assetReason: "TRADING", providerSession: "regular",
      referencePrice: 99, referenceMultiplier: "1", marketError: null,
    });
    await attempt(c, fakeExec({ name: "baw" }), { liveFlag: false, market });
    const [saved] = readFills(c.dataDir);
    expect(saved).toMatchObject({ adapter: "baw", status: "DRY_RUN", session: expect.any(String), providerSession: "regular", referencePrice: 99 });
    expect(saved!.quoteLatencyMs).toEqual(expect.any(Number));
    expect(summarize(readFills(c.dataDir), {}, false, "quotes")).toMatchObject({ quotes: 1, usable: 1 });
  });

  it("aggregates real quote rows only, with latency, failure codes and spread vs reference", () => {
    const rows = [
      q({ quotePrice: 101, referencePrice: 100, referenceMultiplier: "1", quoteLatencyMs: 300, providerSession: "regular" }),
      q({ quotePrice: 100, referencePrice: 50, referenceMultiplier: "2", quoteLatencyMs: 500, providerSession: "overnight" }),
      q({ status: "QUOTE_FAILED", quotePrice: null, error: "QUOTE_NO_AMOUNT", quoteLatencyMs: 700 }),
      q({ status: "QUOTE_FAILED", quotePrice: null, error: "QUOTE_ERROR: 503", quoteLatencyMs: null }),
      q({ adapter: "mock" }),
      row({}), // a live fill is not a quote sample
    ];
    const s = summarize(rows, {}, false, "quotes");
    expect(s).toMatchObject({ mode: "quotes", quotes: 4, usable: 2, quoteFailures: 2, quoteFailureReasons: { QUOTE_NO_AMOUNT: 1, QUOTE_ERROR: 1 } });
    expect(s.quoteLatencyMs).toEqual({ median: 500, p95: 700 });
    expect(s.vsReferenceBps.n).toBe(2);
    expect(s.vsReferenceBps.worst).toBeCloseTo(100, 6); // 101 vs 100
    expect(s.note).toMatch(/no fill occurred/);
    expect(summarize(rows, { providerSession: "overnight" }, false, "quotes").quotes).toBe(1);
    expect(vsReferenceBps(q({ side: "sell", quotePrice: 99, referencePrice: 100, referenceMultiplier: "1" }))).toBeCloseTo(101.01, 1);
    expect(summarize(rows).mode).toBe("fills"); // default unchanged
  });

  it("the table shows the provider session", () => {
    expect(renderTable([row({ providerSession: "premarket" })])).toContain("| premarket |");
  });
});

describe("get_fill_stats schema", () => {
  it("accepts mode and providerSession, rejects unknown values", () => {
    expect(getFillStatsArgs.parse({ mode: "quotes", providerSession: "overnight" })).toEqual({ mode: "quotes", providerSession: "overnight" });
    expect(() => getFillStatsArgs.parse({ mode: "bogus" })).toThrow();
    expect(() => getFillStatsArgs.parse({ providerSession: "lunch" })).toThrow();
  });
  it("returns quote stats in quotes mode and an error when the tape is missing", () => {
    const dir = cfg().dataDir;
    expect(getFillStats(dir, {})).toMatchObject({ isError: true });
    appendJsonl(fillsPath(dir), { ...row({}), dryRun: true, status: "DRY_RUN" });
    const out = getFillStats(dir, { mode: "quotes" });
    expect("isError" in out).toBe(false);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ mode: "quotes", quotes: 1 });
    expect(JSON.parse(getFillStats(dir, {}).content[0]!.text)).toMatchObject({ mode: "fills", attempts: 0 });
  });
});
