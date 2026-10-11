# xfiler

**Before an AI agent buys a tokenized stock on BSC, it should know how that order is likely to fill.** Most tokenized-stock tools work from quotes or simulation. xfiler is built to make **real BSC mainnet micro-trades** ($3 to $5) on bStocks, Ondo and xStocks, record what actually happened (quote price vs fill price, latency, failures, the tx hash of every order), and serve the result to other agents through a read-only MCP tool, `get_fill_stats`.

Entry for **BNB Hack: Tokenized Stocks Edition**. MIT licensed.

## Status (11 Oct 2026): read this first

| | |
|---|---|
| Code | Complete: probe, safety gates, order-lifecycle tape, `sell`, `reconcile`, receipt decoding with a balance fallback, provider market status, quote-only mode, MCP server, Wallet Skill descriptor. 60 tests passing, `tsc` clean. |
| Binance token list | **Verified live** (through a VPN, see below). |
| MCP server | **Verified**: starts over stdio, lists `get_fill_stats`, answers in both modes. |
| `baw` sign-in | Working (through a VPN). |
| Quotes from the real venue | **11 real quotes** on Sat 10 Oct across all three providers (8 usable, 3 refused), in `data/fills.jsonl`. |
| Live fills | **One real round trip on BSC mainnet** (bStocks TSLAB, $2, over the weekend): [buy](https://bscscan.com/tx/0xfee463ca1b7a8c2f612b377497968192f909dd0fd971b00aa30660a48f6e218b) and [sell](https://bscscan.com/tx/0x5026caa070e7632534b4a119218615a099a274047a7ffa5592675532078369b2), both in `data/fills.jsonl`. |

**Nothing in `data/fills.jsonl` counts as real data unless the row has a tx hash you can open on BscScan.** Two rows do. One round trip is an anecdote, not a distribution, and the README says so wherever it uses it. Every number in this README comes from a logged call or a transaction, not from an estimate.

### The live round trip (bStocks TSLAB, US market closed)

| | Buy, Sat 10 Oct 22:06 UTC | Sell, Sun 11 Oct 12:41 UTC |
|---|---|---|
| Tx | [`0xfee463ca…a48f6e218b`](https://bscscan.com/tx/0xfee463ca1b7a8c2f612b377497968192f909dd0fd971b00aa30660a48f6e218b) | [`0x5026caa0…078369b2`](https://bscscan.com/tx/0x5026caa070e7632534b4a119218615a099a274047a7ffa5592675532078369b2) |
| Sent / received | 2.00 USDT / 0.00522601 TSLAB | 0.00522601 TSLAB / 2.00275623 USDT |
| Fill price (from the receipt) | $382.70 | $383.23 |
| vs quote | 0.9 bps better | 6.5 bps worse |
| Venue order status | still `PENDING` after 2 min of polling and over an hour later | still `PENDING` after 2 min of polling |

- **The venue's order status lagged the chain.** Both swaps settled on chain within seconds, but `market-order list` kept saying `PENDING`. xfiler did what it is built to do: it recorded the order as unresolved and refused to sell (or place any other order) until it was resolved. Both rows were then resolved from the chain with `reconcile --txHash`, which only accepts a hash whose receipt proves the fill (`resolvedBy: "receipt"` on the row).
- **The sign-in session expired** between the buy and the sell (`SESSION_EXPIRED`, code 10003002, "Please log in first."), less than about 8 hours after the first successful call, with no warning before a trade was attempted.
- Round trip: 2.00 USDT out, 2.00275623 USDT back (the price moved between the two trades), plus about 0.00016 BNB of gas for both swaps.

## Findings so far

1. **Binance is blocked by Nigerian mobile carriers; the Binance phone app is not.** From the builder's machine in Nigeria, `www.binance.com`, `web3.binance.com` and `api.binance.com` all fail. On Airtel the connection times out; on MTN the DNS lookup itself times out. The phone browser fails too. The BNB Chain RPC (`bsc-dataseed.bnbchain.org`), BscScan and GitHub all work, and the Binance app on the same phone works on both carriers. So the developer tools (`baw`, the public APIs) were unreachable, while the consumer app was not.
   - **To keep building, the laptop tools run through a VPN** whose exit country is not on the hackathon's or Binance's restricted lists. Disclosed here on purpose.
   - Node's error for this was only `TypeError: fetch failed`; the real cause (`UND_ERR_CONNECT_TIMEOUT`) is hidden inside it. Each failed call took about 10.8 s (`data/api-calls.jsonl`).
2. **xStocks do exist on BSC through this API.** The two official skills disagree about which providers exist (the securities-info skill names only Ondo). The token-list endpoint, live on 10 Oct, returned BSC tokens for all three: about 450 Ondo (`type=1`), about 130 xStocks (`type=2`) and 91 bStocks (`type=3`). The same response also lists non-BSC tokens (chain `CT_501`), which xfiler filters out.
3. **The same stock exists under all three providers**, e.g. Tesla as `TSLAon` (Ondo), `TSLAB` (bStocks) and `TSLAx` (xStocks), each with a share multiplier of 1. This makes side-by-side comparison possible.

### Quotes, Saturday 10 Oct (US market closed)

All quotes are dry-run: nothing was sent. "vs reference" compares the quote's implied price with the provider's own reference price (RWA dynamic API); positive = worse for the trader.

| Provider, token | Size | Result | vs reference |
|---|---|---|---|
| Ondo `TSLAon` | $5 buy (x2) | quoted | +20.0 bps |
| Ondo `TSLAon` | $3, $1 buy | **refused**: `From token value greater than 5 USD` | - |
| Ondo `TSLAon` | ~$4.93, ~$5.54 sell | quoted | +20.5, +19.9 bps |
| bStocks `TSLAB` | $5 (x2), $3 buy | quoted | +1.4, +0.4, -0.5 bps |
| xStocks `TSLAx` | $5 buy | **refused**: `No liquidity available, please try again later.` | - |
| xStocks `SPYx` | $5 buy | quoted at **$8,963 per token** | **~11.6x the ~$772 reference** |

4. **Minimum trade size: $5 on Ondo buys, not documented anywhere.** The error says "greater than 5 USD", which reads as if the amount is too big. bStocks accepted $3, and an Ondo sell worth about $4.93 was quoted, so the limit seems to apply to buys.
5. **Weekend behaviour differs by provider.** All three report `MARKET_CLOSED: Weekend or Holiday`, yet Ondo and bStocks quote; xStocks had no liquidity for Tesla. Ondo's asset status was `offhours` with reason `TRADING`. `offhours` is not among the documented values, and the asset-status API answered for Ondo only.
6. **bStocks quoted far tighter than Ondo** for the same stock (about 1 bps vs 20 bps from the reference), and faster (2.0 to 6.0 s vs 2.5 to 10.0 s per quote).
7. **A quote can be wildly off while looking normal.** The SPYx quote carried `slippage: 0.01` like every other quote; only the comparison with the reference price shows that $5 would have bought about $0.43 of value. xfiler records this comparison on every row (`vsReferenceBps` in quote mode).
8. **Quotes work with an empty wallet**, and they are slow: `baw market-order quote` took 1.9 to 10.0 s (median about 3 s, 11 calls); the RWA endpoints mostly 1.1 to 1.4 s; the token list 1.4 to 5.4 s. All through a VPN, so part of this is the VPN.

## For judges: how to check this entry

No wallet, funds or Binance account is needed for steps 1 to 3.

```bash
git clone https://github.com/Turnless/xfiler && cd xfiler
npm install
npm test             # 60 tests: gates, order lifecycle, receipts, stats, MCP schema (fake venue, no network)
npm run typecheck
```

1. **Read the tape**: `data/fills.jsonl`. Every live row has a `txHash`; open `https://bscscan.com/tx/<txHash>` to check it.
2. **Run the report**: `npm run probe report -- --markdown` (the table), or `npm run probe report -- --mode quotes` (quote-only stats).
3. **Call the MCP tool** from an agent (setup below), e.g. `get_fill_stats({ provider: "ondo", session: "regular" })`. With no fills it says so instead of reporting zero.
4. **List live tokens** (needs network access to `www.binance.com`): `npm run probe tokens -- --provider xstock`.

Placing a real order needs the Binance Agentic Wallet CLI (`baw`), a signed-in and funded wallet, `LIVE=1` in `.env` **and** `--live` on the command line. Judges do not need to do this.

## MCP tool / Wallet Skill

`get_fill_stats` is read-only: it can never place an order. Add it to an MCP client (e.g. `.mcp.json` for Claude Code), with the absolute path to your clone:

```json
{
  "mcpServers": {
    "xfiler": {
      "command": "node",
      "args": ["--import", "file:///ABSOLUTE/PATH/xfiler/node_modules/tsx/dist/loader.mjs", "/ABSOLUTE/PATH/xfiler/src/mcp.ts"]
    }
  }
}
```

On Windows the paths look like `file:///C:/path/to/xfiler/node_modules/tsx/dist/loader.mjs` and `C:/path/to/xfiler/src/mcp.ts` (forward slashes). Run `npm install` first.

- Why not `npx tsx`: it works, but it took over 10 s to start on the test machine, and through `cmd /c npx` on Windows Claude Code gave up after its 30 s startup limit. Starting `node` with the tsx loader took about 1.6 s.
- Do not use `npm run mcp` in a client config: npm prints a banner to stdout, which breaks the MCP stream. (`npm run mcp` is fine for running it by hand.)
- Tested on 10 Oct with Claude Code (`claude -p ... --mcp-config`): the agent connected, called `get_fill_stats` once for fills and once per provider in quotes mode, said there was no fill data, and preferred bStocks for TSLA from the quote numbers.

`get_fill_stats({ provider?, symbol?, session?, providerSession?, side?, mode? })`:

- `mode: "fills"` (default): attempts, filled, failed, `pending` (unresolved), `quoteFailures`, success rate, slippage vs quote (median / p95 / worst, bps; with fewer than 20 fills p95 is the max), settle latency, failure reasons as short codes (e.g. `SLIPPAGE`, `POLL_TIMEOUT`, `SWAP_REJECTED`; the raw text stays in the row) and the last 50 tx hashes. If the tape file is missing it returns an error rather than "0 attempts".
- `mode: "quotes"`: the fallback when there are no live fills. Quote-only rows from the real venue (never mock rows): quote count, usable vs failed, quote latency median / p95, quote failure codes, and quote price vs the provider's reference price in bps (`vsReferenceBps`, positive = worse for the trader). Its note says plainly that no fill occurred.

The Wallet Skill descriptor, telling an agent when to call the tool and how to read the answer, is in [`skill/xfiler/SKILL.md`](skill/xfiler/SKILL.md).

## How it works

```
quote (+ market status, in parallel) ──> check quote ──> gates ──> balance snapshot ──> SUBMITTING row ──> swap
  ──> PENDING row ──> poll to terminal ──> balance snapshot ──> read receipt (balance delta as fallback) ──> terminal row
```

- **Quote and order**: `baw market-order quote | swap | list` (Binance Agentic Wallet CLI, npm `@binance/agentic-wallet`). `success: true` on a swap only means *submitted*; the order is polled until `FINISHED` or `FAILED` (any other status counts as pending).
- **Append-only tape**: a live order writes a `SUBMITTING` row *before* the swap is sent, a `PENDING` row once it has an orderId, and a terminal row with the same `id`. Stats, the table and the gates read the **last row per id**. A crash or Ctrl-C leaves an unresolved row, not a lost order.
- **Fill price**: decoded from the BSC receipt, not taken from the quote: the wallet's *net* flow of the received token (in minus out). The tx must have succeeded, a buy must also show USDT leaving `WALLET_ADDRESS` (proves the address is right), and a net amount of 0 is an error. Gas used and effective gas price are recorded. The BSC RPC is reached directly, so this part does not depend on Binance's servers.
- **Balance snapshots** (fallback fill source): before and after each live order, `baw wallet balance --binanceChainId 56 --json` is read and a compact snapshot (USDT, the stock token, BNB) is stored on the row. If the receipt cannot be decoded, the balance delta of the received token becomes the fill (`fillSource: "balance"`). If both exist and differ by more than 1%, the receipt is kept and `fillMismatchError` says so. A snapshot failure never blocks an order.
- **Session label**: US equity session in New York time (regular / pre / post / overnight / weekend). Holidays are not modelled.
- **Provider market status**: each row also records the provider's own view at quote time (open/closed, per-asset status with reasons such as `ASSET_PAUSED: cash_dividend`, the provider's session label, and a reference price). Best-effort with an 8 s timeout. The open/closed and session fields never gate an order; the **reference price does** (see `QUOTE_VS_REFERENCE` below).
- **Raw samples**: the first raw `quote`, `swap` and `list` response per provider and side goes to `data/raw/` (never overwritten), with secret-looking keys and JWT-looking values redacted. Git-ignored until reviewed by hand.
- **No keys in this repo.** Signing happens inside the Agentic Wallet.

### Row status

| status | meaning |
|---|---|
| `DRY_RUN` | quote only; nothing sent |
| `QUOTE_FAILED` | the quote was unusable (error, no amount > 0, or its slippage above `MAX_QUOTE_SLIPPAGE`); nothing sent, kept as data |
| `ABORTED` | a gate refused the order, or it was refused locally before sending |
| `SUBMITTING` | written just before the swap; as the last row for an id it means the outcome is unknown |
| `PENDING` | the venue has the order but it was not terminal when polling stopped |
| `UNKNOWN` | something broke after the order may have been sent (swap timeout, poll errors, Ctrl-C) |
| `FINISHED` | the venue says done. If the receipt could not be read or decoded it stays `FINISHED` with `error: "receipt decode failed: ..."` |
| `FAILED` | the venue said FAILED, or rejected the swap outright (`success: false`) |

`SUBMITTING`, `PENDING` and `UNKNOWN` are **unresolved**: they count toward open exposure and block every new live order (`UNRESOLVED_ORDER`) until `reconcile` resolves them.

### Safety gates (checked before every live order)

Dry-run by default (needs `--live` **and** `LIVE=1`), `MOCK_ADAPTER`, `UNRESOLVED_ORDER`, `KILL_SWITCH_ACTIVE`, `QUOTE_VS_REFERENCE` / `NO_REFERENCE_PRICE`, then `PER_FILL_CAP` ($5), `BAD_AMOUNT`, `OPEN_EXPOSURE_CAP` ($8, buys), `BUDGET_EXHAUSTED` ($3 estimated loss), `DAILY_COUNT_CAP` (12), `COOLDOWN_ACTIVE` (20 s). Ported in spirit from the builder's earlier project, [Cinder](https://github.com/Turnless/Cinder).

- A **sell that closes a position the ledger knows about** skips the caps, budget, daily count and cooldown, so a cap never blocks getting out.
- **Kill-switch**: a `KILL` file in the project root, or `KILL_SWITCH=1`. If the check itself errors, it fails closed.
- **Quote vs reference** (added 10 Oct, after the live SPYx quote came back at 11.6x its reference while its own `slippage` field looked normal): a live order is refused (`QUOTE_VS_REFERENCE`) when the quote is more than `MAX_VS_REFERENCE_BPS` (default 100 = 1%) worse than the provider's reference price. With no reference price to compare with it is refused too (`NO_REFERENCE_PRICE`), unless `REQUIRE_REFERENCE_PRICE=false`. It also applies to a sell that closes a position: selling far below the reference would give the position away. Replayed on the 15 real quotes of 10 Oct, it blocks only the SPYx one (Ondo about +20 bps and bStocks within ±6 bps pass). The quote is still recorded as data.
- **Slippage**: `SLIPPAGE` is a percent passed to `baw` (default 1, max 3). The order is refused if the quote's own slippage field is above `MAX_QUOTE_SLIPPAGE`.

## Run it

```bash
npm install
cp .env.example .env            # set WALLET_ADDRESS; leave LIVE=0 at first
npm run probe tokens -- --provider ondo
npm run probe quote  -- --provider ondo --symbol TSLAon --usd 3        # dry-run, sends nothing
npm run probe fill   -- --provider ondo --symbol TSLAon --usd 3 --live --roundtrip   # real money, needs LIVE=1
npm run probe sell   -- --provider ondo --symbol TSLAon [--qty N] --live   # sell what the ledger holds (default: all)
npm run probe reconcile                                                    # re-poll SUBMITTING / PENDING / UNKNOWN orders
npm run probe report -- --markdown
npm run probe report -- --mode quotes
npm run mcp
npm test
```

- `--roundtrip` sells only what the receipt proved was received. Whenever it does not sell, it prints a loud warning with the exact `sell` command to unwind.
- `reconcile` re-polls each unresolved order and appends a corrected row. A row with no orderId cannot be polled: find the order in the wallet's history and run `reconcile -- --id <row id> --orderId <OID>`, or `--mark-failed` if no order exists.
- The fake venue (`ADAPTER=mock`) is for tests only: its rows are ignored by stats, the table and the gates, and `--live` is refused with it.

## Verified vs unverified

**Verified live:** the RWA token-list endpoint and its `type` filter (1 Ondo, 2 xStocks, 3 bStocks), with BSC tokens for all three providers; the MCP server over stdio; BSC RPC reachability; `baw auth signin` returning a QR code through the VPN.

**Verified from the official `binance-skills-hub` docs (not yet live):** the `baw market-order` command shapes, the order lifecycle, the BSC USDT address, and that a swap returns only an `orderId`.

**Verified live on 10 Oct:** the real quote response shape (`data/raw/`), the $5 minimum on Ondo buys, weekend quoting for Ondo and bStocks.

**Not verified yet:** real swap / list response shapes; whether a weekend or off-hours order actually executes; the minimum on sells and on bStocks; whether `baw` needs BNB for gas; whether a sell needs an approval transaction.

Assumed by the code, to be checked on the first real calls:
- The quote's `slippage` field is a fraction. If it is a percent, every quote is refused by `MAX_QUOTE_SLIPPAGE` (fails safe, but blocks trading until fixed).
- `swap` answers `success: false` only when no order was created (recorded `FAILED`). Any other error after sending is recorded `UNKNOWN`.
- The wallet's own address appears in the swap's `Transfer` logs. If not, buys show `receipt decode failed` and the balance-delta fallback supplies the fill.
- `wallet balance --binanceChainId 56` returns a list of `{ symbol, address, binanceChainId, balance, ... }`.

## Limits, stated plainly

- Sizes are $3 to $5. Slippage at larger sizes will differ.
- With fewer than 5 attempts per filter, the stats say "anecdote", and they mean it.
- The tool measures one wallet from one location (Nigeria, through a VPN). Latency includes the VPN.
- US market holidays are not modelled in the session label.

## Layout

```
src/cli.ts       commands: tokens, quote, fill, sell, reconcile, report
src/probe.ts     one attempt end to end; reconcile logic       src/guards.ts   gates, positions, loss budget
src/chain.ts     fill amount from the BSC receipt (viem)       src/stats.ts    what get_fill_stats returns
src/store.ts     tape, last row per id, table, raw samples     src/session.ts  US session labels
src/tool.ts      MCP tool schema + handler                     src/mcp.ts      stdio MCP server
src/config.ts    settings from .env                            src/adapters/   baw, mock, token list, market status
test/            60 tests (fake venue, fake receipts, fake CLI runner)
skill/xfiler/    Wallet Skill descriptor
devex/           raw notes for the DevEx report
```

Not committed: `.env`, `KILL`, `data/api-calls.jsonl` and `data/raw/` (see `.gitignore`).
