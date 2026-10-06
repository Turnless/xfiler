import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockExecutor } from "../src/adapters/mock.js";
import { VenueRejected, type Executor } from "../src/adapters/types.js";
import { BSC_USDT, PROJECT_ROOT, loadConfig, type Config } from "../src/config.js";
import { checkGates, estimatedLossUsd, isKillSwitchActive, openExposureUsd, openQty, parsePositive } from "../src/guards.js";
import { reconcileRow, runAttempt, sellQtyAfterBuy, type AttemptInput, type ReceiptReader } from "../src/probe.js";
import { percentile, summarize } from "../src/stats.js";
import { appendJsonl, fillsPath, floor8, latestById, ledger, readFills, renderTable } from "../src/store.js";
import type { FillRecord, RwaToken } from "../src/types.js";

// Hermetic: every test gets its own temp data dir and KILL path, and process.env is restored after each test.
const ENV0 = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ENV0)) delete process.env[k];
  Object.assign(process.env, ENV0);
});

const cfg = (over: Partial<Config> = {}): Config => {
  const dir = mkdtempSync(join(tmpdir(), "ft-"));
  return {
    live: true, maxUsdPerFill: 5, maxOpenUsd: 8, maxFillsPerDay: 12, cooldownSeconds: 20, budgetUsd: 3,
    killSwitchFailClosed: true, killFile: join(dir, "KILL"), adapter: "mock", bawBin: "baw", bscRpcUrl: "",
    walletAddress: "0x2222222222222222222222222222222222222222", slippage: "1", maxQuoteSlippage: 0.01, bnbUsd: 0,
    dataDir: dir, ...over,
  };
};

const token: RwaToken = { chainId: "56", contractAddress: "0x1111111111111111111111111111111111111111", symbol: "TSLAon", ticker: "TSLA", type: 1, multiplier: "1" };
const TX = "0x" + "ab".repeat(32);

/** Checks its token arguments: buy = stock in, USDT must leave; sell = USDT in, nothing required out. */
const reader: ReceiptReader = async (_hash, received, spent) => {
  if (received === token.contractAddress && spent === BSC_USDT) return { amount: "0.0396", gasUsed: "150000", effectiveGasPrice: "1000000000" };
  if (received === BSC_USDT && spent === null) return { amount: "3.95" };
  throw new Error(`unexpected reader args ${received} ${spent}`);
};

/** A venue whose pieces each test can replace. */
const fakeExec = (o: Partial<Executor> = {}): Executor => ({
  name: "mock",
  quote: (a) => new MockExecutor({ price: 100 }).quote(a),
  swap: async () => ({ orderId: "o1", raw: {} }),
  order: async (id) => ({ orderId: id, status: "FINISHED", txHash: TX, raw: {} }),
  ...o,
});

const attempt = (c: Config, exec: Executor, over: Partial<AttemptInput> = {}) =>
  runAttempt({
    cfg: c, exec, token, provider: "ondo", side: "buy", qty: "4", usd: 4, liveFlag: true, readReceipt: reader,
    pollEveryMs: 1, pollTimeoutMs: 200, allowMock: true, ...over,
  });

const row = (o: Partial<FillRecord>): FillRecord => ({
  id: Math.random().toString(36).slice(2), ts: "2026-10-07T15:00:00Z", adapter: "baw", provider: "ondo", symbol: "TSLAon", ticker: "TSLA",
  tokenAddress: token.contractAddress, side: "buy", session: "regular", dryRun: false, usdNotional: 4, fromQty: "4", multiplier: "1",
  quoteToAmount: null, quoteSlippage: null, quotePrice: 100, fillAmount: "0.04", fillPrice: 100.5, slippageBps: 50, quoteLatencyMs: 400,
  submitLatencyMs: 300, settleLatencyMs: 5000, orderId: "1", txHash: "0xabc", status: "FINISHED", route: null, error: null, ...o,
});

