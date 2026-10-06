import { BSC_CHAIN_ID } from "../config.js";
import { logApiCall } from "../store.js";
import { PROVIDER_SESSIONS, type ProviderSession, type RwaToken } from "../types.js";

const BASE = "https://www.binance.com/bapi/defi";
// From the binance-tokenized-securities-info skill: API 3, 4 and 5. Documented for Ondo; other
// providers may answer UNSUPPORTED or nothing, which is recorded, not guessed around.
const URL_MARKET = `${BASE}/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai`;
const URL_ASSET = `${BASE}/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai`;
const URL_DYNAMIC = `${BASE}/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai`;

/** What a row records about the provider's own view of the market at quote time. */
export interface MarketInfo {
  marketStatus: "open" | "closed" | null;
  marketReason: string | null;
  assetStatus: string | null;
  assetReason: string | null;
  providerSession: ProviderSession | null;
  referencePrice: number | null;
  referenceMultiplier: string | null;
  marketError: string | null;
}

export const NO_MARKET = (why: string): MarketInfo => ({
  marketStatus: null, marketReason: null, assetStatus: null, assetReason: null, providerSession: null,
  referencePrice: null, referenceMultiplier: null, marketError: why,
});

const reason = (d: any): string | null =>
  d?.reasonCode ? (d.reasonMsg ? `${d.reasonCode}: ${d.reasonMsg}` : String(d.reasonCode)) : d?.reasonMsg ? String(d.reasonMsg) : null;

async function getData(url: string, call: string, dataDir: string, timeoutMs: number): Promise<any> {
  const started = Date.now();
  const ts = new Date().toISOString();
  try {
    const res = await fetch(url, {
      headers: { "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.1 (Skill)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { success?: boolean; data?: unknown };
    const ok = res.ok && body?.success === true && body.data != null;
    logApiCall(dataDir, { ts, call, ms: Date.now() - started, ok, error: ok ? undefined : `HTTP ${res.status}` });
    if (!ok) throw new Error(`${call}: HTTP ${res.status}${body?.success === false ? " success=false" : ""}`);
    return body.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith(call)) logApiCall(dataDir, { ts, call, ms: Date.now() - started, ok: false, error: msg.slice(0, 300) });
    throw err;
  }
}

/**
 * Best-effort, never throws: overall market status, per-asset status (with corporate-action
 * reason) and a reference price (tokenInfo.price / sharesMultiplier, per share). Each piece is
 * null on failure, with the reason in `marketError`. Never used by the gates.
 */
export async function lookupMarket(token: RwaToken, dataDir: string, timeoutMs = 8_000): Promise<MarketInfo> {
  const q = `chainId=${BSC_CHAIN_ID}&contractAddress=${encodeURIComponent(token.contractAddress)}`;
  const [m, a, d] = await Promise.allSettled([
    getData(URL_MARKET, "rwa market status", dataDir, timeoutMs),
    getData(`${URL_ASSET}?${q}`, "rwa asset status", dataDir, timeoutMs),
    getData(`${URL_DYNAMIC}?${q}`, "rwa dynamic", dataDir, timeoutMs),
  ]);
  const out = NO_MARKET("");
  const errors: string[] = [];
  const fail = (what: string, r: PromiseRejectedResult) =>
    errors.push(`${what}: ${(r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 80)}`);

  if (m.status === "fulfilled" && typeof m.value?.openState === "boolean") {
    out.marketStatus = m.value.openState ? "open" : "closed";
    out.marketReason = reason(m.value);
  } else if (m.status === "rejected") fail("market", m);
  else errors.push("market: no openState");

  // Per-asset status from API 4; the dynamic API carries the same schema as a fallback.
  const asset = a.status === "fulfilled" ? a.value : d.status === "fulfilled" ? d.value?.statusInfo : null;
  if (typeof asset?.marketStatus === "string") {
    out.assetStatus = asset.marketStatus;
    out.assetReason = reason(asset);
    const s = asset.marketStatus.toLowerCase();
    out.providerSession = (PROVIDER_SESSIONS as readonly string[]).includes(s) ? (s as ProviderSession) : null;
  } else if (a.status === "rejected") fail("asset", a);
  else errors.push("asset: no marketStatus");

  if (d.status === "fulfilled") {
    const price = Number(d.value?.tokenInfo?.price);
    const mult = d.value?.tokenInfo?.sharesMultiplier;
    if (Number.isFinite(price) && price > 0 && Number(mult) > 0) {
      out.referencePrice = price / Number(mult);
      out.referenceMultiplier = String(mult);
    } else errors.push("dynamic: no price/sharesMultiplier");
  } else fail("dynamic", d);

  out.marketError = errors.join("; ") || null;
  return out;
}
