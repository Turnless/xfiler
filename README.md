# xfiler

Tokenized-stock tools on BSC mostly work from quotes or simulation. xfiler makes **real mainnet micro-trades** ($3 to $5) on bStocks, Ondo and xStocks, in and out of US market hours, and records what actually happened: quote price vs fill price, latency, failures, and the tx hash for every order. The table is published, and an MCP tool, `get_fill_stats`, lets other agents check it before they trade.

> Status: scaffold. No live trade has been made yet, and nothing here has been run against `baw` or BSC: only the tests (fake venue, fake receipts) have run. `data/fills.jsonl` is empty until the first real fill. Nothing in this repo is real data until a row has a tx hash you can open on BscScan.

## How it works

```
quote (+ market status, in parallel) ──> check quote ──> gates ──> balance snapshot ──> SUBMITTING row ──> swap
  ──> PENDING row ──> poll to terminal ──> balance snapshot ──> read receipt (balance delta as fallback) ──> terminal row
```

- **Quote and order**: `baw market-order quote | swap | list` (Binance Agentic Wallet CLI, npm `@binance/agentic-wallet`). `success: true` on a swap only means *submitted*; the order is polled until `FINISHED` or `FAILED` (any other status counts as pending).
- **Append-only tape**: a live order writes a `SUBMITTING` row *before* the swap is sent, a `PENDING` row once it has an orderId, and a terminal row with the same `id`. Stats, the table and the gates read the **last row per id**. A crash or Ctrl-C leaves an unresolved row, not a lost order.
- **Fill price**: decoded from the BSC receipt, not taken from the quote: the wallet's *net* flow of the received token (in minus out). The tx must have succeeded, a buy must also show USDT leaving `WALLET_ADDRESS` (proves the address is right), and a net amount of 0 is an error. Gas used and effective gas price are recorded.
- **Balance snapshots** (fallback fill source): before and after each live order, `baw wallet balance --binanceChainId 56 --json` is read and a compact snapshot (USDT, the stock token, BNB) is stored on the row (`balancesBefore` / `balancesAfter`, plus `usdtDelta` and `bnbDelta`). The after-snapshot is retried briefly because balances can lag. If the receipt cannot be decoded (or shows no net inflow), the balance delta of the received token becomes the fill (`fillSource: "balance"`, the receipt problem in `receiptError`). If both exist and differ by more than 1%, the receipt is kept and `fillMismatchError` says so. A snapshot failure never blocks an order; it is noted in `balanceError`. `baw` hides balances under $0.01, so a hidden balance reads as 0.
- **Session label**: US equity session in New York time (regular / pre / post / overnight / weekend). Holidays are not modelled.
- **Provider market status**: next to the New York label, each row records the provider's own view at quote time, from the securities-info APIs (Market Status, Asset Market Status, RWA Dynamic): `marketStatus` (open/closed) and `marketReason`, `assetStatus` and `assetReason` (e.g. `ASSET_PAUSED: cash_dividend`, `ASSET_LIMITED: earnings`), `providerSession` (premarket / regular / postmarket / overnight / closed / pause) and `referencePrice` (`tokenInfo.price / sharesMultiplier`, per share, with `referenceMultiplier`). It runs in parallel with the quote with an 8 s timeout and is best-effort: on failure the fields are null and `marketError` says why. It is documented for Ondo; other providers may get nothing. **The gates do not use it.**
- **Raw samples**: the first raw `quote`, `swap` and `list` response per provider and side from the real venue goes to `data/raw/<provider>-<side>-<kind>.json` (never overwritten), with values under keys containing token / session / secret / key / auth / clientId / signature and similar, and JWT-looking strings, replaced by `[REDACTED <type>]`. This is the evidence for the real response shapes. `data/raw/` is git-ignored because those shapes are unverified and could carry identifiers nobody anticipated; review a file before force-adding it.
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

