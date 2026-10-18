/**
 * FINQ engine — a LangGraph StateGraph multi-agent pipeline.
 *
 *   START → supervisor ──► memory(recall)
 *                    └──► market ─► graph ─► brain   (conditional, per plan)
 *                          └──────────────► synthesize → scribe → END
 *
 * - Tool selection goes through the MCP tool plane (literal MCP).
 * - Every node hands off via shared state + graph/telemetry events.
 * - Memory is recalled before specialists run and scribed after.
 * - The LLM (LangChain ChatOllama) refines routing and prose when
 *   a local runtime is up; a deterministic policy router and
 *   template synthesizer carry the desk otherwise.
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { db } from "@/db";
import { agents, chatMessages, events } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { callTool, listTools, type Source } from "./mcp/tools";
import { graphRun } from "./graph";
import { chatJson, chatText, ollamaUp } from "./llm";
import { ensureSeed } from "./seed";
import { fmtMoney, fmtMoneyCompact } from "./market";
import { resolveToSymbol, TICKER_ALIASES, type ResolvedSymbol } from "./universe";

/* ------------------------------ state ------------------------------ */

export interface Action {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface Artifact {
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
   
  data: any;
  sources: Source[];
}

export interface EngineInput {
  question: string;
  tenant: string;
  sessionId: number;
  runId: string;
}

const DeskState = Annotation.Root({
  question: Annotation<string>(),
  tenant: Annotation<string>(),
  sessionId: Annotation<number>(),
  runId: Annotation<string>(),
  llm: Annotation<boolean>(),
  routeReason: Annotation<string>(),
  plan: Annotation<string[]>(),
  actions: Annotation<Action[]>(),
  recalled: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  /** Specialists that have already run — even if every tool call failed. */
  attempted: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  artifacts: Annotation<Artifact[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  answer: Annotation<string>(),
  sources: Annotation<Source[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

type Desk = typeof DeskState.State;

/* --------------------------- telemetry ----------------------------- */

async function emit(
  runId: string,
  sessionId: number,
  agent: string,
  kind: string,
  content: string,
) {
  await db.insert(events).values({ runId, sessionId, agent, kind, content });
}

async function bumpAgent(key: string) {
  await db
    .update(agents)
    .set({ runs: sql`${agents.runs} + 1` })
    .where(eq(agents.key, key));
}

/* ------------------------- intent parsing -------------------------- */

const NAME_MAP: Record<string, string> = {
  apple: "AAPL", microsoft: "MSFT", nvidia: "NVDA", alphabet: "GOOGL",
  google: "GOOGL", amazon: "AMZN", meta: "META", facebook: "META",
  tesla: "TSLA", amd: "AMD", intel: "INTC", broadcom: "AVGO",
  tsmc: "TSM", tsm: "TSM", "taiwan semi": "TSM", "taiwan semiconductor": "TSM", taiwan: "TSM", asml: "ASML",
  oracle: "ORCL", salesforce: "CRM", netflix: "NFLX", disney: "DIS",
  jpmorgan: "JPM", "jp morgan": "JPM", chase: "JPM", exxon: "XOM",
  boeing: "BA", ge: "GE", palantir: "PLTR", coinbase: "COIN",
};

const TICKER_BLACKLIST = new Set(
  // common words + finance shorthand that uppercase extraction would
  // otherwise treat as symbols (P/E, ROE, EPS…)
  "A I IT IS AT US VS AND OR THE FOR TO OF IN ON BY AN AS BE DO WE MY ME NO NOT OK IF SO WHY WHO WHAT HOW WHEN ITS USD CFO CEO IPO ETF AI EV GDP ALL ANY CAN ARE WAS HAS HAD YOU YOUR OUR THEIR THIS THAT WITH FROM ABOUT INTO OVER AFTER PE EPS ROE ROA EBIT WACC DCF NAV AUM PEG YTD EVA FCF TTM".split(
    " ",
  ),
);

/** Canonical symbols for well-known variants — TSMC trades as TSM, etc. */
/** Word-boundary name matchers — "ge" must not fire on "gets", "meta" not on "metadata". */
const NAME_PATTERNS: Array<[RegExp, string]> = Object.entries(NAME_MAP).map(
  ([name, ticker]) => [new RegExp(`\\b${name}\\b`), ticker],
);

export function extractTickers(question: string): string[] {
  const found: string[] = [];
  // explicit cashtags / uppercase symbols
  for (const m of question.matchAll(/\$?\b([A-Z]{1,5})\b/g)) {
    const raw = m[1];
    // a bare single letter is finance shorthand (P/E, % of...), not a ticker —
    // only trust it when explicitly cashtagged ($T). Otherwise "P/E ratio"
    // would quote Papa John's and Enovis next to NVIDIA.
    if (raw.length === 1 && !m[0].startsWith("$")) continue;
    const t = TICKER_ALIASES[raw] ?? raw;
    if (!TICKER_BLACKLIST.has(t)) found.push(t);
  }
  const lower = question.toLowerCase();
  for (const [pattern, t] of NAME_PATTERNS) {
    if (pattern.test(lower)) found.push(t);
  }
  return [...new Set(found)].slice(0, 5);
}

/** Capitalized multi-word phrases that are likely company names, minus
 *  sentence-starters and generic finance nouns ("How is Adani Power
 *  doing" → ["Adani Power"]). All-caps tickers are handled by extractTickers. */
const MENTION_STOP = new Set(
  ("how what why when who where which the this that these those is are was were do does did " +
    "can could should would will shall if then than in on at by for to of and or but we our us " +
    "my me it its they their tell show give list explain walk through about please let much many " +
    "good bad doing today latest compare between over under after before from with has have had " +
    "you your i he she his her also all any some more most other into them get got need want " +
    "look looking check review assess evaluate analyze analyse overall recent recently now new " +
    "company companies stock stocks ticker price ratio valuation business market markets share " +
    "shares sector industry performance trending trade trading investment holdings position " +
    "portfolio earnings quarter annual report data numbers number one two three first second " +
    "third next last best worst high low big small please versus vs keep stop start run make making take taking going goes lately tomorrow yesterday morning evening week month year call calls meeting update")
      .split(" ")
      .filter(Boolean),
);

export function extractMentions(question: string): string[] {
  const out: string[] = [];
  for (const m of question.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)\b/g)) {
    const phrase = m[1].trim();
    const head = phrase.split(/\s+/)[0].toLowerCase();
    if (MENTION_STOP.has(head)) continue;
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out.slice(0, 4);
}

/** resolve a mention phrase → canonical symbol; long phrases fall back to
 *  their head words ("Taiwan Semiconductor Supply Chain" → "Taiwan
 *  Semiconductor"). Graph fast-path first (works offline for known names). */
async function resolveMention(phrase: string): Promise<ResolvedSymbol | null> {
  const words = phrase.split(/\s+/);
  const candidates: string[] = [phrase];
  if (words.length >= 3) candidates.push(words.slice(0, 2).join(" "));
  if (words.length >= 2) candidates.push(words[0]);
  const seen = new Set<string>();
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      const r = await resolveToSymbol(c);
      if (r) return r;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

const TOPIC_STOP = new Set(
  "why did we decide to what when how who whom whose owns own is are the a an our on about tell me show list give please of for in at by and or vs with was were do does did it its this that company companies stock stocks decision decisions would should could can will shall look like walk through map out check review assess evaluate whats let lets".split(" "),
);

function topicWords(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TOPIC_STOP.has(w))
    .slice(0, 4)
    .join(" ");
}

interface PlanOut {
  plan: string[];
  actions: Action[];
  reason: string;
}

export function heuristicRoute(question: string, tickers: string[]): PlanOut {
  const q = question.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => q.includes(w));
  // topic = significant words INCLUDING ticker mentions, trigger phrases stripped
  const topic = topicWords(question) || question.slice(0, 60);
  const actions: Action[] = [];
  const plan = new Set<string>();
  const add = (a: Action) => {
    actions.push(a);
    plan.add(a.agent);
  };
  const t0 = tickers[0] ?? "";

  // --- memory ops
  if (has("remember that", "remember this", "note that", "store this", "keep in mind")) {
    add({
      agent: "memory",
      tool: "memory_store",
      args: {
        text: question.replace(/^.*?remember(?:\s+that|\s+this)?/i, "").trim() || question,
        kind: "semantic",
        topic: topic.slice(0, 60),
      },
      why: "user asked to persist a fact",
    });
  }
  if (has("how do we", "our procedure", "playbook", "procedures")) {
    add({ agent: "memory", tool: "list_procedures", args: {}, why: "procedural memory requested" });
  }
  if (has("what do you remember", "did i tell you", "did we note", "what did i say", "our note", "recall what", "do you remember")) {
    add({ agent: "memory", tool: "memory_recall", args: { query: topic }, why: "explicit memory recall" });
  }

  // --- brain ops
  if (has("ingest", "add document", "add this document") || q.startsWith("document:")) {
    const parts = question.split("|");
    add({
      agent: "brain",
      tool: "brain_ingest_document",
      args: {
        title: (parts[0].replace(/^.*?(ingest|document:)/i, "").trim() || "Untitled note").slice(0, 90),
        body: parts[1]?.trim() || question,
      },
      why: "document ingest requested",
    });
  } else if (has("record decision", "log decision", "we decided to", "decision:")) {
    add({
      agent: "brain",
      tool: "brain_record_decision",
      args: {
        title: question.replace(/^.*?(record decision|log decision|decision:)/i, "").trim().split("because")[0].slice(0, 90) || topic.slice(0, 90),
        rationale: question.split(/because/i)[1]?.trim() || question,
      },
      why: "decision capture requested",
    });
  }
  if (has("who owns", "who leads", "who is responsible", "who knows", "expert on", "who should i", "point person", "who works")) {
    add({ agent: "brain", tool: "brain_who_knows", args: { topic: topic || q }, why: "ownership/expertise lookup" });
  }
  if (has("org chart", "team structure", "who is on the team", "our teams", "org overview", "company structure")) {
    add({ agent: "brain", tool: "brain_org", args: {}, why: "org overview requested" });
  }
  if (has("why did we decide", "when did we decide", "our decision", "decisions on", "decision on", "decision log", "provenance", "rationale behind")) {
    add({ agent: "brain", tool: "brain_decisions", args: { topic: topic || t0 || q }, why: "decision provenance lookup" });
  }

  // --- graph ops
  if (t0 && has("supply chain", "supplier", "suppliers", "customer of", "upstream", "downstream")) {
    add({ agent: "graph", tool: "graph_supply_chain", args: { ticker: t0 }, why: "supply chain traversal" });
  }
  if (t0 && has("risk", "exposure", "contagion", "ripple", "fraud", "shock", "depends on", "dependent", "blow up", "blows up", "collapse")) {
    add({ agent: "graph", tool: "graph_risk_paths", args: { ticker: t0 }, why: "multi-hop risk propagation" });
    if (!actions.some((a) => a.tool === "graph_supply_chain"))
      add({ agent: "graph", tool: "graph_supply_chain", args: { ticker: t0 }, why: "risk context" });
  }
  if (t0 && has("competitor", "peers", "rivals", "rivalry", "landscape")) {
    add({ agent: "graph", tool: "graph_peers", args: { ticker: t0 }, why: "peer traversal" });
  }
  if (tickers.length >= 2 && has("connect", "path", "relationship between", "related", "link")) {
    add({ agent: "graph", tool: "graph_path", args: { a: tickers[0], b: tickers[1] }, why: "shortest path explainability" });
  }
  if (has("most connected", "most important", "systemic", "centrality", "who matters most")) {
    add({ agent: "graph", tool: "graph_centrality", args: {}, why: "graph algorithm" });
  }

  // --- market ops
  const wantsQuote = has("price", "quote", "trading at", "worth", "stock", "value", "how much", "level") || tickers.length > 0;
  const wantsHistory = has("history", "trend", "chart", "performance", "past", "month", "ytd", "momentum");
  const wantsValuation = has(
    "p/e", "pe ratio", "valuation", "eps", "earnings", "multiple", "target", "price target",
    "expensive", "cheap", "overvalued", "undervalued", "margin", "dividend", "beta",
    "52-week", "52 week", "should i buy", "should i sell", "good buy", "worth buying",
  );
  if (tickers.length > 0 && (wantsQuote || wantsHistory)) {
    add({ agent: "market", tool: "get_quote", args: { tickers }, why: "fresh quotes" });
    if (wantsHistory)
      add({ agent: "market", tool: "get_history", args: { ticker: t0, days: 60 }, why: "60-session trend" });
  }
  if (t0 && wantsValuation) {
    add({ agent: "market", tool: "get_fundamentals", args: { ticker: t0 }, why: "live valuation metrics" });
  }

  // --- profile cover
  if (t0 && (actions.length === 0 || has("tell me about", "what is", "overview", "details", "profile", "fundamentals", "about"))) {
    add({ agent: "graph", tool: "company_profile", args: { query: t0 }, why: "graph profile" });
    if (!actions.some((a) => a.tool === "get_quote"))
      add({ agent: "market", tool: "get_quote", args: { tickers: [t0] }, why: "context quote" });
    if (!actions.some((a) => a.tool === "graph_peers"))
      add({ agent: "graph", tool: "graph_peers", args: { ticker: t0 }, why: "peer context" });
  }

  // --- news / filings / positions
  if (
    t0 &&
    has(
      "news", "headline", "headlines", "what happened", "why did", "why is",
      "dropping", "dropped", "surge", "surged", "jumped", "fell", "falling",
      "climbing", "announcement", "press release",
    )
  ) {
    add({ agent: "market", tool: "get_news", args: { ticker: t0, limit: 5 }, why: "headline context" });
  }
  if (
    t0 &&
    has("filing", "filings", "10-k", "10-k", "20-f", "edgar", "sec filing", "annual report", "audited")
  ) {
    add({ agent: "market", tool: "get_facts", args: { ticker: t0 }, why: "audited XBRL facts" });
  }
  if (has("my position", "my positions", "my holding", "my holdings", "my book", "my portfolio", "what do i own", "unrealized", "p&l", "pnl")) {
    if (has("risk", "exposure", "propagat", "stress", "supply")) {
      add({ agent: "graph", tool: "portfolio_risk", args: {}, why: "portfolio-level risk" });
    } else {
      add({ agent: "graph", tool: "position_list", args: {}, why: "portfolio marked to market" });
    }
  }

  // --- last resorts
  if (actions.length === 0) {
    if (t0) {
      add({ agent: "graph", tool: "company_profile", args: { query: t0 }, why: "default profile" });
      add({ agent: "market", tool: "get_quote", args: { tickers: [t0] }, why: "default quote" });
    } else {
      add({ agent: "memory", tool: "memory_recall", args: { query: topic || question }, why: "memory-first fallback" });
      add({ agent: "brain", tool: "brain_org", args: {}, why: "org context fallback" });
    }
  }

  // memory recall is always part of the plan (runs first)
  const exec = ["market", "graph", "brain"].filter((a) => plan.has(a));
  return {
    plan: ["memory", ...exec, "synthesize"],
    actions,
    reason: "policy router (keyword + entity extraction)",
  };
}

async function llmRoute(question: string, tickers: string[], base: PlanOut): Promise<PlanOut> {
  try {
    const tools = listTools()
      .map((t) => `- ${t.name}: ${t.description}\n  inputSchema: ${JSON.stringify(t.inputSchema)}`)
      .join("\n");
    const out = await chatJson<{ actions?: { tool: string; args: Record<string, unknown>; why?: string }[] }>({
      system:
        "You are the supervisor of a financial desk. Choose which MCP tools to call to answer the user. Reply ONLY with JSON: {\"actions\":[{\"tool\":\"name\",\"args\":{...},\"why\":\"short\"}]}. Pick between 1 and 6 actions. Tickers must be uppercase. If tickers are detected, always include get_quote for them, and include get_fundamentals when the question involves valuation, P/E, earnings, targets, or a buy/sell judgement. Use each tool's inputSchema exactly for args.",
      prompt: `User question: "${question}"\nDetected tickers: ${tickers.join(", ") || "none"}\n\nAvailable tools:\n${tools}`,
      temperature: 0.1,
    });
    const acts = (out.actions ?? [])
      .filter((a) => a && typeof a.tool === "string")
      .slice(0, 6)
      .map((a) => ({
        agent: agentForTool(a.tool),
        tool: a.tool,
        args: a.args ?? {},
        why: a.why ?? "llm plan",
      }));
    if (acts.length === 0) throw new Error("empty plan");
    // Safety net: a small model can miss an obvious keyword intent (a
    // "supply chain risk" question that plans no traversal). Union in any
    // heuristic action whose tool the LLM didn't pick.
    for (const h of base.actions) {
      const existing = acts.find((a) => a.tool === h.tool);
      if (!existing) {
        acts.push({ ...h, why: `${h.why} (heuristic cover)` });
      } else if (
        h.tool === "get_quote" &&
        Array.isArray(h.args.tickers) &&
        Array.isArray(existing.args.tickers)
      ) {
        existing.args.tickers = [
          ...new Set([...existing.args.tickers, ...h.args.tickers]),
        ].slice(0, 5);
      }
    }
    if (acts.length > 8) acts.length = 8;
    const planAgents = ["memory", ...[...new Set(acts.map((a) => a.agent))], "synthesize"];
    return { plan: planAgents, actions: acts, reason: "LLM supervisor (ChatOllama)" };
  } catch {
    return base;
  }
}

function agentForTool(tool: string): string {
  if (tool.startsWith("get_")) return "market";
  if (tool.startsWith("graph_") || tool === "company_profile") return "graph";
  if (tool.startsWith("brain_")) return "brain";
  return "memory";
}

/* ------------------------------ nodes ------------------------------ */

async function supervisorNode(s: Desk): Promise<Partial<Desk>> {
  const state = s as EngineInput & { llm: boolean };
  await ensureSeed();
  const syncTickers = extractTickers(state.question);
  // async universe resolution: every mentioned company name → canonical
  // symbol (graph fast-path, else Yahoo search + one-time Company ingest)
  // so routing, tools and the graph all agree on the same identity.
  const mentions = extractMentions(state.question);
  const mentionHits = await Promise.all(
    mentions.slice(0, 3).map((m) => resolveMention(m)),
  );
  const tickers = [
    ...new Set(
      [
        ...syncTickers,
        ...mentionHits.filter((h): h is ResolvedSymbol => h !== null).map((h) => h.symbol),
      ].map((t) => t.toUpperCase()),
    ),
  ].slice(0, 5);
  const heuristic = heuristicRoute(state.question, tickers);
  const { up } = await ollamaUp();
  const routed = up ? await llmRoute(state.question, tickers, heuristic) : heuristic;
  // llmRoute merges the heuristic plan (always starts with memory) with the
  // model's plan — dedupe, order-preserving, so the emitted PLAN is clean
  const plan = [...new Set(routed.plan)];
  await emit(
    state.runId,
    state.sessionId,
    "ORCHESTRA",
    "route",
    `PLAN [${plan.join(" → ")}] :: ${routed.reason}${tickers.length ? ` · entities: ${tickers.join(", ")}` : ""}`,
  );
  await bumpAgent("supervisor");
  return { plan, actions: routed.actions, llm: up, routeReason: routed.reason };
}

async function memoryNode(s: Desk): Promise<Partial<Desk>> {
  const recalled: string[] = [];
  await emit(s.runId, s.sessionId, "ARCHIVE", "handoff", "ORCHESTRA → ARCHIVE :: recall before reasoning");
  // Recall first, unless the plan already scheduled its own memory_recall.
  const plannedRecall = s.actions.some(
    (a) => a.agent === "memory" && a.tool === "memory_recall",
  );
  if (!plannedRecall) {
    try {
      const r = await callTool(
        "memory_recall",
        { query: s.question.slice(0, 200) },
        { tenant: s.tenant, runId: s.runId },
      );
      const data = r.data as { episodic: { content: string }[]; semantic: { text: string; kind: string; confidence: number }[] };
      for (const e of data.episodic.slice(0, 3)) recalled.push(`episode: ${e.content.slice(0, 140)}`);
      for (const m of data.semantic.slice(0, 4)) recalled.push(`${m.kind}: ${m.text.slice(0, 140)}`);
      await emit(s.runId, s.sessionId, "ARCHIVE", "tool", `memory_recall :: ${r.summary}`);
    } catch (e) {
      await emit(s.runId, s.sessionId, "ARCHIVE", "error", `recall failed: ${msg(e)}`);
    }
  }
  // Execute the plan's memory writes (memory_store / list_procedures / …).
  const artifacts = await runAgentTools(s, "memory");
  return { recalled, artifacts, attempted: ["memory"] };
}

async function runAgentTools(s: Desk, agent: string): Promise<Artifact[]> {
  const mine = s.actions.filter((a) => a.agent === agent);
  const artifacts: Artifact[] = [];
  for (const a of mine) {
    const t0 = Date.now();
    try {
      const r = await callTool(a.tool, a.args, { tenant: s.tenant, runId: s.runId });
      await emit(
        s.runId,
        s.sessionId,
        agentName(agent),
        "tool",
        `MCP ${a.tool}(${shortArgs(a.args)}) → ${r.summary} [${Date.now() - t0}ms]`,
      );
      artifacts.push({ agent, tool: a.tool, args: a.args, summary: r.summary, data: r.data, sources: r.sources });
    } catch (e) {
      await emit(s.runId, s.sessionId, agentName(agent), "error", `MCP ${a.tool} failed: ${msg(e)}`);
    }
  }
  await bumpAgent(agent);
  return artifacts;
}

function agentName(a: string): string {
  return {
    market: "TICKER",
    graph: "TOPOLOGY",
    brain: "PROVENANCE",
    memory: "ARCHIVE",
    synth: "DESK-WRITER",
  }[a] ?? a.toUpperCase();
}

function shortArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join(", ")
    .slice(0, 80);
}

async function marketNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "TICKER", "handoff", "ARCHIVE → TICKER :: market plane via MCP");
  return { artifacts: await runAgentTools(s, "market"), attempted: ["market"] };
}

