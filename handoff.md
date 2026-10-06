# xfiler: handoff

Written 6 Oct 2026 for a fresh session. Read this first, then `README.md`.

## The project in one paragraph

**xfiler** (repo: https://github.com/Turnless/xfiler) is an entry for **BNB Hack: Tokenized Stocks Edition**. It makes real BSC mainnet micro-trades ($3 to $5) on bStocks, Ondo and xStocks, in and out of US market hours, and logs quote price vs fill price, latency, route (if exposed), failures and tx hashes to an append-only tape (`data/fills.jsonl`). The table is published and exposed as a read-only MCP tool / Wallet Skill, `get_fill_stats`, that other agents call before trading. Why it should win: the other entries (Bystok, Closing Bell Agent, Bellproof, Parity, OneTicker, StockGrid AI, Stokss) work from quotes or simulation; OneTicker's README says no funded mainnet trade yet; StockGrid AI has no tx hashes.

## Who and constraints

- Builder: Abdulsalam Hassan, solo, Nigeria (UTC+1, WAT), builds in the evenings, very little spare money (about $10 to $15 for fills). Still learning to code: explain in plain language, keep it short.
- Tracker: Google Sheet "Hackathon Tracker", ID `1gWSIvcmGqj7Wm7vk0Us-3MRFvgiHOmzjBfkFRY0ufNI` (tabs Tracker, October plan, Fresh ideas).
- Ideas are not fully formed until built: keep building, no more research sessions.
- **The DevEx report must be written by the builder in their own words. AI-written reports are rejected. Help collect data and outline; never draft its prose.**
- Never run `baw`, sign in, use `--live`, or place a trade on the builder's behalf. Sign-in needs them to scan a QR in the Binance app. Every live fill is their decision.

## Hackathon facts

| Item | Value |
|---|---|
| Deadline | 11 Oct 2026 12:00 UTC (13:00 WAT). Plan to submit Sat 10 Oct by 20:00 WAT |
| Prize | $20,000. Side prizes: Agentic Wallet / Wallet Skills ($2,000), BNB Agent Studio ($2,000) |
| Rules | BSC mainnet, spot only, at least one of bStocks / Ondo / xStocks central |
| Judging | technical 30%, creativity 25%, **DevEx report 25%**, product and UX 20% |
| Required | public repo, demo video up to 4 min, deployed link (or judging instructions), DevEx report |
| Page | https://bnbchain.org/en/hackathons/tokenized-stocks |
| Forms | DevEx template https://forms.gle/EUQ39xf54GHjC2ys5, submission https://forms.gle/yToDUzaDMwWnq6R6A |
| Not eligible | residents of US, Canada, Netherlands, Iran, Cuba, North Korea, Crimea/Donetsk/Luhansk, UK, Japan |

## Current state

- **Built and committed locally** (one commit on `main`, nothing pushed yet at the time of writing): the probe, the safety gates, the order-lifecycle tape, `sell` and `reconcile`, receipt decoding with a wallet-balance fallback, provider market-status lookup, raw-response samples, quote-only stats mode, the MCP server, a Wallet Skill descriptor, 60 tests.
- **Verified:** `npx tsc --noEmit` clean, `npx vitest run` 60/60 passing.
- **NOT verified: nothing has run against `baw`, Binance, or BSC.** All tests use a fake venue, fake receipts and a fake CLI runner. `data/fills.jsonl` is empty. There is no real data yet.
- **Manual steps not done as of this handoff** (none were reported complete): install `baw`, sign in, wallet settings check, dry-run quotes, funding, first live fill.

## How it works

```
quote -> check quote -> gates -> SUBMITTING row -> swap -> PENDING row -> poll to terminal -> read receipt -> terminal row
```

- Venue: `baw market-order quote | swap | list --json` (npm `@binance/agentic-wallet`). A swap returns only an `orderId`; success means *submitted*. Poll `list --orderId` until `FINISHED` or `FAILED`.
- Fill price comes from the BSC receipt (net token flow to the wallet, tx must have succeeded, a buy must show USDT leaving the wallet). Wallet balance before/after is the fallback (`fillSource: "balance"`); a >1% receipt/balance mismatch is flagged on the row.
- Rows are append-only; readers take the **last row per id**. Statuses: `DRY_RUN`, `QUOTE_FAILED`, `ABORTED`, `SUBMITTING`, `PENDING`, `UNKNOWN`, `FINISHED`, `FAILED`. `SUBMITTING`/`PENDING`/`UNKNOWN` are unresolved and block new live orders until `reconcile`.
- Gates (ported from the builder's earlier project Cinder): dry-run by default (needs `--live` AND `LIVE=1`), mock-adapter refusal, unresolved-order block, kill-switch (`KILL` file or `KILL_SWITCH=1/true/yes`, fails closed), per-fill cap, exposure cap, loss budget, daily count, cooldown. A sell closing a known position skips caps, budget, daily count and cooldown.
- Session label: US equity session in New York time (regular, pre, post, overnight, weekend). Holidays not modelled. WAT = ET + 5h until 1 Nov (EDT).

### Files

```
src/cli.ts        commands: tokens, quote, fill, sell, reconcile, report
src/probe.ts      one attempt end to end, reconcile logic
src/guards.ts     gates, exposure, loss budget, kill-switch
src/chain.ts      receipt decoding via viem
src/stats.ts      what get_fill_stats returns (fills and quotes modes)
src/store.ts      tape read/write, markdown table, raw samples
src/tool.ts       MCP tool schema + handler    src/mcp.ts   stdio MCP server
src/session.ts    US session labels            src/config.ts  env loading, constants
src/adapters/     baw.ts, mock.ts, rwa.ts (token list), market.ts (provider market status), types.ts
test/             4 files, 60 tests            devex/  OBSERVATIONS.md (raw log), OUTLINE.md (report outline)
skill/xfiler/SKILL.md   Wallet Skill descriptor
```

### Commands

```bash
npm install
cp .env.example .env              # set WALLET_ADDRESS, keep LIVE=0
npm run probe tokens -- --provider ondo
npm run probe quote  -- --provider ondo --symbol <SYMBOL> --usd 3          # dry-run
npm run probe fill   -- --provider ondo --symbol <SYMBOL> --usd 3 --live   # real money, needs LIVE=1
npm run probe sell   -- --provider ondo --symbol <SYMBOL> --live
npm run probe reconcile
npm run probe report -- --markdown      # or --mode quotes
npm run mcp                              # stdio MCP server, tool: get_fill_stats
npm test ; npm run typecheck
```

## Unverified, check on the first real calls

1. **Minimum trade size.** Not found in any doc. Docs only state a maximum (`limitInfo.maxActiveNotionalValue`). Settle it with dry-run quotes at $5, $3, $1. Decision rule from the plan: $3 quote works -> trade $3; error naming a minimum M <= $5 -> round M up to the next $0.50; M > $6 -> that provider is quote-only.
2. **Network.** `web3.binance.com` and `www.binance.com` timed out from the builder's machine (curl exit 28, WebFetch ECONNRESET), but GitHub worked. The token list and market status calls use `www.binance.com`. Check whether it is the builder's network (try a phone hotspot). Do not use a VPN to get around jurisdiction rules.
3. **Eligibility.** The planner reported that the agentic-wallet skill's campaign file restricts bStocks to permitted-jurisdiction users. Nigeria eligibility is unknown. Also check `baw wallet settings` for `tradeAllTokens`, `dailyLimit`, `abnormalTxnHandling`.
4. Whether xStocks exist on BSC through this API. The `binance-tokenized-securities-info` skill says Ondo is the only provider; the agentic-wallet skill documents `type=2` and `type=3`. Token-list `type`: 1 Ondo, 2 xStocks-style, 3 bStock.
5. Whether each provider trades outside US hours.
6. Gas: whether the Agentic Wallet needs BNB, and how much.
7. Code assumptions: the quote's `slippage` field is a fraction (if it is a percent, every quote is refused: safe but blocking); `WALLET_ADDRESS` appears in the swap's Transfer logs (if the wallet routes through another account, buys show `receipt decode failed`, and the balance fallback takes over); `baw wallet balance` returns a list of `{address, balance, binanceChainId}` items; a missing token reads as "0"; market-status responses match the docs' Ondo examples; a sell may need an ERC-20 approval tx.

## Plan to submission (from the Sonnet 5.5 planner; its fee and gas numbers are assumptions)

WAT sessions: pre 09:00-14:30, regular 14:30-21:00, post 21:00-01:00, overnight 01:00-09:00, weekend Sat 01:00 to Mon 01:00. Evenings only reach regular and post; pre and overnight need short morning slots (about 07:30 and 09:15 on Thu/Fri).

| Day | Tasks |
|---|---|
| Mon 5 / tonight | Reachability check, install `baw`, sign in (stopwatch it: DevEx evidence), `wallet address/settings/balance/chains`, fill `.env`, list tokens for all three providers, dry-run quotes $5 -> $3 -> $1, save raw JSON, start the Binance withdrawal (holds can take up to 24h) |
| Tue 6 | Regular-hours quote baseline, push the repo public, read the DevEx form questions and both side-prize rule pages |
| Wed 7 | **First live fill**, buy only, regular session, save the tx hash and commit it, screen-record it. Then sell back with `sell`. Then one round trip per other provider |
| Thu 8 | Optional 07:30 overnight fills, second regular sample, MCP smoke test, static site, DevEx evidence. **23:00 hard cutoff: no FINISHED hash by then means switch to quote-only** |
| Fri 9 | Optional 09:15 pre fills, deploy, demo footage, README facts, 60 min DevEx draft block (the builder writes it) |
| Sat 10 | Weekend fills, final table, final DevEx report (the builder, 90 min), video upload, submit, check links logged out |
| Sun 11 | Emergency buffer only, hard stop 11:00 WAT |

**Go/no-go for the first live fill:** signed in, `.env` wallet address matches `baw wallet address`, funded, settings allow the trade, a $3 or $5 quote with a sane price, token not paused, tests green, no `KILL` file, regular session, builder at the keyboard, buy only.
**Stop all live trading** (create a `KILL` file) if net wallet value drops by $6 or more, or any wallet change is not in the ledger. Hard ceiling $10. After the last fill run `baw approvals list` and revoke unlimited approvals.
**Switch to quote-only:** the whole project if no FINISHED hash by Thu 23:00, no funding by Thu midday, sign-in impossible, or all providers blocked. Then run quote sweeps across sessions and publish quote latency and quote-vs-reference with `get_fill_stats` `mode: "quotes"`, and say plainly that no fills occurred. An honest report is still worth the 25%.

Budget idea: one withdrawal of about $11.5 USDT plus about $2.5 of BNB for gas. A round trip should cost only spread, fees and gas, not the notional, but a failed off-hours sell can strand up to $3 per position.

## Still to build or do

- Static page generated from `data/fills.jsonl` (table, BscScan links, MCP config snippet), published on GitHub Pages or Cloudflare Pages: this is the "deployed link". Put judging instructions in the README too.
- Demo video (max 4:00): problem, live fill on screen, the table by provider and session, an agent calling `get_fill_stats`, honest limits. Hide the QR, pairing code and anything session-related.
- README: replace the "scaffold" status with real findings and the real table.
- Side-prize angles: Wallet Skills (`skill/xfiler/SKILL.md` exists; test it with Claude Code plus the baw skill; consider a small `best_session` read-only tool). Agent Studio: read the exact prize criteria first; the planner suggested 1 to 3 x402 calls to the Stock Analyze Agent at about 0.1 U each, unverified.
- DevEx data: log entries in `devex/OBSERVATIONS.md` as they happen; `data/api-calls.jsonl` records every call's latency and errors; align `devex/OUTLINE.md` with the real form questions. Known friction already noted there: docs host timeouts, the two skills disagreeing on providers, no minimum size in docs, `npx skills add` hanging.

## History, for context

- Built by Claude. Plan: Sonnet 5.5. Code review and fixes: Opus 5.5 (a first review found 15 issues, all addressed: order lifecycle, unresolved-order exposure, a sell command, receipt decoding, quote checks, adapter tagging, status polling, amount validation, loss budget, stats, paths, kill-switch, table escaping, mock sells). The second batch added balance snapshot, provider market status, raw samples, quote-only mode.
- Cinder (https://github.com/Turnless/Cinder) is the builder's earlier project; its caps / kill-switch / dry-run pattern was ported, not imported.
- Raw venue samples go to `data/raw/` and are git-ignored on purpose: review by hand before `git add -f`.
- `data/api-calls.jsonl`, `.env` and `KILL` are git-ignored.

## Skills installed (global, `~/.claude/skills`)

`binance-agentic-wallet`, `binance-tokenized-securities-info`, `bnbchain-mcp`, `query-token-info`, `viem-integration`, `mcp-builder` (installed by the builder). Also present but **not requested during this build, origin unknown**: `tdd`, `solidity-security`, `llm-evaluation`. Review before relying on them. `grand-master` and the `master-*` skills are the builder's own pattern system (`CLAUDE.md`, `.claude/`); the rules file is still empty, so match the existing code style.
