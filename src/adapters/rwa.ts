import { BSC_CHAIN_ID } from "../config.js";
import { logApiCall } from "../store.js";
import { PROVIDER_TYPE, type Provider, type RwaToken } from "../types.js";

const URL_LIST =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";

/**
 * Token list for one provider, BSC only. Endpoint and `type` meaning (1 Ondo, 2 xStocks-style,
 * 3 bStock) are taken from the official skill docs. Addresses are never hard-coded here:
 * they come from this endpoint so nothing is guessed.
 */
export async function listBscTokens(provider: Provider, dataDir: string): Promise<RwaToken[]> {
  const started = Date.now();
  const ts = new Date().toISOString();
  try {
    const res = await fetch(`${URL_LIST}?type=${PROVIDER_TYPE[provider]}`, {
      headers: { "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.1 (Skill)" },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { success?: boolean; data?: RwaToken[] };
    logApiCall(dataDir, { ts, call: `rwa list type=${PROVIDER_TYPE[provider]}`, ms: Date.now() - started, ok: res.ok && body.success === true });
    return (body.data ?? []).filter((t) => t.chainId === BSC_CHAIN_ID);
  } catch (err) {
    logApiCall(dataDir, { ts, call: `rwa list type=${PROVIDER_TYPE[provider]}`, ms: Date.now() - started, ok: false, error: String(err).slice(0, 300) });
    throw err;
  }
}

export async function resolveToken(provider: Provider, symbolOrTicker: string, dataDir: string): Promise<RwaToken> {
  const list = await listBscTokens(provider, dataDir);
  const q = symbolOrTicker.toLowerCase();
  const hit = list.find((t) => t.symbol.toLowerCase() === q || t.ticker.toLowerCase() === q);
  if (!hit) throw new Error(`no ${provider} token "${symbolOrTicker}" on BSC (${list.length} listed)`);
  return hit;
}