async function graphNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "TOPOLOGY", "handoff", "ARCHIVE → TOPOLOGY :: cypher traversals via MCP");
  return { artifacts: await runAgentTools(s, "graph"), attempted: ["graph"] };
}

async function brainNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "PROVENANCE", "handoff", "ARCHIVE → PROVENANCE :: company brain via MCP");
  return { artifacts: await runAgentTools(s, "brain"), attempted: ["brain"] };
}

/* --------------------------- synthesis ----------------------------- */

 
const isArr = (d: any): d is any[] => Array.isArray(d);

/**
 * Readable traversal chain for a path row. The embedded executor returns
 * `readable` ("TSM -[SUPPLIES]-> NVDA"); live Cypher rows only carry the
 * `chain` list — fall back so live answers never print "undefined".
 */
function chainText(r: Record<string, unknown>): string {
  const readable = r.readable;
  if (typeof readable === "string" && readable) return readable;
  if (Array.isArray(r.chain)) return r.chain.map((x) => String(x)).join(" → ");
  return "";
}

function renderQuotes(data: unknown[]): string {
  const rows = data
    .map((q) => {
      const x = q as any;
      if (!x?.ticker) return null;
      const dir = Number(x.changePct) >= 0 ? "▲" : "▼";
      return `| ${x.ticker} | ${fmtMoney(Number(x.price), String(x.currency ?? "USD"))} | ${dir} ${Math.abs(Number(x.changePct)).toFixed(2)}% | ${x.source} |`;
    })
    .filter(Boolean);
  if (!rows.length) return "";
  return [
    "### Live quotes",
    "| Ticker | Last | Session chg | Feed |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function synthDeterministic(s: Desk): { answer: string; sources: Source[] } {
  const parts: string[] = [];
  // stable source numbering: flatten first, cite by true index
  const flat: Source[] = [];
  const citeIdx = new Map<Artifact, number[]>();
  for (const a of s.artifacts) {
    citeIdx.set(a, a.sources.map((_, i) => flat.length + i + 1));
    flat.push(...a.sources);
  }
  const cite = (art: Artifact) => (citeIdx.get(art) ?? []).map((n) => `[S${n}]`).join(" ");

    for (const art of s.artifacts) {
    const d = art.data;
    switch (art.tool) {
      case "get_quote":
        if (isArr(d)) parts.push(renderQuotes(d));
        break;
      case "get_fundamentals": {
        const f = d as Record<string, unknown> | null;
        if (f?.ticker) {
          const r2 = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : null);
          const pct = (n: unknown) => (typeof n === "number" ? (n * 100).toFixed(1) + "%" : null);
          const row = (label: string, v: string | null) => (v ? `- ${label}: ${v}\n` : "");
          const cur = typeof f.currency === "string" ? f.currency : "USD";
          const money = (n: unknown) => (typeof n === "number" ? fmtMoney(r2(n) as number, cur) : null);
          parts.push(
            `### Fundamentals ${String(f.ticker)} ${cite(art)}\n` +
              row("Trailing P/E", typeof f.trailingPE === "number" ? `${r2(f.trailingPE)}x` : null) +
              row("Forward P/E", typeof f.forwardPE === "number" ? `${r2(f.forwardPE)}x` : null) +
              row("EPS (ttm)", money(f.epsTrailing)) +
              row("Analyst mean target", money(f.targetMean)) +
              row("Analyst target range", typeof f.targetLow === "number" && typeof f.targetHigh === "number" ? `${fmtMoney(r2(f.targetLow) as number, cur)} – ${fmtMoney(r2(f.targetHigh) as number, cur)}` : null) +
              row("Recommendation", typeof f.recommendation === "string" ? f.recommendation.replace(/_/g, " ") : null) +
              row("Market cap", typeof f.marketCap === "number" ? fmtMoneyCompact(f.marketCap, cur) : null) +
              row("Profit margin", pct(f.profitMargin)) +
              row("Revenue growth (yoy)", pct(f.revenueGrowth)) +
              row("Dividend yield", pct(f.dividendYield)) +
              row("52-week range", typeof f.week52Low === "number" && typeof f.week52High === "number" ? `${fmtMoney(r2(f.week52Low) as number, cur)} – ${fmtMoney(r2(f.week52High) as number, cur)}` : null) +
              "\n",
          );
        }
        break;
      }
      case "get_history": {
        const pts = (d as any)?.points ?? [];
        if (pts.length) {
          const r2 = (n: number) => Math.round(n * 100) / 100;
          const cur = typeof (d as any)?.currency === "string" ? (d as any).currency : "USD";
          const money = (n: number) => fmtMoney(n, cur);
          const first = r2(pts[0].close), last = r2(pts[pts.length - 1].close);
          const min = r2(Math.min(...pts.map((p: { close: number }) => p.close)));
          const max = r2(Math.max(...pts.map((p: { close: number }) => p.close)));
          parts.push(
            `### 60-session trend\n${s.actions.find((a) => a.tool === "get_history")?.args?.ticker}: ${money(first)} → **${money(last)}** (range ${money(min)} – ${money(max)}) ${cite(art)}\n`,
          );
        }
        break;
      }
      case "company_profile": {
        if (d) {
          const p = d as any;
          const cap =
            Number(p.marketCapB) > 0
              ? `~${fmtMoneyCompact(Number(p.marketCapB) * 1e9, typeof p.currency === "string" ? p.currency : "USD")}`
              : "—";
          const sector = [p.sector, p.industry].filter((v) => v && v !== "—").join(" · ") || "—";
          const employees = Number(p.employees) > 0 ? `~${Number(p.employees).toLocaleString()}` : "—";
          parts.push(
            `### ${p.name} (${p.ticker})\n${p.description ?? ""}\n\n| Field | Value |\n| --- | --- |\n| Sector | ${sector} |\n| Market cap | ${cap} |\n| Employees | ${employees} |\n| Founded | ${p.founded || "—"} |\n${cite(art)}`,
          );
        } else parts.push(`_${art.summary}_`);
        break;
      }
      case "get_news": {
        const items = (isArr(d) ? d : []) as Array<Record<string, unknown>>;
        if (items.length) {
          const lines = items
            .map((n) => `- ${String(n.title)} — ${String(n.publisher)} (${new Date(Number(n.ts)).toISOString().slice(0, 10)})`)
            .join("\n");
          parts.push(`### Headlines ${cite(art)}\n${lines}\n`);
        }
        break;
      }
      case "get_facts": {
        const fp = d as Record<string, unknown> | null;
        if (fp && Array.isArray((fp as any).facts)) {
          const facts = (fp as any).facts as Array<Record<string, unknown>>;
          const lines = facts
            .map((f) => {
              const v =
                f.metric === "epsDiluted"
                  ? fmtMoney(Number(f.value), "USD")
                  : fmtMoneyCompact(Number(f.value), "USD");
              return `- ${f.metric}: ${v} (${f.form} filed ${f.filed})`;
            })
            .join("\n");
          parts.push(`### SEC filings — ${fp.name} ${cite(art)}\n${lines}\n`);
        }
        break;
      }
      case "position_list": {
        const pos = (isArr(d) ? d : []) as Array<Record<string, unknown>>;
        if (pos.length) {
          const rows = pos.map(
            (x) =>
              `| ${x.ticker} | ${x.qty} | ${fmtMoney(Number(x.avgCost), String(x.currency ?? "USD"))} | ${fmtMoney(Number(x.price), String(x.currency ?? "USD"))} | ${fmtMoney(Number(x.value), String(x.currency ?? "USD"))} | ${fmtMoney(Number(x.pnl), String(x.currency ?? "USD"))} (${Number(x.pnlPct).toFixed(1)}%) |`,
          );
          parts.push(
            [
              "### Your book " + cite(art),
              "| Ticker | Qty | Avg cost | Last | Value | P&L |",
              "| --- | --- | --- | --- | --- | --- |",
              ...rows,
              "",
            ].join("\n"),
          );
        }
        break;
      }
      case "portfolio_risk": {
        const pr = d as Record<string, unknown> | null;
        if (pr && Array.isArray(pr.positions) && pr.positions.length) {
          const pos = pr.positions as Array<Record<string, unknown>>;
          const risk = (Array.isArray(pr.risk) ? pr.risk : []) as Array<Record<string, unknown>>;
          const rows = pos.map(
            (x) =>
              `| ${x.ticker} | ${fmtMoney(Number(x.value), String(x.currency ?? "USD"))} | ${fmtMoney(Number(x.pnl), String(x.currency ?? "USD"))} |`,
          );
          const web = risk
            .filter((r) => Number(r.count) > 0)
            .map((r) => {
              const chains = (Array.isArray(r.dependents) ? r.dependents : [])
                .slice(0, 2)
                .map((dep) => chainText(dep as Record<string, unknown>))
                .filter(Boolean)
                .join("; ");
              return `- ${r.ticker}: ${r.count} dependent(s) within 3 hops${chains ? ` — ${chains}` : ""}`;
            });
          parts.push(
            [
              "### Portfolio risk " + cite(art),
              "| Ticker | Value | P&L |",
              "| --- | --- | --- |",
              ...rows,
              ...(web.length ? ["", "**In the supply web:**", ...web] : ["", "_No holdings sit inside a mapped supply chain yet._"]),
              "",
            ].join("\n"),
          );
        }
        break;
      }
      case "graph_peers": {
         
        const rivals = (d as any)?.rivals ?? [];
         
        const sector = (d as any)?.sectorPeers ?? [];
        if (rivals.length)
          parts.push(`### Direct rivals (COMPETES_WITH)\n${rivals.map((r: { name: string; ticker: string; arena: string }) => `- **${r.name} (${r.ticker})** — arena: ${r.arena}`).join("\n")}`);
        if (sector.length)
          parts.push(`### Sector peers (2-hop via IN_SECTOR)\n${sector.map((r: { name: string; ticker: string }) => `${r.ticker}`).join(" · ")} ${cite(art)}`);
        break;
      }
      case "graph_supply_chain": {
         
        const row = (isArr(d) ? d[0] : d) as any;
        const sup = row?.suppliers ?? [], cus = row?.customers ?? [];
        if (sup.length || cus.length) {
          parts.push(
            `### Supply web ${cite(art)}\n**Suppliers (upstream):**\n${sup.map((x: { ticker: string; name: string; component: string; criticality: number }) => `- **${x.ticker}** (${x.name}) — ${x.component} · criticality ${x.criticality}`).join("\n") || "- none on graph"}\n\n**Customers (downstream):**\n${cus.map((x: { ticker: string; name: string; component: string }) => `- **${x.ticker}** (${x.name}) — ${x.component}`).join("\n") || "- none on graph"}`,
          );
        }
        break;
      }
      case "graph_risk_paths": {
        if (isArr(d) && d.length) {
          parts.push(
            `### Contagion map — who depends on this name ${cite(art)}\n${d.slice(0, 8).map((r: { hops: number }) => `- \`${chainText(r)}\` (${r.hops} hop${r.hops > 1 ? "s" : ""})`).join("\n")}\n\n**Desk action:** hedges and exposure checks should prioritize the ${d.filter((x: { hops: number }) => x.hops === 1).length} first-order dependent(s) shown above.`,
          );
        } else parts.push("_No downstream dependents on the graph._");
        break;
      }
      case "graph_path": {
        if (isArr(d) && d.length)
          parts.push(`### Relationship path ${cite(art)}\n\`${chainText(d[0])}\`\n\n_${d[0].hops} hop(s) — every hop is a stated relationship edge._`);
        else parts.push("_No relationship path found between those two names on the graph._");
        break;
      }
      case "graph_centrality": {
        if (isArr(d)) {
          parts.push(
            `### Most connected companies (degree centrality) ${cite(art)}\n${d.slice(0, 6).map((c: { ticker: string; name: string; degree: number }, i: number) => `${i + 1}. **${c.ticker}** — ${c.degree} edges (${c.name})`).join("\n")}`,
          );
        }
        break;
      }
      case "brain_decisions": {
        if (isArr(d) && d.length) {
          parts.push(
            `### Decision provenance ${cite(art)}\n${d.map((x: { title: string; date: string; status: string; rationale: string; sources: string[]; deciders: string[]; tickers: string[] }) => `**${x.title}** _(${x.date} · ${x.status})_\n${x.rationale}\n- decided by: ${x.deciders.join(", ") || "—"} · mentions: ${x.tickers.join(", ") || "—"}\n- derived from: ${x.sources.map((t: string) => `“${t}”`).join(", ") || "no documents linked (unprovenanced!)"}`).join("\n\n")}`,
          );
        } else parts.push("_No decisions found on that topic in the company brain._");
        break;
      }
      case "brain_who_knows": {
        if (isArr(d) && d.length) {
          parts.push(
            `### Who owns / knows ${cite(art)}\n${d.map((x: { person: string; role: string; via: string; thing: string }) => `- **${x.person}** (${x.role}) — ${x.via.replace(/_/g, " ")} → ${x.thing}`).join("\n")}`,
          );
        } else parts.push("_Nobody formally connected to that topic yet — consider assigning an owner via the Brain page._");
        break;
      }
      case "brain_org": {
        if (isArr(d)) {
          parts.push(
            `### Org graph ${cite(art)}\n${d.map((t: { team: string; focus: string; members: string[]; projects: { name: string; status: string; lead: string | null }[] }) => `**${t.team}** — ${t.focus}\n- members: ${t.members.join(", ") || "—"}\n${t.projects.map((p) => `- project: ${p.name} (${p.status}${p.lead ? ` · lead ${p.lead}` : ""})`).join("\n")}`).join("\n\n")}`,
          );
        }
        break;
      }
      case "brain_ingest_document":
      case "brain_record_decision":
      case "memory_store":
        parts.push(`### Written to graph\n${art.summary} ${cite(art)}`);
        break;
      case "memory_recall": {
         
        const eps = (d as any)?.episodic ?? [];
         
        const sem = (d as any)?.semantic ?? [];
        if (eps.length || sem.length) {
          const lines: string[] = [];
          for (const m of sem)
            lines.push(`- [${m.kind} · confidence ${m.confidence ?? 1}] ${m.text}`);
          for (const e of eps)
            lines.push(`- [${e.role} · past session] ${String(e.content).slice(0, 180)}`);
          parts.push(`### From memory ${cite(art)}\n${lines.join("\n")}`);
        } else parts.push("_Nothing in memory matches that yet._");
        break;
      }
      case "list_procedures": {
        if (isArr(d) && d.length)
          parts.push(
            `### Desk procedures (procedural memory) ${cite(art)}\n${d.map((p: { text: string }, i: number) => `${i + 1}. ${p.text}`).join("\n")}`,
          );
        else parts.push("_No procedures stored yet._");
        break;
      }
      default:
        parts.push(`_${art.summary}_`);
    }
  }

  if (s.recalled.length) {
    parts.unshift(
      `### Recalled from memory (Track 2)\n${s.recalled.map((r) => `- ${r}`).join("\n")}\n`,
    );
  }

  const trace = s.artifacts.map((a) => `${agentName(a.agent)}.${a.tool}`).join(" → ");
  parts.push(
    `---\n**Reasoning trace:** ORCHESTRA.route → ARCHIVE.recall${trace ? ` → ${trace}` : ""} → DESK-WRITER.synthesize · routed by _${s.routeReason}_`,
  );

  const body = parts.filter(Boolean).join("\n\n");
  return { answer: body || "I could not assemble anything for that — try a ticker, a company name, or \"who owns...\".", sources: flat };
}

