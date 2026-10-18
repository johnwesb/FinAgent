/**
 * Symbol universe — company-name → exchange-symbol resolution with lazy
 * graph ingestion. First time the desk hears about a company it:
 *   1. checks the graph (seed data or a previous ingest — persisted)
 *   2. falls back to Yahoo symbol search (live, worldwide incl. NSE)
 *   3. upserts a Company node so profile/quote/edge tools work from
 *      then on, and remembers the mapping in-process
 * Every resolver returns the canonical symbol — never a guessed one.
 */

import { graphRun } from "@/lib/graph";
import { searchSymbol, verifySymbol, type SymbolHit } from "@/lib/market";

export interface ResolvedSymbol {
  symbol: string;
  name?: string;
  exchange?: string;
  /** true when this call created the graph node */
  ingested?: boolean;
}

const memCache = new Map<string, { at: number; value: ResolvedSymbol | null }>();
const MEM_TTL = 15 * 60_000;

/** canonical symbol shape: NVDA, TSM, ADANIPOWER.NS, BRK.B */
const SYMBOL_SHAPE = /^[A-Za-z]{1,6}(\.[A-Za-z]{1,3})?$/;

/** aliases people actually type (Yahoo lists the ADS, not the company handle) */
export const TICKER_ALIASES: Record<string, string> = {
  TSMC: "TSM",
  GOOG: "GOOGL",
  FB: "META",
};

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** graph fast-path: match a Company node by ticker or name (persisted) */
async function graphLookup(q: string): Promise<ResolvedSymbol | null> {
  try {
    const rows = await graphRun<Record<string, unknown>[]>("searchCompanies", { q });
    const cands = (rows.data ?? []).filter((r) => r && r.ticker);
    if (!cands.length) return null;
    const nq = normKey(q);
    // exact ticker first, then name containment
    for (const p of cands) {
      const t = String(p.ticker);
      if (normKey(t.split(".")[0]) === nq || t.toLowerCase() === q.toLowerCase()) {
        return {
          symbol: t,
          name: p.name ? String(p.name) : undefined,
          exchange: p.exchange ? String(p.exchange) : undefined,
        };
      }
    }
    for (const p of cands) {
      const nk = normKey(String(p.name ?? ""));
      if (nk && nk.includes(nq)) {
        return {
          symbol: String(p.ticker),
          name: String(p.name ?? ""),
          exchange: p.exchange ? String(p.exchange) : undefined,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** best-effort graph ingest for a newly discovered company */
async function ingest(h: SymbolHit): Promise<void> {
  try {
    await graphRun("upsertCompany", {
      ticker: h.symbol,
      props: {
        name: h.name || h.symbol,
        exchange: h.exchange || "",
        sector: "—",
        industry: "—",
        employees: 0,
        founded: 0,
        marketCapB: 0,
        description: "",
        universe: "yahoo-search",
      },
    });
  } catch {
    /* ingest is best-effort — resolution still succeeds */
  }
}

/**
 * Resolve any mention (ticker, name, alias) to a canonical exchange symbol.
 * Returns null only when nothing credible matches — never invents one.
 */
export async function resolveToSymbol(input: string): Promise<ResolvedSymbol | null> {
  const q = String(input ?? "").trim();
  const key = normKey(q);
  if (!key) return null;

  const hit = memCache.get(key);
  if (hit && Date.now() - hit.at < MEM_TTL) return hit.value;

  let out: ResolvedSymbol | null = null;

  const alias = TICKER_ALIASES[q.toUpperCase()] ?? q;
  if (SYMBOL_SHAPE.test(alias) && alias === alias.toUpperCase()) {
    // already symbol-shaped (NVDA, ADANIPOWER.NS) — enrich from the graph
    // when it's there; otherwise let the feed confirm it exists before
    // trusting it, so a made-up ticker can never become a fabricated quote.
    out = await graphLookup(alias);
    if (!out) {
      const v = await verifySymbol(alias);
      out = v === false ? null : { symbol: alias };
    }
  } else {
    // a name: graph first (works offline for known companies)
    out = await graphLookup(q);
    if (!out) {
      const hitY = await searchSymbol(q);
      if (hitY) {
        const known = await graphLookup(hitY.symbol);
        if (known) {
          out = known;
        } else {
          await ingest(hitY);
          out = {
            symbol: hitY.symbol,
            name: hitY.name,
            exchange: hitY.exchange,
            ingested: true,
          };
        }
      }
    }
  }

  memCache.set(key, { at: Date.now(), value: out });
  return out;
}

/** resolve a list, preserving order, deduping canonical symbols */
export async function resolveMany(inputs: string[]): Promise<ResolvedSymbol[]> {
  const results = await Promise.all(inputs.map((i) => resolveToSymbol(i)));
  const seen = new Set<string>();
  const out: ResolvedSymbol[] = [];
  for (const r of results) {
    if (r && !seen.has(r.symbol)) {
      seen.add(r.symbol);
      out.push(r);
    }
  }
  return out;
}
