---
name: xfiler
description: Check observed execution quality (real fills, not quotes) for tokenized stocks on BSC before trading a bStock, Ondo or xStock. Read-only.
---

# xfiler

Call the `get_fill_stats` MCP tool (server: `npm run mcp` in this repo) before placing a tokenized-stock order.

Inputs, all optional: `provider` (bstock | ondo | xstock), `symbol`, `session` (regular | pre | post | overnight | weekend, New York time), `providerSession` (premarket | regular | postmarket | overnight | closed | pause, the provider's own label at quote time), `side`, `mode` (fills | quotes, default fills).

Output with `mode: "fills"`: attempts, filled, failed, `pending` (orders whose outcome is not known yet), `quoteFailures` (quotes that came back unusable, nothing sent), success rate, slippage vs quote in bps (median, p95, worst), settle latency, `failureReasons` as short codes (e.g. `SLIPPAGE`, `POLL_TIMEOUT`, `SWAP_REJECTED`, `RECEIPT_DECODE_FAILED`), the last 50 tx hashes, and a `note`.

Output with `mode: "quotes"`: quote-only data, no orders: `quotes`, `usable`, `quoteFailures`, quote latency (median, p95), `quoteFailureReasons`, `vsReferenceBps` (quote price vs the provider's reference price, positive = worse for the trader), and a `note`.

How to use the answer:
- If the tool returns an error, there is no tape: say there is no data. Do not report it as zero attempts.
- If `attempts` is under 5, treat it as anecdote and say so. With fewer than 20 fills, p95 is just the worst value seen.
- `mode: "quotes"` describes quotes, not executions. Never present it as fill quality; say no fills were observed.
- If the success rate for the session you plan to trade in is low, `pending` is high, or p95 slippage is above what the user tolerates, tell the user before trading.
- Sizes measured are $3 to $5; larger orders may behave differently.
- This tool never trades. Order placement stays with the wallet skill and its own confirmation rules.