async function synthesizeNode(s: Desk): Promise<Partial<Desk>> {
  await emit(s.runId, s.sessionId, "DESK-WRITER", "handoff", "specialists → DESK-WRITER :: composing answer");
  const { answer, sources } = synthDeterministic(s);

  let final = answer;
  let draft = "";
  if (s.llm && s.artifacts.length) {
    try {
      draft = (
        await chatText({
          system:
            "You are a buy-side desk writer. Three sentences max, decisive, no hype. Lead with the number, then the relationship insight, then the action. Do not repeat the tables. HARD RULES: only state figures that appear in the artifact summaries; never invent or estimate P/E, EPS, price targets, growth rates or margins; never re-label a figure (a quote price is not a position size or exposure amount). Portfolio figures come ONLY from position tools when those artifacts are present — never estimate holdings, sizes or exposures. If a requested figure is absent, note its absence in one clause and move on.",
          prompt: `Question: "${s.question}"\nArtifact summaries:\n${s.artifacts.map((a) => `- ${a.summary}`).join("\n")}`,
          temperature: 0.3,
          maxTokens: 220,
        })
      ).trim();
      // never render an empty brief (thinking models can starve the budget)
      if (draft) final = `### Desk view\n${draft}\n\n${answer}`;
    } catch {
      /* LLM optional */
    }

    // critic: adversarial check of the brief against artifacts only —
    // one rewrite pass, then annotate. Catches fabricated/mislabelled
    // figures at generation time instead of at debugging time.
    if (draft) {
      try {
        const verdict = await chatJson<{ ok?: boolean; issues?: string[] }>({
          system:
            'Fact-check the draft ONLY against the artifact summaries: every number/proper noun must appear there; a quote price must not be re-labelled as a position/exposure. Return STRICT JSON only, under 60 words total: {"ok": boolean, "issues": ["max 3 issues, max 6 words each"]}.',
          prompt: `Artifacts:\n${s.artifacts.map((a) => `- ${a.summary}`).join("\n")}\n\nDraft:\n${draft}`,
          temperature: 0,
          maxTokens: 300,
        });
        const issues = Array.isArray(verdict.issues) ? verdict.issues.filter((x) => typeof x === "string") : [];
        if (verdict.ok === false && issues.length) {
          let fixed = "";
          try {
            fixed = (
              await chatText({
                system:
                  "Rewrite the desk brief fixing ONLY the listed issues. Keep it three sentences, decisive, figures strictly from the artifacts. No commentary.",
                prompt: `Issues:\n${issues.map((i) => `- ${i}`).join("\n")}\n\nArtifacts:\n${s.artifacts.map((a) => `- ${a.summary}`).join("\n")}\n\nDraft:\n${draft}`,
                temperature: 0.2,
                maxTokens: 220,
              })
            ).trim();
          } catch {
            /* rewrite optional */
          }
          if (fixed) {
            final = `### Desk view\n${fixed}\n\n${answer}`;
            await emit(s.runId, s.sessionId, "CRITIC", "verify", `draft rejected :: ${issues.length} issue(s) — rewrite applied`);
          } else {
            final = `### Desk view\n${draft}\n\n> ⚠ unverified: ${issues.slice(0, 3).join("; ")}\n\n${answer}`;
            await emit(s.runId, s.sessionId, "CRITIC", "verify", `draft rejected :: ${issues.length} issue(s) — annotated`);
          }
        } else if (verdict.ok === true) {
          await emit(s.runId, s.sessionId, "CRITIC", "verify", "draft verified :: figures match artifacts");
        } else {
          await emit(s.runId, s.sessionId, "CRITIC", "verify", "critic inconclusive :: model returned no verdict — draft shipped as-is");
        }
      } catch (e) {
        await emit(s.runId, s.sessionId, "CRITIC", "verify", `critic skipped :: ${msg(e)}`);
      }
    }
  }

  // flatten + renumber sources
  const flat: Source[] = [];
  for (const a of s.artifacts) flat.push(...a.sources);
  const srcBlock = flat.length
    ? `\n\n**Sources**\n${flat.map((x, i) => `[S${i + 1}] ${x.label}`).join("\n")}`
    : "";

  await emit(s.runId, s.sessionId, "DESK-WRITER", "answer", `answer composed :: ${flat.length} sources, ${s.artifacts.length} tool artifacts`);
  await bumpAgent("synth");
  return { answer: final + srcBlock, sources: flat };
}

