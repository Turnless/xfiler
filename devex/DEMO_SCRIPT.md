# Demo video shot list (max 4:00)

A plan, not a script to read out: say it in your own words. Times are targets.
Before recording: VPN on, `baw` signed in, terminal font large, `.env` closed. **Never show** the QR code, the pairing code, `.env`, or anything session-related.

| Time | Show on screen | Point to make |
|---|---|---|
| 0:00-0:25 | README top (status table) | The problem: agents are about to trade tokenized stocks on BSC with no data on how orders actually fill. xfiler measures it and serves it to agents. |
| 0:25-0:55 | A terminal running `npm run probe tokens -- --provider ondo` **with the VPN off** (`fetch failed`), then with it on (token list) | Built from Nigeria: every Binance developer host is blocked by the carriers, the consumer app is not. Said openly. |
| 0:55-1:45 | `npm run probe quote -- --provider bstock --symbol TSLAB --usd 5`, then the same for `ondo TSLAon` | One real quote per provider, same stock. Point at `quotePrice` vs `referencePrice`, `quoteLatencyMs`, `marketReason: MARKET_CLOSED`. Dry-run: nothing is sent. |
| 1:45-2:15 | `npm run probe quote -- --provider ondo --symbol TSLAon --usd 3` and the xStocks `SPYx` row in `data/fills.jsonl` | Things the docs don't say: the $5 minimum and its confusing message; SPYx quoted at ~11.6x its reference price. |
| 2:15-2:45 | **If you have a live fill:** the `fill` command output and its tx on https://bscscan.com. **If not:** the gates refusing a live order without `LIVE=1` (`ABORTED`, `DRY_RUN`) | Real money only with two switches, caps, a kill-switch and a ledger written before anything is sent. |
| 2:45-3:30 | An agent (Claude Code) calling `get_fill_stats` with `mode: "quotes"` and answering "which provider should I use for TSLA this weekend?" | The point of the project: another agent checks real execution data before it trades, and is told plainly when there are no fills. |
| 3:30-4:00 | `npm run probe report -- --mode quotes`, then the README "Limits" section | Honest limits: small sizes, few samples, quotes only (unless a fill happened), measured through a VPN. Next step: more sessions, live fills. |

Tips
- Record each segment separately, then join them. Re-record a segment rather than the whole thing.
- Run each command once before recording so nothing surprises you (quotes take 2 to 10 s; cut the wait).
- Upload as unlisted on YouTube (or similar) and open the link in a private window before submitting.
