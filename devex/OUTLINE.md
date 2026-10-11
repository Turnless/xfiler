# DevEx report: question map (facts and pointers only; you write every answer)

Form: https://forms.gle/EUQ39xf54GHjC2ys5 (8 pages, needs a Google sign-in). Deadline Sun 11 Oct 12:00 UTC.
The form's own rules: be specific, paste exact URLs / endpoint names / error text, no AI-generated answers.
Under each question: **facts** you can quote (all from `data/fills.jsonl`, `data/api-calls.jsonl`, `data/raw/`) and **you decide** for opinions. `*` = required.

---

## Page 1. Submission details
- Team or project name*: xfiler
- Contact email*: yours
- Public repository URL*: https://github.com/Turnless/xfiler
- Modules used* (tick only what you actually called). Facts:
  - RWA Data API: token list (`.../rwa/stock/detail/list/ai`), market status, asset market status, RWA dynamic (all called, logged)
  - Agentic Wallet / Wallet Skills: `baw auth signin`, `baw auth verify`, `baw market-order quote` (all run)
  - Not called: DeFi, b402, Agent Studio
  - You decide: whether `baw market-order quote` counts as "Trading API" and `baw wallet ...` as "Wallet API"
- Team size*: Solo
- Web3 experience* / used the Binance Web3 API before*: you decide

## Page 2. Onboarding
- Time from docs to first successful call*: facts: first try 6 Oct 22:22 UTC failed (`fetch failed`, x4, ~10.8 s each). First success 6 Oct 23:02 UTC (token list, through a VPN). First successful quote 10 Oct 15:34 UTC. You decide which counts and the bucket.
- Time to get a working API key*: fact: no API key was used. Public endpoints need none; `baw` uses a QR sign-in in the Binance app. You decide the closest option.
- Rate onboarding (1-5)*: you decide
- Where exactly did you get stuck*:
  - Network: `www.binance.com`, `web3.binance.com`, `api.binance.com` unreachable from Nigeria on Airtel (TCP connect timeout) and MTN (DNS timeout); phone browser too; Binance app works. Needed a VPN.
  - Sign-in: `baw auth verify --qrCodeId 188276` (the pairing code by mistake) returned `AUTH_REJECTED` (code 10002004) "QR code does not exist or expired..." The real problem was the wrong id, not expiry.
  - `npx skills add` hung or was killed several times and tried to install to ~16 agents; `-a claude-code` was needed (OBSERVATIONS, 5 Oct).
- Which step took longer than expected*: you decide (network block, sign-in, or waiting for funds)
- llms.txt used*: you decide
- AI coding agent got wrong: you decide (code was built with Claude from the GitHub skills docs; note anything it assumed that turned out wrong, e.g. it did not know the $5 minimum)

## Page 3. Documentation issues
- Rate docs (1-5)*: you decide
- Documentation errors* (format: URL, section, what is wrong, what it should say). Facts:
  - `binance-tokenized-securities-info` skill says Ondo is the only provider; `binance-agentic-wallet` documents `type=2` (xStocks) and `type=3` (bStocks); the live token list returned BSC tokens for all three (~450 Ondo, ~130 xStocks, 91 bStocks). Find the exact file URLs in https://github.com/binance/binance-skills-hub
  - `marketStatus` values documented: premarket, regular, postmarket, overnight, closed, pause. Live, Ondo TSLAon on Saturday returned `offhours` (undocumented), with `reasonCode` `TRADING` while the overall market said `MARKET_CLOSED: Weekend or Holiday`.
  - Token list gives SPYx multiplier `1`; the RWA dynamic API gives `sharesMultiplier` `1.005714560286254` for the same token.
- Missing topics*. Facts:
  - Minimum order size: not documented (only a maximum, `maxActiveNotionalValue`). Live: Ondo minimum is $5; bStocks accepted $3.
  - Which hosts must be reachable, for users in blocked regions.
  - Weekend / off-hours trading behaviour per provider.
  - What the quote response contains: live it has only `fromCoinSymbol`, `fromCoinAmount`, `toCoinSymbol`, `toCoinAmount`, `slippage` (no fee, no route, no price impact, no minimum).
  - Whether a quote needs a funded wallet (live: it does not).
- Code examples runnable*: you decide. Facts: the doc commands you ran yourself: `baw auth signin --json` (worked as written), `baw auth verify --qrCodeId <id> --json` (worked once the right id was used), `baw wallet status --json`; `npx skills add` (hung; needed `-a claude-code`). The `baw market-order quote` command shape was used inside xfiler and worked on the first real call.
- Which examples failed: `npx skills add` (see page 2)
- Most useful page (paste one URL): you decide. Candidates you actually relied on:
  - https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/market-order.md (quote / swap / list command shapes)
  - https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/authentication.md (sign-in flow and its troubleshooting)
  - https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/SKILL.md (token addresses, the RWA token-list endpoint and its `type` values)
  - https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-tokenized-securities-info/SKILL.md (market status and reference price APIs)

