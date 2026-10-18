import { getQuotes, type Quote } from "@/lib/market";
import { graphRun } from "@/lib/graph";

export const dynamic = "force-dynamic";

/** tape cache — the header ticker polls this endpoint; coalesce bursts and
 *  keep one upstream fetch per interval no matter how many tabs are open. */
const TAPE_TTL = 12_000;
let tapeCache: { at: number; quotes: Quote[] } | null = null;

interface GraphCompany {
  ticker: string;
  name: string;
}

/** every Company node in the graph — the tape mirrors the graph universe,
 *  so a company ingested mid-chat appears on the next poll automatically. */
async function graphCompanies(): Promise<GraphCompany[]> {
  const rows = await graphRun<{ key?: string; name?: unknown; props?: Record<string, unknown> }[]>(
    "allByLabel",
    { label: "Company" },
  );
  const seen = new Set<string>();
  const out: GraphCompany[] = [];
  for (const r of rows.data ?? []) {
    const ticker = String(r.props?.ticker ?? "").toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const name = String(r.props?.name ?? r.name ?? "");
    out.push({ ticker, name });
  }
  out.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return out.slice(0, 60);
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("tickers");
  // default / "graph" → every company the graph knows; explicit list → as before
  const fromGraph = !q || q === "graph";
  if (!fromGraph) {
    const tickers = q
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 12);
    const quotes = await getQuotes(tickers);
    return Response.json({ quotes, fromGraph: false });
  }

  if (tapeCache && Date.now() - tapeCache.at < TAPE_TTL) {
    return Response.json({ quotes: tapeCache.quotes, fromGraph: true });
  }
  let companies: GraphCompany[] = [];
  try {
    companies = await graphCompanies();
  } catch {
    companies = [];
  }
  // empty graph → fall back to the default basket so the tape still breathes
  const tickers = companies.length
    ? companies.map((c) => c.ticker)
    : ["AAPL", "NVDA", "MSFT"];
  const quotes = await getQuotes(tickers);
  const nameBy = new Map(companies.map((c) => [c.ticker, c.name]));
  const withNames = quotes.map((qt) => ({ ...qt, name: nameBy.get(qt.ticker) || undefined }));
  tapeCache = { at: Date.now(), quotes: withNames };
  return Response.json({ quotes: withNames, fromGraph: true });
}
