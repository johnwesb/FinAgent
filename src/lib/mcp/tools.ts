/**
 * MCP tool plane — every capability the agents can select.
 * Tools are exposed over a real MCP JSON-RPC endpoint (/api/mcp)
 * AND consumed in-process by the LangGraph engine through the
 * same registry, so "tool selection via MCP" is literal.
 */

import { z } from "zod";
import { graphRun } from "@/lib/graph";
import { fundamentals, fmtMoney, fmtMoneyCompact, getHistory, getQuotes, news } from "@/lib/market";
import { secFacts } from "@/lib/sec";
import { resolveToSymbol } from "@/lib/universe";

export interface ToolCtx {
  tenant: string;
  runId: string;
}

export interface Source {
  id: string;
  label: string;
}

export interface ToolResult {
  summary: string;
  data: unknown;
  sources: Source[];
  graphTouched: boolean;
}

interface ToolDef {
  name: string;
  description: string;
   
  schema: z.ZodObject<any>;
  jsonSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

/** tiny zod→JSON-schema for our subset */
function toJsonSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(shape)) {
    let t = v;
    let optional = false;
    if (t instanceof z.ZodOptional) {
      optional = true;
      t = t.unwrap();
    }
    let desc = "";
    if (t.description) desc = t.description;
    let base: Record<string, unknown>;
    if (t instanceof z.ZodString) base = { type: "string" };
    else if (t instanceof z.ZodNumber) base = { type: "number" };
    else if (t instanceof z.ZodBoolean) base = { type: "boolean" };
    else if (t instanceof z.ZodArray)
      base = {
        type: "array",
        items:
          t.element instanceof z.ZodNumber ? { type: "number" } : { type: "string" },
      };
    else base = { type: "string" };
    if (desc) base.description = desc;
    props[k] = base;
    if (!optional) required.push(k);
  }
  return { type: "object", properties: props, required };
}

function def(
  name: string,
  description: string,
   
  shape: Record<string, z.ZodTypeAny>,
  run: ToolDef["run"],
): ToolDef {
  return {
    name,
    description,
    schema: z.object(shape),
    jsonSchema: toJsonSchema(shape),
    run,
  };
}

const TICKER = z.string().describe("Stock ticker, e.g. AAPL");

const FEED_LABEL: Record<string, string> = {
  "stooq-delayed": "stooq delayed feed",
  "yahoo-delayed": "yahoo finance delayed feed",
  simulated: "simulated feed",
};