async function scribeNode(s: Desk): Promise<Partial<Desk>> {
  // Track 2: persist episodic nodes (both turns) for the tenant
  const ts = Date.now();
  await graphRun("putEpisode", {
    key: `Episode:${s.runId}:a`,
    tenant: s.tenant,
    sessionId: s.sessionId,
    role: "assistant",
    content: s.answer.slice(0, 1500),
    ts,
  });
  await emit(s.runId, s.sessionId, "ARCHIVE", "memory", `episode stored :: session ${s.sessionId} (tenant ${s.tenant})`);
  return {};
}

/* ---------------------------- compile ------------------------------ */

function nextStep(s: Desk): string {
  const done = new Set([...s.attempted, ...s.artifacts.map((art) => art.agent)]);
  // order-preserving: market → graph → brain → synthesize.
  // `attempted` (not artifacts) decides — a specialist whose tools all
  // failed still counts as done, otherwise the graph loops forever.
  for (const a of ["market", "graph", "brain"] as const) {
    if (s.actions.some((act) => act.agent === a) && !done.has(a)) return a;
  }
  return "synthesize";
}

const workflow = new StateGraph(DeskState)
  .addNode("supervisor", supervisorNode)
  .addNode("memory", memoryNode)
  .addNode("market", marketNode)
  .addNode("graph", graphNode)
  .addNode("brain", brainNode)
  .addNode("synthesize", synthesizeNode)
  .addNode("scribe", scribeNode)
  .addEdge(START, "supervisor")
  .addEdge("supervisor", "memory")
  .addConditionalEdges("memory", nextStep, {
    market: "market",
    graph: "graph",
    brain: "brain",
    synthesize: "synthesize",
  })
  .addConditionalEdges("market", nextStep, {
    graph: "graph",
    brain: "brain",
    synthesize: "synthesize",
    market: "market",
  })
  .addConditionalEdges("graph", nextStep, {
    brain: "brain",
    synthesize: "synthesize",
    market: "market",
    graph: "graph",
  })
  .addConditionalEdges("brain", nextStep, {
    synthesize: "synthesize",
    market: "market",
    graph: "graph",
    brain: "brain",
  })
  .addEdge("synthesize", "scribe")
  .addEdge("scribe", END);

 
const compiled: any = workflow.compile();

export async function runEngine(input: EngineInput): Promise<{ answer: string }> {
  const out = (await compiled.invoke({
    ...input,
    recalled: [],
    attempted: [],
    artifacts: [],
    sources: [],
  })) as Desk;
  return { answer: out.answer };
}

/** Persist assistant message at the end of a run (called by the API). */
export async function saveAssistant(
  sessionId: number,
  runId: string,
  answer: string,
  sources: Source[],
) {
  await db.insert(chatMessages).values({
    sessionId,
    role: "assistant",
    content: answer,
    sources,
    runId,
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : "unknown";
}