## Page 4. API pitfalls
- Rate reliability (1-5)*: you decide. Facts: through the VPN, 0 failed calls to the RWA endpoints on 10 Oct; 3 refused quotes (all business errors, not outages).
- Edge cases / unexpected behaviour*. Facts:
  - `market-order quote`, xStocks SPYx, $5 buy, Sat 10 Oct 16:41 UTC: `toCoinAmount` 0.000557867 SPYx = **$8,963 per token** vs reference ~$772 (dynamic API). $5 would buy ~$0.43 of value. The quote's own `slippage` field still said 0.01.
  - `market-order quote`, xStocks TSLAx, $5: `No liquidity available, please try again later.` (code 100)
  - Quotes work with an empty wallet (0 USDT).
  - Ondo $4.93 **sell** quote accepted while $3 and $1 **buys** were refused: the $5 minimum seems to apply to buys only (quote level; not tested live).
- Unclear or misleading errors*. Facts:
  - `market-order quote` (Ondo TSLAon, $3 and $1): `From token value greater than 5 USD` (code 315008, name `SERVICE_ERROR`). Reads like the amount is too big; it means it must be greater than $5. A business rule labelled `SERVICE_ERROR`.
  - `auth verify` with a wrong id: "QR code does not exist or expired" (see page 2).
  - `market-order quote` (Ondo TSLAon, $5, Sat 10 Oct 17:02 UTC, in the middle of a sweep where the same quote worked 10 min before and after): `{"code":305024,"name":"SERVICE_ERROR","message":"305024"}`. The message is just the code number.
  - `baw wallet status --json` once returned `SERVICE_ERROR` code 2 `illegal parameter` with no parameters given (10 Oct ~14:39 UTC).
  - Network block surfaces in Node as `TypeError: fetch failed`; the real cause (`UND_ERR_CONNECT_TIMEOUT`) is hidden.
- Latency* (from `data/api-calls.jsonl`, through a VPN):
  - `market-order quote` (via `baw`): 1.9 to 10.0 s, median about 3.0 s (11 calls)
  - Token list: 1.4 to 5.4 s, median about 2.5 s (14 calls)
  - Market status / asset status / dynamic: mostly 1.1 to 1.4 s, worst 4.8 s
- Rate limits*: facts: none seen
- Auth and signing: QR flow facts above; you decide
- Data you could not trust*: facts: SPYx quote vs reference (above); TSLAx reference $373.16 vs Ondo/bStocks ~$383 for the same stock at the same time; multiplier mismatch (page 3)

## Page 5. AI stack feedback
- Parts used*: facts: Agentic Wallet (`baw`), Wallet Skills (`binance-agentic-wallet`, `binance-tokenized-securities-info` as docs), your own MCP tool `get_fill_stats` + skill descriptor. You decide what to tick.
- Rate (1-5 or N/A)*, what worked, what did not, what is missing: you decide. Facts to draw on:
  - Missing guardrail: nothing in the quote warns that SPYx was priced 11.6x the reference; an agent trusting `slippage: 0.01` would buy.
  - Missing: a minimum-size field, a "market open for this asset" flag usable before trading.
- Agent Studio: not used

## Page 6. Tokenized-stock specifics
- Platforms* (tick only if you executed trades; quotes only so far): you decide
- Liquidity depth*: facts (Sat 10 Oct): TSLAon and TSLAB quoted at $5; TSLAx "No liquidity"; SPYx quoted at an absurd price.
- Slippage on your sizes*: facts (quote vs reference, positive = worse):
  - Ondo TSLAon $5 buy: +20.0 bps (2 quotes); sells about $4.93 and $5.54: +20.5 and +19.9 bps
  - bStocks TSLAB $5 / $3 buys: +1.4, -0.5, +0.4 bps
  - xStocks SPYx $5: about 11.6x reference
  - No live fills yet (update if you get one)
- Outside market hours*: facts: Saturday: all three say `MARKET_CLOSED: Weekend or Holiday`; Ondo and bStocks still quote; xStocks TSLAx no liquidity; Ondo asset status `offhours`
- On-chain vs reference gap (quotes 15:34 to 17:34 UTC Sat, all with the market closed; 100 bps = 1%):
  - Ondo TSLAon buys: median +20.0 bps, worst +20.3 (5 quotes); sells: +19.9 / +20.5 (2)
  - bStocks TSLAB buys: median -0.5 bps, worst +1.4 (7 quotes)
  - xStocks SPYx buy: +106,161 bps, i.e. 11.6x the reference (1 quote)
  - Stable over the 2 hours; no weekday data to compare yet
  - All providers together: median 19.9 bps, but p95 and worst are the one SPYx quote, so quote per provider, not the overall figure
- Differences between providers for TSLA*: facts: minimum ($5 Ondo vs $3 OK bStocks), spread (~20 bps vs ~1 bps), quote speed, asset-status API answers for Ondo only, xStocks reference price 2.6% lower

## Page 7. Redesign suggestions
All opinion: you decide. Raw material: the missing topics on page 3, the misleading errors on page 4, the SPYx guardrail gap on page 5, the network block.

---

Rules for yourself: only claim what a log line, a raw sample or a tx hash backs; include the failures; no AI-written paragraphs.
