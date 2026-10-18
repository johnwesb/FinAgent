/**
 * Market data plane — real-time(-ish) quotes.
 *
 * Source chain (first success wins), every quote stamped with its
 * true origin so the desk never fakes liveness:
 *   1. stooq.com delayed quotes (no API key required)
 *   2. Yahoo Finance chart API (no API key required)
 *   3. deterministic synthetic walk, clearly labeled `simulated`
 * Fresh quotes are persisted into the graph as Quote nodes so
 * every answer traces back to graph state.
 */

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  ts: number;
  currency: string;
  source: "stooq-delayed" | "yahoo-delayed" | "simulated";
}

export interface HistoryPoint {
  date: string;
  close: number;
}

/** chart endpoints reject default client UAs */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const BASE_PRICES: Record<string, number> = {
  AAPL: 232, MSFT: 428, NVDA: 138, GOOGL: 178, AMZN: 205, META: 585,
  TSLA: 248, JPM: 242, XOM: 118, AMD: 122, INTC: 21, AVGO: 172,
  TSM: 195, ASML: 690, ORCL: 175, CRM: 330, NFLX: 900, DIS: 112,
  BA: 158, GE: 178, PLTR: 66, COIN: 265,
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function syntheticQuote(ticker: string): Quote {
  const base = BASE_PRICES[ticker] ?? 50 + (hash(ticker) % 40000) / 100;
  const bucket = Math.floor(Date.now() / 60_000); // moves minute to minute
  const r1 = ((hash(`${ticker}:${bucket}`) % 2000) - 1000) / 1000; // -1..1
  const r2 = ((hash(`${ticker}:d:${Math.floor(bucket / 1440)}`) % 2000) - 1000) / 1000;
  const drift = Math.sin(bucket / 97 + hash(ticker) % 7) * 0.004;
  const price = Math.max(1, base * (1 + r1 * 0.006 + drift));
  const changePct = r1 * 1.4 + r2 * 0.8;
  return {
    ticker,
    price: Math.round(price * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    volume: 5_000_000 + (hash(ticker + bucket) % 40_000_000),
    ts: Date.now(),
    currency: "USD",
    source: "simulated",
  };
}

async function stooqQuote(ticker: string): Promise<Quote | null> {
  try {
    const url = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const csv = (await res.text()).trim();
    const line = csv.split("\n").pop() ?? "";
    const cols = line.split(",");
    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = Number(cols[6]);
    const open = Number(cols[3]);
    if (!Number.isFinite(close) || cols[0] === "N/D" || close === 0) return null;
    const changePct = open ? ((close - open) / open) * 100 : 0;
    return {
      ticker,
      price: close,
      changePct: Math.round(changePct * 100) / 100,
      open,
      high: Number(cols[4]),
      low: Number(cols[5]),
      volume: Number(cols[7]),
      ts: Date.now(),
      currency: "USD",
      source: "stooq-delayed",
    };
  } catch {
    return null;
  }
}

function lastFinite(arr: unknown): number | undefined {
  if (!Array.isArray(arr)) return undefined;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = Number(arr[i]);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

/** compact form for matching: "Adani Power" → "adanipower" */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** currency code — Yahoo meta wins, exchange-suffix fallback. */
function currencyFor(symbol: string, meta?: string): string {
  if (meta) return meta;
  const s = symbol.toUpperCase();
  if (s.endsWith(".NS") || s.endsWith(".BO")) return "INR";
  if (s.endsWith(".L")) return "GBp";
  if (s.endsWith(".T")) return "JPY";
  if (s.endsWith(".HK")) return "HKD";
  if (s.endsWith(".DE") || s.endsWith(".F")) return "EUR";
  return "USD";
}

export interface SymbolHit {
  symbol: string;
  name: string;
  exchange: string;
  quoteType?: string;
}

export { fmtMoney, fmtMoneyCompact } from "./money";

const searchCache = new Map<string, { at: number; hit: SymbolHit | null }>();

const verifyCache = new Map<string, { at: number; ok: boolean | "unknown" }>();

/**
 * Feed-side existence check for a symbol before we trust a bare ticker.
 * true = the feed quotes it · false = feed says unknown (never quote it) ·
 * "unknown" = feed unreachable/errored (offline mode: trust the shape and
 * let the source chain label the result).
 */
export async function verifySymbol(symbol: string): Promise<boolean | "unknown"> {
  const c = verifyCache.get(symbol);
  if (c && Date.now() - c.at < 10 * 60_000) return c.ok;
  let out: boolean | "unknown" = "unknown";
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const j = (await res.json()) as { chart?: { result?: unknown[] } };
      out = Array.isArray(j?.chart?.result) && j.chart.result.length > 0;
    } else if (res.status === 400 || res.status === 404) {
      out = false;
    }
    // 429/5xx → "unknown" (can't conclude; don't block offline/soft-fail)
  } catch {
    out = "unknown";
  }
  verifyCache.set(symbol, { at: Date.now(), ok: out });
  return out;
}

const PREFERRED_EXCHANGES = [
  "NSI", "BSE", "NASDAQ", "NYSE", "AMEX", "LSE", "TSE", "HKG",
  "FRA", "ETR", "AMS", "SWX", "TOR", "ASX", "KSC", "STO",
];

/**
 * Yahoo symbol search: company name → canonical exchange symbol.
 * Scores name/symbol overlap and rejects weak matches (never fabricates).
 */
export async function searchSymbol(query: string): Promise<SymbolHit | null> {
  const q = query.trim();
  if (normKey(q).length < 3) return null;
  const key = normKey(q);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < 15 * 60_000) return cached.hit;
  let best: SymbolHit | null = null;
  let bestScore = 0;
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json = (await res.json()) as { quotes?: Array<Record<string, unknown>> };
      const nq = key;
      const nqWords = new Set(
        q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
      );
      for (const c of json.quotes ?? []) {
        const symbol = String(c.symbol ?? "");
        if (!symbol) continue;
        const qt = typeof c.quoteType === "string" ? c.quoteType : undefined;
        if (qt && qt !== "EQUITY" && qt !== "ETF") continue;
        const name = String(c.shortname ?? c.longname ?? "");
        const nameKey = normKey(name);
        const baseKey = normKey(symbol.split(".")[0]);
        const ex = String(c.exchDisp ?? c.exchange ?? "");
        let score = 0;
        if (baseKey === nq || normKey(symbol) === nq) score += 60;
        if (nameKey.includes(nq)) score += 45;
        else if (nq.includes(nameKey) && nameKey.length >= 4) score += 30;
        for (const w of name.toLowerCase().split(/[^a-z0-9]+/)) {
          if (w.length > 2 && nqWords.has(w)) score += 8;
        }
        const exu = ex.toUpperCase();
        if (PREFERRED_EXCHANGES.some((p) => exu.includes(p))) score += 10;
        if (qt === "EQUITY") score += 8;
        if (score > bestScore) {
          bestScore = score;
          best = { symbol, name, exchange: ex, quoteType: qt };
        }
      }
      // weak/no overlap → treat as unresolved rather than guess
      if (bestScore < 30) best = null;
    }
  } catch {
    /* offline → null (caller falls back) */
  }
  searchCache.set(key, { at: Date.now(), hit: best });
  return best;
}

