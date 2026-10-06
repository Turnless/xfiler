# DevEx observations (raw log, not the report)

Fill this in as you hit things, in the moment, with a timestamp. The report must be written by you in your own words; this file is only the evidence you draw from. The probe also writes every call's latency and errors to `data/api-calls.jsonl`.

Entry template (copy per observation):

```
## <UTC date time> <short label>
Tried:        what you ran / read (exact command or URL)
Expected:     what the docs led you to expect
Got:          exact output or error (paste it)
Time lost:    minutes
Workaround:   what finally worked, or "none"
Docs fix:     what would have saved the time
```

## Already known from setup (2026-10-05, Windows, Nigeria)

- `web3.binance.com` and `www.binance.com` timed out from the build machine (curl exit 28, WebFetch ECONNRESET). Docs were reachable only via GitHub (`binance/binance-skills-hub`). Check whether this is your network or a regional block before writing it up.
- Minimum trade size: not found in any doc I could read. Docs state a maximum (`limitInfo.maxActiveNotionalValue`). Answer it with a real quote at $1 / $3 / $5.
- `baw market-order swap` returns only an `orderId`; success needs polling `market-order list`. The list response has `txHash` but no filled amount, so fill price needs the on-chain receipt.
- Docs say `limit-order` can fail for Ondo tokens; the skill tells agents to detect this at runtime.
- The `binance-tokenized-securities-info` skill says Ondo is the only supported provider, while the agentic-wallet skill documents `type=2` and `type=3`: docs disagree.
- `npx skills add` installs hung or were killed several times and tried to install to ~16 agents; `-a claude-code` was needed.

## Log
