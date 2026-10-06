# DevEx report outline (headings and evidence only; you write the prose)

Weight: 25% of the score. Template form: https://forms.gle/EUQ39xf54GHjC2ys5 (check its exact questions first and reshape this outline to match).

| Section | What to say | Evidence to point at |
|---|---|---|
| 1. Getting started | How long from zero to first quote; what blocked you | first entries in OBSERVATIONS.md, `data/api-calls.jsonl` first ok=true row |
| 2. Docs quality | Missing, wrong or contradictory pages | the "docs disagree" and "minimum size" notes |
| 3. Quote vs fill | How far quotes were from fills, by provider and session | `npm run probe report -- --markdown`, tx hashes on BscScan |
| 4. Execution reliability | Failures, pending orders, reasons given by the API | `failureReasons` in `get_fill_stats`, rows with status FAILED |
| 5. Latency | Quote latency, submit to settle | `quoteLatencyMs`, `settleLatencyMs` columns |
| 6. Auth and wallet | Agentic Wallet sign-in, sessions expiring, gas | OBSERVATIONS.md entries |
| 7. Tokenized-stock specifics | Market hours behaviour, halts, corporate actions, multipliers | rows by session, market-status API results |
| 8. Agent/skill experience | Using the skills and `baw` from an agent; MCP tool | what worked and what the agent got wrong |
| 9. What I would change | Ranked asks for the API team | your own conclusions |

Rules for yourself: only claim what a logged entry or a tx hash backs; include the failures; do not paste AI-generated paragraphs.
