import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FillRecord } from "./types.js";

export const fillsPath = (dir: string) => join(dir, "fills.jsonl");
export const apiLogPath = (dir: string) => join(dir, "api-calls.jsonl");

export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

/** Raw rows, in file order. Several rows can share an id: use `latestById` / `ledger` to read state. */
export function readFills(dir: string): FillRecord[] {
  const p = fillsPath(dir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FillRecord);
}

/** The last row per id wins; order is that of each id's first row (attempt start). */
export function latestById(rows: FillRecord[]): FillRecord[] {
  const byId = new Map<string, FillRecord>();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

/** What stats, the table and the gates read: last row per id, real (`baw`) rows only unless a test asks for mock rows. */
export function ledger(rows: FillRecord[], includeMock = false): FillRecord[] {
  return latestById(rows).filter((r) => r.adapter === "baw" || (includeMock && r.adapter === "mock"));
}

/** Round a token quantity DOWN to 8 decimals as a plain decimal string ("0" if nothing is left). */
export function floor8(x: string | number): string {
  const s = typeof x === "number" ? x.toFixed(18) : x.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || s === "" || s === ".") throw new Error(`not a plain non-negative decimal: "${s}"`);
  const frac = (m[2] ?? "").slice(0, 8).replace(/0+$/, "");
  const int = (m[1] || "0").replace(/^0+(?=\d)/, "");
  return frac ? `${int}.${frac}` : int;
}

// Keys whose values are never written to a raw sample (case-insensitive substring match).
const SECRET_KEY = /token|session|secret|key|auth|clientid|password|passphrase|signature|cookie|credential|private|mnemonic|seed/i;
const JWT = /^eyJ[\w-]+\.[\w-]+\./;

/** Deep copy with secret-looking keys (and JWT-looking values) replaced by a type placeholder; the shape stays visible. */
export function redact(v: unknown, key = ""): unknown {
  if (key && SECRET_KEY.test(key)) return v === null || v === undefined ? v : `[REDACTED ${Array.isArray(v) ? "array" : typeof v}]`;
  if (typeof v === "string" && JWT.test(v)) return "[REDACTED jwt]";
  if (Array.isArray(v)) return v.map((x) => redact(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  return v;
}

/**
 * First raw response per provider, side and kind (quote / swap / list), redacted, to
 * <dataDir>/raw/<provider>-<side>-<kind>.json. Never overwrites: the first sample is the evidence
 * of the response shape. Best-effort: returns false instead of throwing.
 */
export function saveRawSample(dir: string, provider: string, side: string, kind: "quote" | "swap" | "list", raw: unknown): boolean {
  try {
    const rawDir = join(dir, "raw");
    mkdirSync(rawDir, { recursive: true });
    const body = JSON.stringify({ savedAt: new Date().toISOString(), provider, side, kind, raw: redact(raw) }, null, 2);
    writeFileSync(join(rawDir, `${provider}-${side}-${kind}.json`), body + "\n", { flag: "wx" }); // fails if it exists
    return true;
  } catch {
    return false;
  }
}

/** Every external call (docs friction, latency, errors) is logged: raw material for the DevEx report. */
export function logApiCall(
  dir: string,
  entry: { ts: string; call: string; ms: number; ok: boolean; error?: string; stderr?: string },
): void {
  appendJsonl(apiLogPath(dir), entry);
}

// Markdown-safe cell: a `|` or a newline in an error message must not break the table.
const cell = (v: unknown) => (v === null || v === undefined ? "-" : String(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|"));
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function renderTable(rows: FillRecord[], includeMock = false): string {
  const head =
    "| time (UTC) | provider | symbol | side | session | provider session | USD | quote px | fill px | slip bps | quote ms | settle ms | status | tx |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  const body = ledger(rows, includeMock)
    .filter((r) => !r.dryRun || r.status === "QUOTE_FAILED")
    .map((r) =>
      [
        r.ts.slice(0, 19).replace("T", " "),
        r.provider,
        r.symbol,
        r.side,
        r.session,
        r.providerSession,
        r.usdNotional.toFixed(2),
        r.quotePrice?.toFixed(4),
        r.fillPrice?.toFixed(4),
        r.slippageBps?.toFixed(1),
        r.quoteLatencyMs,
        r.settleLatencyMs,
        r.error ? `${r.status}: ${clip(r.error)}` : r.status,
        r.txHash ? `[${r.txHash.slice(0, 10)}…](https://bscscan.com/tx/${r.txHash})` : null,
      ]
        .map(cell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    )
    .join("\n");
  return head + body + "\n";
}