`SUBMITTING`, `PENDING` and `UNKNOWN` are **unresolved**: unresolved buys count in full toward open exposure, and any unresolved order blocks every new live order (`UNRESOLVED_ORDER`) until `reconcile` resolves it.

### Gates (checked before every live order)

Dry-run by default (needs `--live` **and** `LIVE=1`), `MOCK_ADAPTER` (`--live` is refused with `ADAPTER=mock`), `UNRESOLVED_ORDER`, `KILL_SWITCH_ACTIVE`, then `PER_FILL_CAP`, `BAD_AMOUNT`, `OPEN_EXPOSURE_CAP` (buys), `BUDGET_EXHAUSTED`, `DAILY_COUNT_CAP`, `COOLDOWN_ACTIVE`. Ported in spirit from Cinder's pre-trade gates.

A **sell that closes a position the ledger knows about** (net finished buys minus sells, for that token) skips the caps, budget, daily count and cooldown. Only dry-run, mock-adapter, unresolved-order and kill-switch apply, so a cap never blocks getting out.

- **Loss budget** (`BUDGET_USD`, default 3): USDT spent minus USDT received on closed buy/sell pairs (taking the worse of the receipt and the USDT balance delta, which includes fees), plus quote-to-fill drift on what is still open, plus gas if `BNB_USD` is set (the larger of receipt gas and the BNB balance drop). It is an estimate from our own ledger, not a wallet balance.
- **Kill-switch**: a `KILL` file in the project root, or `KILL_SWITCH=1` / `true` / `yes`. If the file check itself errors (e.g. permissions) it fails closed (`KILL_SWITCH_FAIL_CLOSED=true`). It is checked once before each order and cannot recall an order already sent.
- **Slippage**: `SLIPPAGE` is a percent passed to `baw` (default `1`; above `3`, or `auto`, is refused at startup). The quote's own slippage field is stored as `quoteSlippage`, and the order is refused if it is above `MAX_QUOTE_SLIPPAGE` (a fraction, default `0.01`).

## Run it

```bash
npm install
cp .env.example .env            # set WALLET_ADDRESS; leave LIVE=0 at first
npm run probe tokens -- --provider ondo
npm run probe quote  -- --provider ondo --symbol <SYMBOL> --usd 3        # dry-run, sends nothing
npm run probe fill   -- --provider ondo --symbol <SYMBOL> --usd 3 --live --roundtrip   # real money, needs LIVE=1
npm run probe sell   -- --provider ondo --symbol <SYMBOL> [--qty N] --live   # sell what the ledger holds (default: all)
npm run probe reconcile                                                      # re-poll SUBMITTING / PENDING / UNKNOWN orders
npm run probe report -- --markdown
npm run probe report -- --mode quotes                                         # quote-only stats (no fills needed)
npm test
```

- `--roundtrip` sells only what the receipt proved was received (> 0, rounded down to 8 decimals). Whenever it does not sell, it prints a loud warning with the exact `sell` command to unwind.
- `sell` defaults to the ledger's net open quantity for that token (finished buys minus finished and unresolved sells, rounded down to 8 decimals) and refuses if that is 0. A `--qty` above it is allowed but gets the normal gates.
- `reconcile` re-polls each unresolved order with `market-order list --orderId` and appends a corrected row, decoding the receipt if it finished. A row with no orderId (crash before the swap answered) cannot be polled: find the order in the wallet's history and run `reconcile -- --id <row id> --orderId <OID>`, or `reconcile -- --id <row id> --mark-failed` if no order exists.
- `--usd` and `--qty` must be finite numbers > 0. Live runs need a valid `WALLET_ADDRESS`.

The fake venue (`ADAPTER=mock`) exists for tests only: its rows are tagged `adapter: "mock"` and ignored by stats, the table and the gates, and `--live` is refused with it. `quote`, `fill` and `sell` still call the live token-list endpoint to resolve the symbol.