export const TOOLS: ToolDef[] = [
  def(
    "get_quote",
    "Real-time quote for one or more tickers or company names (persisted into the graph as Quote nodes).",
    { tickers: z.array(z.string()).describe("Tickers or company names, e.g. [\"AAPL\",\"Adani Power\"]") },
    async (args) => {
      // resolve names → canonical symbols (graph fast-path, else Yahoo
      // search + one-time Company ingest) — unresolved input is dropped,
      // never fabricated.
      const inputs = (args.tickers as string[]).map(String);
      const results = await Promise.all(inputs.map((t) => resolveToSymbol(t)));
      const resolved: { symbol: string }[] = [];
      const unresolved: string[] = [];
      const seen = new Set<string>();
      results.forEach((r, i) => {
        if (r) {
          if (!seen.has(r.symbol)) {
            seen.add(r.symbol);
            resolved.push(r);
          }
        } else unresolved.push(inputs[i]);
      });
      const quotes = await getQuotes(resolved.map((r) => r.symbol));
      for (const q of quotes) {
        await graphRun("putQuote", {
          ticker: q.ticker,
          price: q.price,
          changePct: q.changePct,
          ts: q.ts,
          source: q.source,
        });
      }
      const note = unresolved.length ? ` · unresolved: ${unresolved.join(", ")}` : "";
      return {
        summary:
          quotes
            .map((q) => `${q.ticker} ${fmtMoney(q.price, q.currency)} (${q.changePct >= 0 ? "+" : ""}${q.changePct}%, ${q.source})`)
            .join(" · ") + note,
        data: quotes,
        sources: quotes.map((q, i) => ({
          id: `S${i + 1}`,
          label: `${q.ticker} quote · ${FEED_LABEL[q.source] ?? q.source}`,
        })),
        graphTouched: true,
      };
    },
  ),

  def(
    "get_history",
    "Daily close history for a ticker or company name (default 60 sessions).",
    {
      ticker: z.string().describe("Ticker or company name, e.g. \"NVDA\" or \"Adani Power\""),
      days: z.number().optional().describe("Lookback days, default 60"),
    },
    async (args) => {
      const resolved = await resolveToSymbol(String(args.ticker));
      const symbol = resolved?.symbol ?? String(args.ticker).toUpperCase();
      const h = await getHistory(symbol, Number(args.days ?? 60));
      const pts = h.points;
      const first = pts[0]?.close ?? 0;
      const last = pts[pts.length - 1]?.close ?? 0;
      const change = first ? ((last - first) / first) * 100 : 0;
      return {
        summary: `${symbol} ${pts.length} sessions: ${first.toFixed(2)} → ${last.toFixed(2)} (${change >= 0 ? "+" : ""}${change.toFixed(1)}%) · ${h.source}`,
        data: h,
        sources: [{ id: "S1", label: `${symbol} daily closes · ${h.source}` }],
        graphTouched: false,
      };
    },
  ),

  def(
    "get_fundamentals",
    "Valuation metrics for a ticker or company name: P/E, EPS, analyst price targets, margins, 52-week range. Live from the market feed.",
    { ticker: z.string().describe("Ticker or company name, e.g. \"TCS\" or \"Taiwan Semiconductor\"") },
    async (args) => {
      const resolved = await resolveToSymbol(String(args.ticker));
      const symbol = resolved?.symbol ?? String(args.ticker).toUpperCase();
      const f = await fundamentals(symbol);
      if (!f) {
        throw new Error(
          `fundamentals unavailable for ${symbol} (feed rejected or unknown symbol)`,
        );
      }
      const bits: string[] = [];
      if (f.trailingPE) bits.push(`trailing P/E ${f.trailingPE.toFixed(1)}x`);
      if (f.forwardPE) bits.push(`forward P/E ${f.forwardPE.toFixed(1)}x`);
      if (f.epsTrailing) bits.push(`EPS ${fmtMoney(f.epsTrailing, f.currency)}`);
      if (f.targetMean) bits.push(`analyst mean target ${fmtMoney(f.targetMean, f.currency)}`);
      if (f.recommendation) bits.push(f.recommendation.replace(/_/g, " "));
      return {
        summary: `${f.ticker}: ${bits.join(" · ") || "metrics returned"}`,
        data: f,
        sources: [{ id: "S1", label: `${f.ticker} valuation · yahoo finance fundamentals` }],
        graphTouched: false,
      };
    },
  ),

  def(
    "company_profile",
    "Company fundamentals profile from the knowledge graph (searched by name or ticker; new companies are ingested on first sight).",
    { query: z.string().describe("Ticker or company name fragment") },
    async (args) => {
      const resolved = await resolveToSymbol(String(args.query));
      let profile: Record<string, unknown> | null = null;
      if (resolved) {
        const byTicker = await graphRun("companyProfile", { ticker: resolved.symbol });
        profile = (byTicker.data as Record<string, unknown> | null) ?? null;
        if (!profile) {
          const found = await graphRun<Record<string, unknown>[]>("searchCompanies", { q: resolved.symbol });
          profile = found.data?.[0] ?? null;
        }
        if (!profile) {
          // resolved but the graph has no node (symbol-shaped input the
          // resolver trusted without a Yahoo hit) — return the minimal
          // real identity rather than fabricating fields
          profile = { name: resolved.name ?? resolved.symbol, ticker: resolved.symbol, exchange: resolved.exchange ?? "" };
        }
      }
      if (!profile)
        return {
          summary: `No company in the knowledge graph matches "${args.query}".`,
          data: null,
          sources: [],
          graphTouched: true,
        };
      // graph identity is seeded demo data — let live market cap win when
      // the feed has it, so the desk never shows a stale valuation next to
      // a live quote.
      const f = profile.ticker ? await fundamentals(String(profile.ticker)) : null;
      if (f?.marketCap) profile.marketCapB = Math.round(f.marketCap / 1e9);
      if (f?.currency) profile.currency = f.currency;
      const cap = Number(profile.marketCapB) > 0 ? fmtMoneyCompact(Number(profile.marketCapB) * 1e9, String(profile.currency ?? "USD")) : "—";
      return {
        summary: `${profile.name} (${profile.ticker}) — ${profile.sector ?? "—"}; mkt cap ${cap}`,
        data: profile,
        sources: [
          { id: "S1", label: "Company node · knowledge graph" },
          ...(f?.marketCap ? [{ id: "S2", label: `${f.ticker} market cap · yahoo finance fundamentals` }] : []),
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_peers",
    "Graph: competitors + same-sector peers via multi-hop IN_SECTOR traversal.",
    { ticker: TICKER },
    async (args) => {
      const sym = (await resolveToSymbol(String(args.ticker)))?.symbol ?? String(args.ticker).toUpperCase();
      const [peers, sector] = await Promise.all([
        graphRun<Record<string, unknown>[]>("peersOf", { ticker: sym }),
        graphRun<Record<string, unknown>[]>("sectorPeers", { ticker: sym }),
      ]);
      return {
        summary: `${sym}: ${peers.data.length} direct rivals, ${sector.data.length} sector peers (2-hop)`,
        data: { rivals: peers.data, sectorPeers: sector.data },
        sources: [
          { id: "S1", label: "COMPETES_WITH traversal" },
          { id: "S2", label: "IN_SECTOR 2-hop traversal" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_supply_chain",
    "Graph: suppliers (upstream) and customers (downstream) via SUPPLIES edges.",
    { ticker: TICKER },
    async (args) => {
      const sym = (await resolveToSymbol(String(args.ticker)))?.symbol ?? String(args.ticker).toUpperCase();
      const r = await graphRun<{ suppliers: unknown[]; customers: unknown[] }[]>(
        "supplyChain",
        { ticker: sym },
      );
      const row = r.data[0] ?? { suppliers: [], customers: [] };
      return {
        summary: `${sym} supply chain: ${row.suppliers.length} suppliers → ${row.customers.length} customers`,
        data: row,
        sources: [{ id: "S1", label: "SUPPLIES graph traversal" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_risk_paths",
    "Track 1 multi-hop action: every company that depends on this one through the supply web (up to 3 hops), with readable chains.",
    { ticker: TICKER },
    async (args) => {
      const sym = (await resolveToSymbol(String(args.ticker)))?.symbol ?? String(args.ticker).toUpperCase();
      const r = await graphRun<Record<string, unknown>[]>("riskPropagation", {
        ticker: sym,
      });
      return {
        summary: `${sym} disruption propagates to ${r.data.length} dependent companies within 3 hops`,
        data: r.data,
        sources: [{ id: "S1", label: "SUPPLIES*1..3 variable-length traversal" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_path",
    "Graph: shortest relationship path between two companies (explainability).",
    { a: z.string(), b: z.string() },
    async (args) => {
      const [ra, rb] = await Promise.all([
        resolveToSymbol(String(args.a)),
        resolveToSymbol(String(args.b)),
      ]);
      const a = ra?.symbol ?? String(args.a).toUpperCase();
      const b = rb?.symbol ?? String(args.b).toUpperCase();
      const r = await graphRun<Record<string, unknown>[]>("pathBetween", { a, b });
      return {
        summary: r.data.length
          ? `${a} ↔ ${b}: ${r.data[0].hops} hop(s)`
          : `No path found between ${a} and ${b}`,
        data: r.data,
        sources: [{ id: "S1", label: "shortestPath(..)-style BFS" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "graph_centrality",
    "Graph algorithm: degree centrality ranking of the most connected companies.",
    {},
    async () => {
      const r = await graphRun<Record<string, unknown>[]>("centrality", {});
      return {
        summary: `Most connected: ${r.data.slice(0, 3).map((c) => c.ticker).join(", ")}`,
        data: r.data,
        sources: [{ id: "S1", label: "degree centrality over full graph" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_decisions",
    "Company Brain: decisions matching a topic, each traced to source documents and deciders (provenance).",
    { topic: z.string() },
    async (args) => {
      const r = await graphRun<Record<string, unknown>[]>("decisionsAbout", {
        q: args.topic,
      });
      return {
        summary: `${r.data.length} decision(s) found about "${args.topic}"`,
        data: r.data,
        sources: [
          { id: "S1", label: "Decision nodes" },
          { id: "S2", label: "DERIVED_FROM document provenance" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_who_knows",
    "Company Brain: who owns/knows what — people linked to teams, projects, docs about a topic.",
    { topic: z.string() },
    async (args) => {
      const r = await graphRun<Record<string, unknown>[]>("whoKnows", {
        q: args.topic,
      });
      return {
        summary: `${r.data.length} ownership/expertise link(s) for "${args.topic}"`,
        data: r.data,
        sources: [
          { id: "S1", label: "MEMBER_OF / LEADS / WORKS_ON / AUTHORED edges" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_org",
    "Company Brain: org overview — teams, members, projects, and who leads what.",
    {},
    async () => {
      const r = await graphRun<Record<string, unknown>[]>("orgOverview", {});
      return {
        summary: `${r.data.length} teams on the org graph`,
        data: r.data,
        sources: [{ id: "S1", label: "org graph (Team/Person/Project)" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_ingest_document",
    "Company Brain: ingest a document into the graph; auto-links mentions of known companies.",
    {
      title: z.string(),
      body: z.string(),
    },
    async (args, ctx) => {
      const key = `Document:${String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
      const r = await graphRun<{ mentioned: string[] }>("ingestDocument", {
        key,
        title: args.title,
        body: args.body,
        ingestedBy: ctx.runId,
        date: new Date().toISOString().slice(0, 10),
      });
      return {
        summary: `Ingested "${args.title}" — linked mentions: ${r.data.mentioned.join(", ") || "none"}`,
        data: r.data,
        sources: [{ id: "S1", label: `Document node ${key}` }],
        graphTouched: true,
      };
    },
  ),

  def(
    "brain_record_decision",
    "Company Brain: record a decision with rationale; auto-links companies, source docs, decider.",
    {
      title: z.string(),
      rationale: z.string(),
      decidedBy: z.string().optional(),
      sources: z.array(z.string()).optional(),
    },
    async (args) => {
      const key = `Decision:${String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
      const r = await graphRun<{ mentioned: string[] }>("recordDecision", {
        key,
        ...args,
      });
      return {
        summary: `Decision recorded: "${args.title}" (mentions: ${r.data.mentioned.join(", ") || "—"})`,
        data: r.data,
        sources: [{ id: "S1", label: `Decision node ${key}` }],
        graphTouched: true,
      };
    },
  ),

  def(
    "memory_recall",
    "Track 2: recall across sessions — episodic (past messages) + semantic/procedural memory for this tenant.",
    { query: z.string() },
    async (args, ctx) => {
      const [episodic, semantic] = await Promise.all([
        graphRun<Record<string, unknown>[]>("recallEpisodes", {
          tenant: ctx.tenant,
          q: args.query,
        }),
        graphRun<Record<string, unknown>[]>("recallMemory", {
          tenant: ctx.tenant,
          q: args.query,
        }),
      ]);
      const q = String(args.query).trim().toLowerCase();
      // A synthesized desk answer is output, not memory: echoing it back
      // resurrects stale (possibly wrong) numbers into fresh answers.
      // Markers must survive the 1500-char scribe slice — headers are at
      // the head of every answer, source/trace markers may be cut off.
      const isDeskAnswer = (c: string) =>
        c.includes("### ") ||
        c.includes("**Reasoning trace:**") ||
        c.includes("**Sources**");
      const eps = episodic.data.filter((e) => {
        const c = String(e.content ?? "");
        if (c.trim().toLowerCase() === q) return false;
        if (e.role === "assistant" && isDeskAnswer(c)) return false;
        return true;
      });
      return {
        summary: `Recall "${args.query}": ${eps.length} episode(s), ${semantic.data.length} memory item(s)`,
        data: { episodic: eps, semantic: semantic.data },
        sources: [
          { id: "S1", label: "Episodic memory (Episode nodes)" },
          { id: "S2", label: "Semantic/procedural memory (Memory nodes)" },
        ],
        graphTouched: true,
      };
    },
  ),

  def(
    "memory_store",
    "Track 2: persist a fact ('semantic') or a how-to ('procedural') into long-term graph memory for this tenant.",
    {
      text: z.string(),
      kind: z.string().describe("semantic | procedural"),
      topic: z.string().optional(),
    },
    async (args, ctx) => {
      const kind = String(args.kind).toLowerCase().includes("proc")
        ? "procedural"
        : "semantic";
      const key = `Memory:${ctx.tenant}:${Buffer.from(String(args.text)).toString("base64url").slice(0, 40)}`;
      const r = await graphRun<{ confidence: number }>("putMemory", {
        key,
        tenant: ctx.tenant,
        kind,
        text: args.text,
        topic: args.topic ?? "",
        ts: Date.now(),
      });
      return {
        summary: `Stored ${kind} memory (confidence ${r.data.confidence})`,
        data: r.data,
        sources: [{ id: "S1", label: `Memory node (${kind})` }],
        graphTouched: true,
      };
    },
  ),

  def(
    "list_procedures",
    "Track 2: list procedural memory — how the desk does things.",
    {},
    async (_args, ctx) => {
      const r = await graphRun<Record<string, unknown>[]>("listMemory", {
        tenant: ctx.tenant,
        kind: "procedural",
      });
      return {
        summary: `${r.data.length} procedure(s) in memory`,
        data: r.data,
        sources: [{ id: "S1", label: "Memory nodes (kind=procedural)" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "get_news",
    "News headlines for a ticker or company name (Yahoo finance news feed).",
    {
      ticker: z.string().describe("Ticker or company name"),
      limit: z.number().optional().describe("Max headlines, default 5"),
    },
    async (args) => {
      const resolved = await resolveToSymbol(String(args.ticker));
      const symbol = resolved?.symbol ?? String(args.ticker).toUpperCase();
      const items = await news(symbol, Number(args.limit ?? 5));
      if (!items.length)
        return {
          summary: `no headlines for ${symbol}`,
          data: [],
          sources: [],
          graphTouched: false,
        };
      const when = (ts: number) => new Date(ts).toISOString().slice(0, 10);
      return {
        summary: `${symbol} headlines: ${items.map((n) => `${n.title.slice(0, 80)} (${n.publisher}, ${when(n.ts)})`).join(" · ")}`,
        data: items,
        sources: items.slice(0, 6).map((n, i) => ({ id: `S${i + 1}`, label: `${n.title.slice(0, 90)} · ${n.publisher}` })),
        graphTouched: false,
      };
    },
  ),

  def(
    "get_facts",
    "Audited fundamentals from SEC EDGAR XBRL filings (US registrants only): revenue, net income, EPS, assets, equity — latest 10-K/20-F values with filing dates.",
    { ticker: z.string().describe("Ticker, e.g. NVDA") },
    async (args) => {
      const resolved = await resolveToSymbol(String(args.ticker));
      const symbol = (resolved?.symbol ?? String(args.ticker).toUpperCase()).split(".")[0];
      const p = await secFacts(symbol);
      if (!p || !p.facts.length)
        return {
          summary: `no SEC filings for ${symbol} (EDGAR covers US registrants only)`,
          data: null,
          sources: [],
          graphTouched: false,
        };
      const bits = p.facts.map((f) => `${f.metric} ${fmtMoneyCompact(f.value, f.metric === "epsDiluted" ? "USD" : "USD")} (${f.form} filed ${f.filed})`);
      return {
        summary: `${p.name} (${symbol}) XBRL: ${bits.join(" · ")}`,
        data: p,
        sources: p.facts.slice(0, 5).map((f, i) => ({
          id: `S${i + 1}`,
          label: `${f.metric} · ${f.form} filed ${f.filed} · sec.gov EDGAR`,
        })),
        graphTouched: false,
      };
    },
  ),

  def(
    "position_set",
    "Upsert a real portfolio position (your holding) for this tenant. Only real book data — never infer positions.",
    {
      ticker: z.string().describe("Ticker or company name"),
      qty: z.number().describe("Shares/units held (negative = short)"),
      avgCost: z.number().describe("Average entry cost per share"),
      note: z.string().optional(),
    },
    async (args, ctx) => {
      const resolved = await resolveToSymbol(String(args.ticker));
      if (!resolved) throw new Error(`unknown ticker or company: ${args.ticker}`);
      const qty = Number(args.qty);
      const avgCost = Number(args.avgCost);
      const key = `Position:${ctx.tenant}:${resolved.symbol}`;
      const props = {
        tenant: ctx.tenant,
        ticker: resolved.symbol,
        name: resolved.name ?? resolved.symbol,
        qty,
        avgCost,
        note: String(args.note ?? ""),
        openedAt: new Date().toISOString().slice(0, 10),
        updatedAt: Date.now(),
      };
      await graphRun("upsertNode", { label: "Position", key, props });
      try {
        await graphRun("link", { src: key, dst: `Company:${resolved.symbol}`, type: "POSITION_IN", props: {} });
      } catch {
        /* company node optional */
      }
      return {
        summary: `position set ${resolved.symbol}: ${qty} @ ${fmtMoney(avgCost)}${args.note ? ` (${args.note})` : ""}`,
        data: props,
        sources: [],
        graphTouched: true,
      };
    },
  ),

  def(
    "position_list",
    "All portfolio positions for this tenant, marked to live prices with P&L.",
    {},
    async (_args, ctx) => {
      const rows = await graphRun<{ props?: Record<string, unknown> }[]>("allByLabel", { label: "Position" });
      const mine = (rows.data ?? [])
        .map((r) => r.props ?? {})
        .filter((p) => p.tenant === ctx.tenant && p.ticker);
      if (!mine.length)
        return { summary: "no positions recorded for this tenant", data: [], sources: [], graphTouched: true };
      const quotes = await getQuotes(mine.map((p) => String(p.ticker)));
      const qBy = new Map(quotes.map((q) => [q.ticker, q]));
      const marked = mine.map((p) => {
        const q = qBy.get(String(p.ticker));
        const qty = Number(p.qty);
        const avgCost = Number(p.avgCost);
        const price = q?.price ?? avgCost;
        const value = qty * price;
        const cost = qty * avgCost;
        return {
          ticker: p.ticker,
          name: p.name,
          qty,
          avgCost,
          price,
          currency: q?.currency ?? "USD",
          source: q?.source ?? "carried",
          value,
          cost,
          pnl: value - cost,
          pnlPct: cost ? ((value - cost) / Math.abs(cost)) * 100 : 0,
        };
      });
      const mv = marked.reduce((a, p) => a + p.value, 0);
      const pnl = marked.reduce((a, p) => a + p.pnl, 0);
      const cost = marked.reduce((a, p) => a + Math.abs(p.cost), 0);
      const pnlPct = cost ? (pnl / cost) * 100 : 0;
      return {
        summary: `${marked.length} positions, MV ${fmtMoney(mv)} · P&L ${fmtMoney(pnl)} (${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`,
        data: marked,
        sources: [{ id: "S1", label: "Position nodes · knowledge graph" }],
        graphTouched: true,
      };
    },
  ),

  def(
    "portfolio_risk",
    "Portfolio-level risk: positions marked to market, plus which holdings sit inside the graph supply web (dependents within 3 hops).",
    {},
    async (_args, ctx) => {
      const rows = await graphRun<{ props?: Record<string, unknown> }[]>("allByLabel", { label: "Position" });
      const mine = (rows.data ?? [])
        .map((r) => r.props ?? {})
        .filter((p) => p.tenant === ctx.tenant && p.ticker);
      if (!mine.length)
        return { summary: "no positions recorded — nothing to stress", data: null, sources: [], graphTouched: true };
      const tickers = mine.map((p) => String(p.ticker));
      const quotes = await getQuotes(tickers);
      const qBy = new Map(quotes.map((q) => [q.ticker, q]));
      const risk = await Promise.all(
        tickers.map(async (t) => {
          try {
            const r = await graphRun<Record<string, unknown>[]>("riskPropagation", { ticker: t });
            return { ticker: t, dependents: (r.data ?? []).slice(0, 8), count: (r.data ?? []).length };
          } catch {
            return { ticker: t, dependents: [], count: 0 };
          }
        }),
      );
      const positions = mine.map((p) => {
        const q = qBy.get(String(p.ticker));
        const qty = Number(p.qty);
        const price = q?.price ?? Number(p.avgCost);
        return {
          ticker: p.ticker,
          qty,
          value: qty * price,
          pnl: qty * price - qty * Number(p.avgCost),
          currency: q?.currency ?? "USD",
        };
      });
      const exposed = risk.filter((r) => r.count > 0);
      const total = positions.reduce((a, p) => a + p.value, 0);
      const linkedValue = positions
        .filter((p) => risk.some((r) => r.ticker === p.ticker && r.count > 0))
        .reduce((a, p) => a + p.value, 0);
      return {
        summary: `book MV ${fmtMoney(total)}; ${exposed.length}/${tickers.length} holdings inside the supply web (${fmtMoney(linkedValue)} exposed)`,
        data: { positions, risk },
        sources: [
          { id: "S1", label: "Position nodes · knowledge graph" },
          { id: "S2", label: "SUPPLIES*1..3 risk propagation · knowledge graph" },
        ],
        graphTouched: true,
      };
    },
  ),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.jsonSchema,
  }));
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const t = byName.get(name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  const parsed = t.schema.safeParse(args);
  if (!parsed.success) {
    // fail loudly — silently passing raw args through let malformed input
    // (e.g. a string where an array is expected) reach the graph unchecked
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid arguments for ${name}: ${issues}`);
  }
  return t.run(parsed.data as Record<string, unknown>, ctx);
}
