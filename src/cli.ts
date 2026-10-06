import { parseArgs } from "node:util";
import { isAddress } from "viem";
import { BawExecutor } from "./adapters/baw.js";
import { lookupMarket } from "./adapters/market.js";
import { MockExecutor } from "./adapters/mock.js";
import { listBscTokens, resolveToken } from "./adapters/rwa.js";
import type { Executor } from "./adapters/types.js";
import { readFill } from "./chain.js";
import { loadConfig, type Config } from "./config.js";
import { openQty, parsePositive } from "./guards.js";
import { runAttempt, describeProviders, reconcileRow, sellQtyAfterBuy, type ReceiptReader } from "./probe.js";
import { summarize } from "./stats.js";
import { appendJsonl, fillsPath, floor8, ledger, readFills, renderTable } from "./store.js";
import { UNRESOLVED, type FillRecord, type Provider, type RwaToken } from "./types.js";

const HELP = `xfiler <command> [options]
  tokens     --provider ${describeProviders()}
  quote      --provider P --symbol S --usd N            quote only, nothing is sent
  fill       --provider P --symbol S --usd N [--live] [--roundtrip]
                                                        buy, then (with --roundtrip) sell it back
  sell       --provider P --symbol S [--qty N] [--live] sell what the ledger says we hold (default: all of it)
  reconcile  [--id ROW (--orderId OID | --mark-failed)] re-poll unresolved orders and record the outcome
  report     [--markdown] [--mode fills|quotes]         aggregate stats (quotes = quote-only data), or the markdown table
Dry-run is the default. A real order needs --live AND LIVE=1 in .env, and passes the caps and kill-switch.
New live orders are refused while any order is unresolved (SUBMITTING / PENDING / UNKNOWN): run reconcile.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string" },
    symbol: { type: "string" },
    usd: { type: "string" },
    qty: { type: "string" },
    id: { type: "string" },
    orderId: { type: "string" },
    "mark-failed": { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    roundtrip: { type: "boolean", default: false },
    markdown: { type: "boolean", default: false },
    mode: { type: "string" },
  },
});

const cmd = positionals[0];
const provider = values.provider as Provider | undefined;

function exec(cfg: Config): Executor {
  return cfg.adapter === "mock" ? new MockExecutor() : new BawExecutor(cfg);
}

const readerFor = (cfg: Config): ReceiptReader => (hash, token, spent) =>
  readFill(cfg.bscRpcUrl, hash as `0x${string}`, token as `0x${string}`, cfg.walletAddress as `0x${string}`, spent as `0x${string}` | null);

/** Provider market status for each row; best-effort, real venue only (the mock stays offline). */
const marketFor = (cfg: Config) => (cfg.adapter === "baw" ? (t: RwaToken) => lookupMarket(t, cfg.dataDir) : undefined);

/** Live runs need the real venue and a well-formed wallet address (used to decode the receipt). */
function requireLiveSetup(cfg: Config): void {
  if (cfg.adapter === "mock") throw new Error("--live is refused with ADAPTER=mock: the mock venue never trades");
  if (!isAddress(cfg.walletAddress)) throw new Error("WALLET_ADDRESS must be a valid 0x address for live runs (it is how fills are decoded)");
}

/** Plain decimal input is floored exactly; anything else (e.g. 1e-3) goes through toFixed. */
const qtyArg = (raw: string) => (parsePositive("--qty", raw), floor8(/^\d*\.?\d*$/.test(raw.trim()) ? raw : Number(raw)));

function warnNoSell(buy: FillRecord, reason: string): void {
  const qty = buy.fillAmount && Number(buy.fillAmount) > 0 ? ` --qty ${floor8(buy.fillAmount)}` : " --qty <amount you hold>";
  const bar = "!".repeat(72);
  console.error(`${bar}\n!!! --roundtrip did NOT sell: ${reason}.\n!!! You may still hold ${buy.symbol}. To unwind:\n` +
    `!!!   npm run probe sell -- --provider ${buy.provider} --symbol ${buy.symbol}${qty} --live\n${bar}`);
}

async function reconcile(cfg: Config): Promise<void> {
  const rows = ledger(readFills(cfg.dataDir));
  const ex = exec(cfg);
  const reader = readerFor(cfg);
  const save = (r: FillRecord) => appendJsonl(fillsPath(cfg.dataDir), r);
  const open = rows.filter((r) => !r.dryRun && UNRESOLVED.includes(r.status));

  if (values.id) {
    const row = open.find((r) => r.id === values.id);
    if (!row) throw new Error(`no unresolved row with id ${values.id}`);
    if (values["mark-failed"]) {
      save({ ...row, status: "FAILED", error: "manual: marked FAILED by reconcile (no order found at the venue)", reconciledAt: new Date().toISOString() });
      console.log(`${row.id}: marked FAILED`);
      return;
    }
    if (!values.orderId) throw new Error("--id needs --orderId OID (found in your wallet's order history) or --mark-failed");
    const withId = { ...row, orderId: values.orderId };
    const done = await reconcileRow(withId, ex, reader);
    save(done ?? withId);
    console.log(`${row.id}: ${done ? done.status : "still PENDING (orderId recorded)"}${done?.error ? ` (${done.error})` : ""}`);
    return;
  }

  if (!open.length) console.log("nothing unresolved");
  for (const row of open) {
    if (!row.orderId) {
      console.log(`${row.id}: ${row.status} with no orderId. Check the wallet's order history, then:\n` +
        `  npm run probe reconcile -- --id ${row.id} --orderId <OID>    or    --id ${row.id} --mark-failed`);
      continue;
    }
    try {
      const done = await reconcileRow(row, ex, reader);
      if (done) save(done);
      console.log(`${row.id} (order ${row.orderId}): ${done ? done.status : "still PENDING"}${done?.error ? ` (${done.error})` : ""}`);
    } catch (e) {
      console.log(`${row.id} (order ${row.orderId}): poll failed, left as ${row.status}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function main() {
  const cfg = loadConfig();
  if (values.live) requireLiveSetup(cfg);

  if (cmd === "tokens") {
    if (!provider) throw new Error("--provider required");
    for (const t of await listBscTokens(provider, cfg.dataDir)) console.log(`${t.symbol}\t${t.ticker}\t${t.contractAddress}\tx${t.multiplier}`);
  } else if (cmd === "quote" || cmd === "fill") {
    if (!provider || !values.symbol) throw new Error("--provider, --symbol and --usd are required");
    const usd = parsePositive("--usd", values.usd);
    const token = await resolveToken(provider, values.symbol, cfg.dataDir);
    const live = cmd === "fill" && values.live;
    const base = { cfg, exec: exec(cfg), token, provider, liveFlag: live, readReceipt: readerFor(cfg), market: marketFor(cfg) };
    const buy = await runAttempt({ ...base, side: "buy", qty: usd.toFixed(6).replace(/\.?0+$/, ""), usd });
    console.log(JSON.stringify(buy, null, 2));
    if (values.roundtrip) {
      // Only sell what the receipt proved we received (> 0); anything else gets a loud warning.
      const qty = sellQtyAfterBuy(buy);
      if (qty) {
        const sell = await runAttempt({ ...base, side: "sell", qty, usd: buy.usdNotional });
        console.log(JSON.stringify(sell, null, 2));
        if (sell.status !== "FINISHED") warnNoSell(buy, `sell is ${sell.status}${sell.error ? ` (${sell.error})` : ""}`);
      } else if (buy.dryRun) {
        console.error(`--roundtrip: no sell, buy was ${buy.status} and nothing was sent, so nothing to unwind.`);
      } else {
        warnNoSell(buy, UNRESOLVED.includes(buy.status)
          ? `buy is ${buy.status} (run \`npm run probe reconcile\` first)`
          : buy.status === "FINISHED"
            ? `fill amount not decoded (${buy.error ?? "zero"}); check the wallet balance`
            : `buy is ${buy.status}`);
      }
    }
  } else if (cmd === "sell") {
    if (!provider || !values.symbol) throw new Error("--provider and --symbol are required");
    const token = await resolveToken(provider, values.symbol, cfg.dataDir);
    const held = floor8(openQty(ledger(readFills(cfg.dataDir)), token.contractAddress));
    const qty = values.qty !== undefined ? qtyArg(values.qty) : held;
    if (!(Number(qty) > 0)) throw new Error(`nothing to sell: ledger holds ${held} ${token.symbol}; pass --qty to sell tokens it does not know about`);
    if (Number(qty) > Number(held)) console.error(`note: --qty ${qty} is more than the ledger's ${held}: this sell gets the normal caps and cooldown`);
    const sell = await runAttempt({
      cfg, exec: exec(cfg), token, provider, side: "sell", qty, usd: 0, liveFlag: values.live, readReceipt: readerFor(cfg), market: marketFor(cfg),
    });
    console.log(JSON.stringify(sell, null, 2));
  } else if (cmd === "reconcile") {
    if (!values["mark-failed"]) requireLiveSetup(cfg); // re-polls the real venue and reads receipts
    await reconcile(cfg);
  } else if (cmd === "report") {
    const rows = readFills(cfg.dataDir);
    const mode = values.mode === "quotes" ? "quotes" : "fills";
    console.log(values.markdown ? renderTable(rows) : JSON.stringify(summarize(rows, {}, false, mode), null, 2));
  } else {
    console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