## MCP tool / Wallet Skill

`npm run mcp` starts a stdio MCP server with one read-only tool:

`get_fill_stats({ provider?, symbol?, session?, providerSession?, side?, mode? })` with `mode: "fills"` (default) returns attempts, filled, failed, `pending` (unresolved), `quoteFailures`, success rate, slippage vs quote (median/p95/worst, bps; with fewer than 20 fills p95 is the max), settle latency, failure reasons as short codes (e.g. `SLIPPAGE`, `POLL_TIMEOUT`, `SWAP_REJECTED`; the raw text stays in the row) and the last 50 tx hashes. If the tape file is missing it returns an error rather than "0 attempts". It cannot place orders.

`mode: "quotes"` is the fallback when there are no live fills: it aggregates quote-only rows from the real venue (`DRY_RUN`, `QUOTE_FAILED`, and dry-run `ABORTED` rows that still carry a quote; never mock rows): quote count, usable vs failed, quote latency median/p95, quote failure codes, and quote price vs the provider's reference price in bps (`vsReferenceBps`, positive = worse for the trader, only for rows where the market lookup returned a reference). Its note says plainly that no fill occurred. A Wallet Skill descriptor is in [`skill/xfiler/SKILL.md`](skill/xfiler/SKILL.md).

## Verified vs unverified

Verified (from the official `binance-skills-hub` repo, read directly): the `baw market-order` command shapes, the order lifecycle, the BSC USDT address, the RWA token-list endpoint and its `type` filter (1 Ondo, 2 xStocks-style, 3 bStock), and that a swap returns only an `orderId`.

Not verified (could not reach `web3.binance.com` or `www.binance.com` from the build machine): the **minimum trade size** (docs I could read only give a *maximum*, `maxActiveNotionalValue`), real response shapes, whether xStocks exist on BSC through this API, whether each provider trades outside US hours, and whether `baw` needs BNB for gas. The first dry-run quotes at $1, $3 and $5 settle the minimum-size question; record the answer in `devex/OBSERVATIONS.md`.

Assumed by the code, to be checked on the first real calls:
- `swap` answers `success: false` only when no order was created (recorded `FAILED`). Any other error after sending (timeout, unreadable output, no orderId) is recorded `UNKNOWN`.
- The quote's `slippage` field is a fraction. If it is a percent, every quote is refused by `MAX_QUOTE_SLIPPAGE` (fails safe, but blocks trading until fixed).
- `list` items carry `orderId`, `status`, `txHash` as documented. A missing order is treated as still pending.
- The wallet's own address appears in the swap's `Transfer` logs. If the Agentic Wallet trades through another account, every buy will show `receipt decode failed` until `WALLET_ADDRESS` is that account (the balance-delta fallback then supplies the fill).
- `wallet balance --binanceChainId 56` returns `data` as a list of `{ symbol, address, binanceChainId, balance, ... }` as in `references/wallet-view.md`, with native BNB under `0xEeee…EEeE`. Not seen live.
- The securities-info Market Status / Asset Market Status / RWA Dynamic responses match the skill's documented examples. Not seen live, and documented for Ondo only.

## Repo status

Local git repository (branch `main`), no commits yet, no remote. MIT licensed (`LICENSE`). Not committed: `.env`, `KILL`, `data/api-calls.jsonl` and `data/raw/` (see `.gitignore`).

## Layout

```
src/guards.ts   gates, ledger positions, loss budget     src/probe.ts   one attempt end to end; reconcile
src/stats.ts    what get_fill_stats returns              src/adapters/  baw, mock, token list
src/session.ts  US session labelling                     src/chain.ts   fill amount from the receipt
src/store.ts    tape, last row per id, raw samples       src/mcp.ts     MCP server (schema in src/tool.ts)
src/adapters/market.ts  provider market status, reference price (best-effort)
devex/          notes for the DevEx report
```