describe("guards", () => {
  const base = () => ({ cfg: cfg(), liveFlag: true, usd: 4, side: "buy" as const, history: [] as FillRecord[], now: new Date() });
  it("passes a clean live order", () => expect(checkGates(base())).toEqual([]));
  it("dry-run unless both switches are on", () => {
    expect(checkGates({ ...base(), liveFlag: false })).toContain("DRY_RUN");
    expect(checkGates({ ...base(), cfg: cfg({ live: false }) })).toContain("DRY_RUN");
  });
  it("enforces per-fill cap and rejects NaN / zero amounts", () => {
    expect(checkGates({ ...base(), usd: 5.01 })).toContain("PER_FILL_CAP");
    expect(checkGates({ ...base(), usd: NaN })).toContain("BAD_AMOUNT");
    expect(checkGates({ ...base(), usd: 0 })).toContain("BAD_AMOUNT");
  });
  it("trips the kill-switch on 1 / true / TRUE / yes and on a KILL file", () => {
    for (const v of ["1", "true", "TRUE", "yes"]) {
      process.env.KILL_SWITCH = v;
      expect(checkGates(base())).toContain("KILL_SWITCH_ACTIVE");
    }
    process.env.KILL_SWITCH = "0";
    expect(checkGates(base())).not.toContain("KILL_SWITCH_ACTIVE");
    const b = base();
    writeFileSync(b.cfg.killFile, "");
    expect(checkGates(b)).toContain("KILL_SWITCH_ACTIVE");
  });
  it("kill-switch fails closed when the KILL check itself throws", () => {
    const boom = () => { throw new Error("EACCES"); };
    expect(isKillSwitchActive(cfg(), "x", boom)).toBe(true);
    expect(isKillSwitchActive(cfg({ killSwitchFailClosed: false }), "x", boom)).toBe(false);
  });
  it("refuses live with the mock adapter unless a test asks for it", () => {
    expect(checkGates({ ...base(), adapter: "mock" })).toContain("MOCK_ADAPTER");
    expect(checkGates({ ...base(), adapter: "mock", allowMock: true })).toEqual([]);
  });
  it("ignores mock rows unless asked", () => {
    const hist = [row({ adapter: "mock", status: "PENDING" })];
    expect(checkGates({ ...base(), history: hist })).toEqual([]);
    expect(checkGates({ ...base(), history: hist, allowMock: true })).toContain("UNRESOLVED_ORDER");
  });
  it("a sell closing a known buy skips cooldown, daily cap and budget, but not kill-switch or unresolved orders", () => {
    const now = new Date("2026-10-07T15:00:05Z");
    const history = [row({ fillAmount: "0.04" })]; // bought 5 s ago
    const g = { ...base(), cfg: cfg({ maxFillsPerDay: 1, budgetUsd: 0 }), history, now, side: "sell" as const, tokenAddress: token.contractAddress };
    expect(checkGates({ ...g, qty: "0.04" })).toEqual([]);
    expect(checkGates({ ...g, side: "buy" })).toEqual(expect.arrayContaining(["COOLDOWN_ACTIVE", "DAILY_COUNT_CAP", "BUDGET_EXHAUSTED"]));
    expect(checkGates({ ...g, qty: "0.05" })).toContain("COOLDOWN_ACTIVE"); // more than the ledger holds: normal gates
    expect(checkGates({ ...g, qty: "0.04", history: [...history, row({ status: "UNKNOWN" })] })).toContain("UNRESOLVED_ORDER");
    process.env.KILL_SWITCH = "1";
    expect(checkGates({ ...g, qty: "0.04" })).toContain("KILL_SWITCH_ACTIVE");
  });
  it("validates CLI amounts up front", () => {
    for (const bad of ["NaN", "abc", "", " ", "-1", "0", "Infinity", undefined]) expect(() => parsePositive("--usd", bad)).toThrow(/--usd/);
    expect(parsePositive("--usd", "3")).toBe(3);
  });
});

describe("ledger", () => {
  it("open exposure nets buys and sells by quantity", () => {
    expect(openExposureUsd([row({}), row({ side: "sell", fromQty: "0.04", fillAmount: "3.9" }), row({})])).toBe(4);
  });
  it("counts unresolved and undecoded buys in full", () => {
    expect(openExposureUsd([row({ status: "SUBMITTING", fillAmount: null }), row({ status: "UNKNOWN", fillAmount: null })])).toBe(8);
    expect(openExposureUsd([row({ fillAmount: null, error: "receipt decode failed: x" })])).toBe(4);
    expect(openExposureUsd([row({ status: "FAILED", fillAmount: null })])).toBe(0);
  });
  it("takes the last row per id", () => {
    const a1 = row({ id: "a", status: "SUBMITTING", fillAmount: null });
    const b = row({ id: "b" });
    const a2 = row({ id: "a", status: "FINISHED" });
    expect(latestById([a1, b, a2])).toEqual([a2, b]);
    expect(summarize([a1, b, a2])).toMatchObject({ attempts: 2, filled: 2, pending: 0 });
    expect(checkGates({ cfg: cfg(), liveFlag: true, usd: 4, side: "buy", history: [a1, b, a2], now: new Date() })).not.toContain("UNRESOLVED_ORDER");
    expect(ledger([a1, row({ id: "m", adapter: "mock" })])).toHaveLength(1);
  });
  it("floors quantities to 8 decimals without exponent notation", () => {
    expect(floor8("0.123456789")).toBe("0.12345678");
    expect(floor8("0.000000009")).toBe("0");
    expect(floor8(1e-7)).toBe("0.0000001");
    expect(floor8("0.0396")).toBe("0.0396");
  });
});

