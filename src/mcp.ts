import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { getFillStats, getFillStatsShape } from "./tool.js";

const cfg = loadConfig();
const server = new McpServer({ name: "xfiler", version: "0.1.0" });

// Read-only by design: this server can never place an order. It only reports what past real fills looked like.
server.tool(
  "get_fill_stats",
  "Observed execution quality for tokenized stocks on BSC mainnet, from real micro-fills (not quotes): " +
    "success rate, pending (unresolved) orders, quote failures, slippage vs quote (bps), settle latency, " +
    "failure reason codes and tx hashes. Call before trading a bStock/Ondo/xStock, ideally filtered by the " +
    'session you plan to trade in. With mode "quotes" it reports quote-only data (no fills) instead.',
  getFillStatsShape,
  async (args) => getFillStats(cfg.dataDir, args),
);

await server.connect(new StdioServerTransport());