export interface NewsItem {
  title: string;
  publisher: string;
  url: string;
  ts: number;
  related: string[];
}

const newsCache = new Map<string, { at: number; items: NewsItem[] }>();

/** Yahoo news headlines for a ticker (same search endpoint, news channel). */
export async function news(ticker: string, limit = 5): Promise<NewsItem[]> {
  const t = ticker.trim().toUpperCase();
  if (!t) return [];
  const key = `${t}:${limit}`;
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.items;
  let items: NewsItem[] = [];
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(t)}&quotesCount=0&newsCount=${Math.min(limit * 2, 12)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json = (await res.json()) as { news?: Array<Record<string, unknown>> };
      items = (json.news ?? [])
        .map((n) => ({
          title: String(n.title ?? ""),
          publisher: String(n.publisher ?? ""),
          url: String(n.link ?? ""),
          ts: Number(n.providerPublishTime ?? 0) * 1000 || Date.now(),
          related: Array.isArray(n.relatedTickers) ? n.relatedTickers.map(String) : [],
        }))
        .filter((n) => n.title && n.url)
        .slice(0, limit);
    }
  } catch {
    /* offline → empty */
  }
  newsCache.set(key, { at: Date.now(), items });
  return items;
}

async function yahooQuote(ticker: string): Promise<Quote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: { result?: Array<Record<string, any>> };
    };
    const r = json?.chart?.result?.[0];
    const meta = r?.meta as Record<string, unknown> | undefined;
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    const changePct = Number.isFinite(prev) && prev > 0 ? ((price - prev) / prev) * 100 : 0;
    const bar = r?.indicators?.quote?.[0] as Record<string, unknown> | undefined;
    const dayHigh = Number(meta?.regularMarketDayHigh);
    const dayLow = Number(meta?.regularMarketDayLow);
    return {
      ticker,
      price: Math.round(price * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      open: lastFinite(bar?.open),
      high: lastFinite(bar?.high) ?? (Number.isFinite(dayHigh) ? dayHigh : undefined),
      low: lastFinite(bar?.low) ?? (Number.isFinite(dayLow) ? dayLow : undefined),
      volume: lastFinite(bar?.volume),
      ts: Number(meta?.regularMarketTime) * 1000 || Date.now(),
      currency: currencyFor(ticker, typeof meta?.currency === "string" ? meta.currency : undefined),
      source: "yahoo-delayed",
    };
  } catch {
    return null;
  }
}