describe("runAttempt", () => {
  it("full buy + sell round trip, sell exempt from the cooldown", async () => {
    const c = cfg();
    const calls: Array<[string, string | null]> = [];
    const spy: ReceiptReader = (h, t, s) => (calls.push([t, s]), reader(h, t, s));
    const ex = new MockExecutor({ price: 100 });
    const buy = await attempt(c, ex, { readReceipt: spy });
    expect(buy).toMatchObject({ status: "FINISHED", adapter: "mock", fillAmount: "0.0396", gasUsed: "150000", quoteSlippage: 0.005 });
    expect(buy.quotePrice).toBeCloseTo(100, 6);
    expect(buy.slippageBps).toBeGreaterThan(90); // 0.0396 for $4 at quote 100 = ~101 bps worse
    const qty = sellQtyAfterBuy(buy);
    expect(qty).toBe("0.0396");
    const sell = await attempt(c, ex, { side: "sell", qty: qty!, usd: buy.usdNotional, readReceipt: spy });
    expect(sell).toMatchObject({ status: "FINISHED", fillAmount: "3.95", error: null });
    expect(sell.usdNotional).toBeCloseTo(3.96, 6); // mock models sells: qty * price
    expect(calls).toEqual([[token.contractAddress, BSC_USDT], [BSC_USDT, null]]);

    const rows = readFills(c.dataDir);
    expect(rows.map((r) => r.status)).toEqual(["SUBMITTING", "PENDING", "FINISHED", "SUBMITTING", "PENDING", "FINISHED"]);
    expect(latestById(rows)).toHaveLength(2);
    expect(openQty(rows, token.contractAddress)).toBe("0");
    expect(openExposureUsd(rows)).toBe(0);
    expect(estimatedLossUsd(rows)).toBeCloseTo(0.05, 6); // $4 out, $3.95 back
    expect(estimatedLossUsd(rows, 600)).toBeCloseTo(0.05 + 0.00015 * 600, 6); // + gas when BNB_USD is set
  });

  it("writes SUBMITTING before swap is called", async () => {
    const c = cfg();
    let seen: string[] = [];
    const r = await attempt(c, fakeExec({ swap: async () => { seen = readFills(c.dataDir).map((x) => x.status); return { orderId: "o1", raw: {} }; } }));
    expect(seen).toEqual(["SUBMITTING"]);
    expect(r.status).toBe("FINISHED");
  });

  it("PENDING at timeout stays unresolved: counts as exposure and blocks the next live order until reconciled", async () => {
    const c = cfg();
    const pending = fakeExec({ order: async (id) => ({ orderId: id, status: "PENDING", txHash: null, raw: {} }) });
    const r = await attempt(c, pending, { pollTimeoutMs: 20 });
    expect(r).toMatchObject({ status: "PENDING", orderId: "o1", dryRun: false, error: "still PENDING at poll timeout" });
    expect(openExposureUsd(readFills(c.dataDir))).toBe(4);
    expect(summarize(readFills(c.dataDir), {}, true)).toMatchObject({ pending: 1, failureReasons: { POLL_TIMEOUT: 1 } });

    const swap = vi.fn(async () => ({ orderId: "o2", raw: {} }));
    const later = () => new Date(Date.now() + 3600_000); // well past the cooldown
    const next = await attempt(c, fakeExec({ swap }), { now: later });
    expect(next.status).toBe("ABORTED");
    expect(next.error).toContain("UNRESOLVED_ORDER");
    expect(swap).not.toHaveBeenCalled();

    const fixed = await reconcileRow(latestById(readFills(c.dataDir))[0]!, fakeExec(), reader);
    expect(fixed).toMatchObject({ id: r.id, status: "FINISHED", fillAmount: "0.0396" });
    appendJsonl(fillsPath(c.dataDir), fixed);
    expect((await attempt(c, fakeExec({ swap }), { now: later })).status).toBe("FINISHED");
  });

  it("a poll exception after submission yields UNKNOWN", async () => {
    const c = cfg();
    const r = await attempt(c, fakeExec({ order: async () => { throw new Error("socket hang up"); } }), { pollTimeoutMs: 20 });
    expect(r).toMatchObject({ status: "UNKNOWN", orderId: "o1", dryRun: false, error: "poll failed: socket hang up" });
  });

  it("retries a transient poll error", async () => {
    let n = 0;
    const flaky = fakeExec({ order: async (id) => { if (n++ === 0) throw new Error("ECONNRESET"); return { orderId: id, status: "FINISHED", txHash: TX, raw: {} }; } });
    expect((await attempt(cfg(), flaky)).status).toBe("FINISHED");
  });

  it("swap errors: rejected = FAILED, anything else after sending = UNKNOWN", async () => {
    const rejected = await attempt(cfg(), fakeExec({ swap: async () => { throw new VenueRejected("insufficient balance"); } }));
    expect(rejected).toMatchObject({ status: "FAILED", orderId: null });
    const timeout = await attempt(cfg(), fakeExec({ swap: async () => { throw new Error("market-order swap: timed out after 120000 ms"); } }));
    expect(timeout.status).toBe("UNKNOWN");
    expect(timeout.error).toMatch(/^swap outcome unknown/);
  });

  it("venue FINISHED + receipt read exception stays FINISHED with a decode error", async () => {
    const r = await attempt(cfg(), fakeExec(), { readReceipt: async () => { throw new Error("rpc down"); } });
    expect(r).toMatchObject({ status: "FINISHED", txHash: TX, fillAmount: null, error: "receipt decode failed: rpc down" });
    expect(sellQtyAfterBuy(r)).toBeNull();
  });

  it("a decoded amount of 0 is an error, and no zero-quantity sell follows", async () => {
    const r = await attempt(cfg(), fakeExec(), { readReceipt: async () => ({ amount: "0" }) });
    expect(r).toMatchObject({ status: "FINISHED", fillAmount: null, error: "receipt decode failed: decoded amount 0" });
    expect(sellQtyAfterBuy(r)).toBeNull();
    expect(sellQtyAfterBuy({ ...r, error: null, fillAmount: "0.000000004" })).toBeNull(); // floors to 0
  });

  it("records an unusable quote as QUOTE_FAILED before the gates, and never sends", async () => {
    const c = cfg();
    const swap = vi.fn(async () => ({ orderId: "x", raw: {} }));
    const q = (toAmount: string, slippage: number | null = null) => async () => ({ fromSymbol: "USDT", fromAmount: "4", toSymbol: "T", toAmount, slippage, raw: {} });
    for (const bad of ["0", "", "NaN", "abc", "-1"]) {
      expect(await attempt(c, fakeExec({ quote: q(bad), swap }))).toMatchObject({ status: "QUOTE_FAILED", dryRun: true, error: "QUOTE_NO_AMOUNT" });
    }
    const slip = await attempt(c, fakeExec({ quote: q("0.04", 0.05), swap }));
    expect(slip).toMatchObject({ status: "QUOTE_FAILED", quoteSlippage: 0.05 });
    expect(slip.error).toMatch(/^QUOTE_SLIPPAGE_HIGH/);
    const thrown = await attempt(c, fakeExec({ quote: async () => { throw new Error("503"); }, swap }));
    expect(thrown).toMatchObject({ status: "QUOTE_FAILED", error: "QUOTE_ERROR: 503" });
    expect(swap).not.toHaveBeenCalled();
    const s = summarize(readFills(c.dataDir), {}, true);
    expect(s.quoteFailures).toBe(7);
    expect(s.attempts).toBe(0);
    expect(renderTable(readFills(c.dataDir), true)).toContain("QUOTE_FAILED: QUOTE_NO_AMOUNT");
  });

  it("never calls swap in a dry run", async () => {
    const swap = vi.fn(async (): Promise<{ orderId: string; raw: unknown }> => { throw new Error("swap must not be called in dry-run"); });
    const r = await attempt(cfg(), fakeExec({ swap }), { liveFlag: false });
    expect(r).toMatchObject({ status: "DRY_RUN", orderId: null, dryRun: true });
    expect((await attempt(cfg({ live: false }), fakeExec({ swap }))).status).toBe("DRY_RUN");
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses live with the mock adapter", async () => {
    const r = await attempt(cfg(), new MockExecutor(), { allowMock: false });
    expect(r.status).toBe("ABORTED");
    expect(r.error).toContain("MOCK_ADAPTER");
  });

  it("records a venue FAILED order instead of throwing", async () => {
    const r = await attempt(cfg(), new MockExecutor({ failEvery: 1 }));
    expect(r).toMatchObject({ status: "FAILED", txHash: null });
  });
});

