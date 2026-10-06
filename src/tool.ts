import { existsSync } from "node:fs";
import { z } from "zod";
import { summarize } from "./stats.js";
import { fillsPath, readFills } from "./store.js";
import { PROVIDER_SESSIONS } from "./types.js";

/** Input schema of `get_fill_stats` (kept apart from the server so tests can check it without stdio). */
export const getFillStatsShape = {
  provider: z.enum(["bstock", "ondo", "xstock"]).optional(),
  symbol: z.string().optional().describe("token symbol, e.g. the on-chain symbol of the stock token"),
  session: z.enum(["regular", "pre", "post", "overnight", "weekend"]).optional().describe("US equity session, New York time"),
  providerSession: z.enum(PROVIDER_SESSIONS).optional().describe("the provider's own session label at quote time, when it was available"),
  side: z.enum(["buy", "sell"]).optional(),
  mode: z
    .enum(["fills", "quotes"])
    .optional()
    .describe('"fills" (default): real executed orders. "quotes": quote-only data (no order sent), when there are no fills'),
};

export const getFillStatsArgs = z.object(getFillStatsShape);
export type GetFillStatsArgs = z.infer<typeof getFillStatsArgs>;

/** Read-only. No tape is not the same as "0 attempts": say so, so an agent does not read it as data. */
export function getFillStats(dataDir: string, args: GetFillStatsArgs) {
  if (!existsSync(fillsPath(dataDir))) {
    return { isError: true, content: [{ type: "text" as const, text: "fill tape not found (data/fills.jsonl missing): no data, not zero attempts" }] };
  }
  const { mode, ...filter } = args;
  const stats = summarize(readFills(dataDir), filter, false, mode ?? "fills");
  return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
}