export async function getQuote(ticker: string): Promise<Quote> {
  const t = ticker.toUpperCase();
  // stooq only carries US listings (it appends ".us") — an exchange suffix
  // (ADANIPOWER.NS, 7203.T) can never match there, so skip the dead 4s wait.
  const us = !t.includes(".");
  const live = (us ? await stooqQuote(t) : null) ?? (await yahooQuote(t));
  return live ?? syntheticQuote(t);
}

export async function getQuotes(tickers: string[]): Promise<Quote[]> {
  return Promise.all(tickers.map((t) => getQuote(t)));
}

export async function getHistory(
  ticker: string,
  days = 60,
): Promise<{ points: HistoryPoint[]; source: Quote["source"]; currency: string }> {
  const t = ticker.toUpperCase();
  try {
    const url = `https://stooq.com/q/d/l/?s=${t.toLowerCase()}.us&i=d`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const text = await res.text();
      const lines = text.trim().split("\n").slice(1);
      const pts = lines
        .map((l) => {
          const c = l.split(",");
          return { date: c[0], close: Number(c[4]) };
        })
        .filter((p) => Number.isFinite(p.close))
        .slice(-days);
      if (pts.length > 5) return { points: pts, source: "stooq-delayed", currency: "USD" };
    }
  } catch {
    /* fall through */
  }
  // Yahoo daily bars — precise period via epoch bounds.
  // request 1.5× calendar days so `days` lands on ~`days` trading sessions.
  // The edge sometimes 429s period1/period2 while still serving range= (seen
  // live) — try both shapes before degrading all history to `simulated`.
  const range =
    days <= 22 ? "1mo" : days <= 66 ? "3mo" : days <= 132 ? "6mo" : days <= 252 ? "1y" : days <= 504 ? "2y" : "max";
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - Math.ceil(days * 1.5) * 86400;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&period1=${p1}&period2=${p2}`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=${range}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        chart?: { result?: Array<Record<string, any>> };
      };
      const r = json?.chart?.result?.[0];
      const stamps: number[] = r?.timestamp ?? [];
      const closes: unknown[] = r?.indicators?.quote?.[0]?.close ?? [];
      const pts: HistoryPoint[] = stamps
        .map((s, i) => ({
          date: new Date(s * 1000).toISOString().slice(0, 10),
          close: Number(closes[i]),
        }))
        .filter((p) => Number.isFinite(p.close) && p.close > 0);
      if (pts.length > 5)
        return {
          points: pts.slice(-days),
          source: "yahoo-delayed",
          currency: currencyFor(t, typeof r?.meta?.currency === "string" ? r.meta.currency : undefined),
        };
    } catch {
      /* try the next URL shape */
    }
  }
  // synthetic random walk back from today's synthetic price
  const today = syntheticQuote(t).price;
  const pts: HistoryPoint[] = [];
  let price = today;
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const r = ((hash(`${t}:hist:${d.toISOString().slice(0, 10)}`) % 2000) - 1000) / 1000;
    price = Math.max(1, price / (1 + r * 0.018));
    pts.push({ date: d.toISOString().slice(0, 10), close: Math.round(price * 100) / 100 });
  }
  return { points: pts, source: "simulated", currency: "USD" };
}

export async function marketStatus(): Promise<{
  live: boolean;
  source?: Quote["source"];
  checked: string;
}> {
  const s = await stooqQuote("AAPL");
  if (s) return { live: true, source: s.source, checked: new Date().toISOString() };
  const y = await yahooQuote("AAPL");
  if (y) return { live: true, source: y.source, checked: new Date().toISOString() };
  return { live: false, checked: new Date().toISOString() };
}

/* ---------------- fundamentals (valuation) ---------------- */

export interface Fundamentals {
  ticker: string;
  trailingPE?: number;
  forwardPE?: number;
  epsTrailing?: number;
  epsForward?: number;
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  recommendation?: string;
  profitMargin?: number;
  revenueGrowth?: number;
  marketCap?: number;
  dividendYield?: number;
  beta?: number;
  week52Low?: number;
  week52High?: number;
  currency?: string;
  source: "yahoo-fundamentals";
  ts: number;
}

type Raw = { raw?: number | string; fmt?: string } | number | string | undefined;

function rv(v: Raw): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && typeof v.raw === "number" && Number.isFinite(v.raw)) {
    return v.raw;
  }
  return undefined;
}

function rs(v: Raw): string | undefined {
  if (typeof v === "string" && v) return v;
  if (v && typeof v === "object" && typeof v.raw === "string" && v.raw) return v.raw;
  return undefined;
}

/** yahoo requires a cookie+crumb for quoteSummary; cached briefly */
let crumbCache: { crumb: string; cookie: string; at: number } | null = null;

async function yahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (crumbCache && Date.now() - crumbCache.at < 10 * 60_000) return crumbCache;
  try {
    const res = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(4000),
      redirect: "manual",
    });
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const cookie = setCookies
      .map((c) => c.split(";")[0])
      .filter((c) => c.includes("="))
      .join("; ");
    if (!cookie) return null;
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie },
      signal: AbortSignal.timeout(4000),
    });
    if (!r2.ok) return null;
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.includes("<") || crumb.includes(" ")) return null;
    crumbCache = { crumb, cookie, at: Date.now() };
    return crumbCache;
  } catch {
    return null;
  }
}

const fundCache = new Map<string, { at: number; data: Fundamentals | null }>();

/**
 * Valuation fundamentals for a ticker. Returns null (never a guess) when
 * the feed rejects the request or the symbol is unknown.
 */
export async function fundamentals(ticker: string): Promise<Fundamentals | null> {
  const t = ticker.toUpperCase();
  const hit = fundCache.get(t);
  if (hit && Date.now() - hit.at < 300_000) return hit.data;
  let out: Fundamentals | null = null;
  try {
    const auth = await yahooCrumb();
    if (auth) {
      const mods = "defaultKeyStatistics,financialData,summaryDetail,price";
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}?modules=${mods}&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Cookie: auth.cookie },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          quoteSummary?: { result?: Array<Record<string, any>> };
        };
        const r = json?.quoteSummary?.result?.[0];
        if (r) {
          const k = (r.defaultKeyStatistics ?? {}) as Record<string, Raw>;
          const f = (r.financialData ?? {}) as Record<string, Raw>;
          const s = (r.summaryDetail ?? {}) as Record<string, Raw>;
          const pm = (r.price ?? {}) as Record<string, Raw>;
          out = {
            ticker: t,
            trailingPE: rv(k.trailingPE) ?? rv(s.trailingPE),
            forwardPE: rv(k.forwardPE),
            epsTrailing: rv(k.trailingEps),
            epsForward: rv(k.forwardEps),
            targetMean: rv(f.targetMeanPrice),
            targetHigh: rv(f.targetHighPrice),
            targetLow: rv(f.targetLowPrice),
            recommendation: rs(f.recommendationKey),
            profitMargin: rv(f.profitMargins),
            revenueGrowth: rv(f.revenueGrowth),
            marketCap: rv(k.marketCap) ?? rv(s.marketCap),
            dividendYield: rv(s.dividendYield),
            beta: rv(s.beta),
            week52Low: rv(s.fiftyTwoWeekLow),
            week52High: rv(s.fiftyTwoWeekHigh),
            currency: rs(pm.currency) ?? currencyFor(t),
            source: "yahoo-fundamentals",
            ts: Date.now(),
          };
        }
      }
    }
  } catch {
    /* fall through — null means unavailable */
  }
  fundCache.set(t, { at: Date.now(), data: out });
  return out;
}