describe("mock venue", () => {
  it("models sells: qty tokens -> qty * price USDT", async () => {
    const m = new MockExecutor({ price: 100 });
    expect((await m.quote({ fromToken: token.contractAddress, toToken: BSC_USDT, fromQty: "0.04", slippage: "1" })).toAmount).toBe("4.00000000");
    expect((await m.quote({ fromToken: BSC_USDT, toToken: token.contractAddress, fromQty: "4", slippage: "1" })).toAmount).toBe("0.04000000");
  });
});

describe("stats and table", () => {
  it("ignores dry runs and mock rows, counts failures by stable code", () => {
    const s = summarize([
      row({}),
      row({ status: "FAILED", txHash: null, error: "swap rejected: {\"msg\":\"slippage exceeded\"}", slippageBps: null }),
      row({ dryRun: true }),
      row({ adapter: "mock" }),
    ]);
    expect(s.attempts).toBe(2);
    expect(s.successRate).toBe(0.5);
    expect(s.failureReasons).toEqual({ SLIPPAGE: 1 });
    expect(s.txHashes).toEqual(["0xabc"]);
    expect(s.note).toMatch(/p95 is the maximum/);
  });
  it("filters by session", () => {
    expect(summarize([row({}), row({ session: "overnight" })], { session: "overnight" }).attempts).toBe(1);
  });
  it("caps tx hashes at the last 50", () => {
    const s = summarize(Array.from({ length: 60 }, (_, k) => row({ txHash: `0x${k}` })));
    expect(s.txHashes).toHaveLength(50);
    expect(s.txHashes.at(-1)).toBe("0x59");
  });
  it("percentile is nearest-rank, not the max", () => {
    const xs = Array.from({ length: 20 }, (_, k) => (k + 1) * 10); // 10..200, distinct
    expect(percentile(xs, 95)).toBe(190);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  });
  it("escapes | and newlines and truncates errors in the table", () => {
    const t = renderTable([row({ status: "FAILED", error: "bad|thing\nline2 " + "x".repeat(200) })]);
    const line = t.trim().split("\n").at(-1)!;
    expect(t.trim().split("\n")).toHaveLength(3);
    expect(line).toContain("bad\\|thing line2");
    expect(line).toContain("…");
    expect(line).not.toContain("x".repeat(100));
  });
});

describe("config", () => {
  const env = (body: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "ft-env-")), ".env");
    writeFileSync(f, body);
    for (const k of ["WALLET_ADDRESS", "SLIPPAGE", "BUDGET_USD", "DATA_DIR", "LIVE"]) delete process.env[k];
    return f;
  };
  it("strips quotes, defaults SLIPPAGE to 1 and BUDGET_USD to 3, resolves paths from the project root", () => {
    const c = loadConfig(env(`WALLET_ADDRESS="0xabc"  # quoted\nLIVE='0'\n`));
    expect(c).toMatchObject({ walletAddress: "0xabc", live: false, slippage: "1", budgetUsd: 3 });
    expect(c.dataDir).toBe(join(PROJECT_ROOT, "data"));
    expect(c.killFile).toBe(join(PROJECT_ROOT, "KILL"));
  });
  it("rejects SLIPPAGE above 3 percent or not a number", () => {
    expect(() => loadConfig(env("SLIPPAGE=5\n"))).toThrow(/SLIPPAGE/);
    expect(() => loadConfig(env("SLIPPAGE=auto\n"))).toThrow(/SLIPPAGE/);
    expect(loadConfig(env("SLIPPAGE=0.5\n")).slippage).toBe("0.5");
  });
});
