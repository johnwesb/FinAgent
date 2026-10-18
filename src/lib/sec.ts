/**
 * SEC EDGAR — free, authoritative filing data (US registrants only).
 * Phase 1: company-facts XBRL (audited revenue/EPS/etc). Full-text
 * supply-chain mining is phase 2 and intentionally not here.
 */

const UA = "FINQ-DESK research/1.0 (automated; contact: desk@finq.local)";

export interface SecFact {
  metric: string;
  value: number;
  unit: string;
  form: string;
  filed: string;
  fy: number;
  fp: string;
  end: string;
}

export interface SecProfile {
  cik: string;
  name: string;
  facts: SecFact[];
}

const cikCache = { at: 0, map: new Map<string, { cik: string; name: string }>() };
const factsCache = new Map<string, { at: number; value: SecProfile | null }>();

async function cikMap(): Promise<Map<string, { cik: string; name: string }>> {
  if (Date.now() - cikCache.at < 24 * 3600_000 && cikCache.map.size) return cikCache.map;
  try {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
      for (const row of Object.values(json)) {
        if (row?.ticker) {
          cikCache.map.set(row.ticker.toUpperCase(), {
            cik: String(row.cik_str).padStart(10, "0"),
            name: String(row.title ?? ""),
          });
        }
      }
      cikCache.at = Date.now();
    }
  } catch {
    /* offline */
  }
  return cikCache.map;
}

/** latest annual (10-K/20-F) value per metric, from us-gaap XBRL facts */
const METRICS: Array<{ metric: string; tags: string[] }> = [
  { metric: "revenue", tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax"] },
  { metric: "netIncome", tags: ["NetIncomeLoss"] },
  { metric: "epsDiluted", tags: ["EarningsPerShareDiluted"] },
  { metric: "assets", tags: ["Assets"] },
  { metric: "stockholdersEquity", tags: ["StockholdersEquity"] },
];

export async function secFacts(ticker: string): Promise<SecProfile | null> {
  const t = ticker.trim().toUpperCase();
  const hit = factsCache.get(t);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;

  const map = await cikMap();
  const row = map.get(t);
  if (!row) {
    // US-listed only — Indian names (ADANIPOWER.NS, TCS.NS) simply have no SEC presence
    factsCache.set(t, { at: Date.now(), value: null });
    return null;
  }

  let out: SecProfile | null = null;
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${row.cik}.json`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        entityName?: string;
        facts?: { "us-gaap"?: Record<string, { units?: Record<string, Array<Record<string, unknown>>> }> };
      };
      const gaap = json?.facts?.["us-gaap"] ?? {};
      const facts: SecFact[] = [];
      for (const { metric, tags } of METRICS) {
        // scan every alias tag — companies rename tags between years (NVDA
        // moved revenue across Revenues/RevenueFromContract…) — and take
        // the newest full-year (fp=FY) annual-report value.
        let best: Record<string, unknown> | null = null;
        let bestUnit = "USD";
        for (const tag of tags) {
          const units = gaap[tag]?.units;
          const series = units?.USD ?? units?.["USD/shares"] ?? Object.values(units ?? {})[0];
          if (!Array.isArray(series)) continue;
          const unit = units?.["USD/shares"] ? "USD/shares" : "USD";
          for (const f of series) {
            if (f.form !== "10-K" && f.form !== "20-F") continue;
            if (typeof f.val !== "number") continue;
            // skip sub-year durations (10-Ks embed quarterly/partial XBRL rows)
            if (f.start) {
              const days = (Date.parse(String(f.end)) - Date.parse(String(f.start))) / 86400_000;
              if (Number.isFinite(days) && days < 330) continue;
            }
            const isFY = String(f.fp ?? "") === "FY";
            const bestFY = best && String(best.fp ?? "") === "FY";
            // a 10-K embeds ~3 comparative years with the SAME filed date —
            // rank fiscal full-years by period end, filed only as a tiebreak
            const newer =
              !best ||
              (isFY && !bestFY) ||
              (isFY === bestFY &&
                (String(f.end) > String(best.end) ||
                  (String(f.end) === String(best.end) && String(f.filed) > String(best.filed))));
            if (newer) {
              best = f;
              bestUnit = unit;
            }
          }
        }
        if (best) {
          facts.push({
            metric,
            value: Number(best.val),
            unit: bestUnit,
            form: String(best.form),
            filed: String(best.filed),
            fy: Number(best.fy ?? 0),
            fp: String(best.fp ?? ""),
            end: String(best.end ?? ""),
          });
        }
      }
      out = { cik: row.cik, name: String(json.entityName ?? row.name), facts };
    }
  } catch {
    /* offline / rejected */
  }
  factsCache.set(t, { at: Date.now(), value: out });
  return out;
}
