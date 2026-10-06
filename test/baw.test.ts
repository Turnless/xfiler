import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BawExecutor, type Runner } from "../src/adapters/baw.js";
import { NotSent, VenueRejected } from "../src/adapters/types.js";
import type { Config } from "../src/config.js";

// The runner is always faked: these tests never spawn `baw` or touch the network.
const cfg = (): Config => {
  const dir = mkdtempSync(join(tmpdir(), "ft-baw-"));
  return {
    live: false, maxUsdPerFill: 5, maxOpenUsd: 8, maxFillsPerDay: 12, cooldownSeconds: 20, budgetUsd: 3,
    killSwitchFailClosed: true, killFile: join(dir, "KILL"), adapter: "baw", bawBin: "baw", bscRpcUrl: "",
    walletAddress: "", slippage: "1", maxQuoteSlippage: 0.01, bnbUsd: 0, dataDir: dir,
  };
};
const ok = (data: unknown, prefix = "") => ({ stdout: prefix + JSON.stringify({ success: true, data }), stderr: "" });
const TX = "0x" + "c".repeat(64);
const args = { fromToken: "0x55d398326f99059fF775485246999027B3197955", toToken: "0x1111111111111111111111111111111111111111", fromQty: "3", slippage: "1" };

describe("BawExecutor.order", () => {
  const list = [
    { orderId: 111, status: "pending", txHash: null },
    { orderId: "222", status: "finished", txHash: TX },
    { orderId: 333, status: "Failed" },
    { orderId: 444, status: "PROCESSING" },
  ];
  const ex = new BawExecutor(cfg(), async () => ok({ list }, "Update available: run npm i -g @binance/agentic-wallet\n"));
  it("picks the item whose orderId matches, not list[0], and tolerates case and a banner line", async () => {
    expect(await ex.order("222")).toMatchObject({ status: "FINISHED", txHash: TX });
    expect(await ex.order("333")).toMatchObject({ status: "FAILED", txHash: null });
    expect(await ex.order("111")).toMatchObject({ status: "PENDING" });
  });
  it("treats unknown statuses and missing orders as PENDING", async () => {
    expect((await ex.order("444")).status).toBe("PENDING");
    expect((await ex.order("999")).status).toBe("PENDING");
  });
});

describe("BawExecutor.swap", () => {
  it("requires a usable orderId", async () => {
    for (const orderId of [undefined, NaN, "", "  ", 1.5, null]) {
      const ex = new BawExecutor(cfg(), async () => ok({ orderId }));
      const err = await ex.swap(args).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(VenueRejected); // may have been sent: the probe records UNKNOWN
    }
    expect((await new BawExecutor(cfg(), async () => ok({ orderId: 42 })).swap(args)).orderId).toBe("42");
  });
  it("success:false is a rejection, a timeout is not", async () => {
    const rejected = new BawExecutor(cfg(), async () => ({ stdout: JSON.stringify({ success: false, error: "min size" }), stderr: "" }));
    await expect(rejected.swap(args)).rejects.toBeInstanceOf(VenueRejected);
    const timedOut: Runner = async () => { throw Object.assign(new Error("killed"), { killed: true, stdout: "", stderr: "" }); };
    const err = await new BawExecutor(cfg(), timedOut).swap(args).catch((e) => e);
    expect(err).not.toBeInstanceOf(VenueRejected);
    expect(err.message).toMatch(/timed out/);
  });
  it("reads a JSON error from a non-zero exit", async () => {
    const exit1: Runner = async () => { throw Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ success: false, error: { code: 1 } }), stderr: "" }); };
    await expect(new BawExecutor(cfg(), exit1).swap(args)).rejects.toBeInstanceOf(VenueRejected);
  });
  it("refuses unsafe arguments before running anything", async () => {
    let ran = false;
    const ex = new BawExecutor(cfg(), async () => { ran = true; return ok({ orderId: 1 }); });
    await expect(ex.swap({ ...args, fromQty: "3 & calc" })).rejects.toBeInstanceOf(NotSent);
    expect(ran).toBe(false);
  });
  it("logs stderr to api-calls.jsonl", async () => {
    const c = cfg();
    await new BawExecutor(c, async () => ({ ...ok({ orderId: 7 }), stderr: "warning: session expires soon" })).swap(args);
    const log = readFileSync(join(c.dataDir, "api-calls.jsonl"), "utf8");
    expect(JSON.parse(log.trim())).toMatchObject({ call: "market-order swap", ok: true, stderr: "warning: session expires soon" });
  });
});

describe("BawExecutor.quote", () => {
  it("keeps the quote's own slippage and stringifies numeric amounts", async () => {
    const ex = new BawExecutor(cfg(), async () => ok({ fromCoinSymbol: "USDT", fromCoinAmount: "3", toCoinSymbol: "T", toCoinAmount: 0.03, slippage: "0.005" }));
    expect(await ex.quote(args)).toMatchObject({ toAmount: "0.03", slippage: 0.005 });
  });
});
