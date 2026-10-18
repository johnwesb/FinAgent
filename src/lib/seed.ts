/**
 * Seed — the desk's agent roster (SQL plumbing) + the ENTIRE knowledge
 * graph, written through the graph driver so it lands inside whichever
 * real FalkorDB engine is active (remote server or embedded lite engine):
 *
 *   companies, sectors, funds, supply web, ownership ..... Track 1 fuel
 *   procedural memory .................................... Track 2 fuel
 *   people, teams, projects, documents, decisions ........ Track 3 fuel
 */

import { db } from "@/db";
import { agents } from "@/db/schema";
import { sql } from "drizzle-orm";
import { graphRun, graphStatus, graphWipe } from "./graph";

const ROSTER = [
  {
    key: "supervisor", name: "ORCHESTRA", role: "Supervisor / Router", callsign: "ORC",
    model: "llama3.1:8b", temperature: 0.2, color: "#C6FF4A",
    directive: "Read the question, plan the desk, hand off precisely.",
    tools: "plan, route, handoff",
    systemPrompt: "You are ORCHESTRA, the supervisor of a financial research desk. You decompose each question into specialist work: market data, graph analysis, company-brain lookups, memory recall. You never answer directly — you plan and hand off.",
  },
  {
    key: "market", name: "TICKER", role: "Market Data Agent", callsign: "MKT",
    model: "llama3.1:8b", temperature: 0.2, color: "#46E0C0",
    directive: "Fresh prices first. Every number sourced.",
    tools: "get_quote, get_history",
    systemPrompt: "You are TICKER, market data agent. You fetch real-time quotes and history, mark the source and delay, and persist every print into the graph.",
  },
  {
    key: "graph", name: "TOPOLOGY", role: "Graph Analyst", callsign: "GRF",
    model: "llama3.1:8b", temperature: 0.3, color: "#8B7CFF",
    directive: "Multi-hop or nothing. Show the path.",
    tools: "graph_peers, graph_supply_chain, graph_risk_paths, graph_path, graph_centrality, company_profile",
    systemPrompt: "You are TOPOLOGY, graph analyst. You reason over the connected graph: competitors, supply chains, risk propagation, centrality. Every claim is a traversal you can show.",
  },
  {
    key: "brain", name: "PROVENANCE", role: "Company Brain Agent", callsign: "BRN",
    model: "llama3.1:8b", temperature: 0.3, color: "#FFB14A",
    directive: "Every decision traces to a source.",
    tools: "brain_decisions, brain_who_knows, brain_org, brain_ingest_document, brain_record_decision",
    systemPrompt: "You are PROVENANCE, keeper of the company brain. People, teams, projects, documents, decisions — you answer who owns what, who knows what, and why a decision was made, always with sources.",
  },
  {
    key: "memory", name: "ARCHIVE", role: "Memory Agent", callsign: "MEM",
    model: "llama3.1:8b", temperature: 0.2, color: "#5AA9FF",
    directive: "Never lose a session. Recall before you reason.",
    tools: "memory_recall, memory_store, list_procedures",
    systemPrompt: "You are ARCHIVE, memory agent. You persist every session episodically, store facts semantically, keep procedures, and recall across sessions for your tenant before anyone answers.",
  },
  {
    key: "synth", name: "DESK-WRITER", role: "Synthesis Agent", callsign: "SYN",
    model: "llama3.1:8b", temperature: 0.4, color: "#FF5470",
    directive: "Compress to decisions. Cite everything.",
    tools: "synthesize, citations",
    systemPrompt: "You are DESK-WRITER. You compress the desk's artifacts into an investor-grade answer with numbered sources and a visible reasoning trace.",
  },
] as const;

const COMPANIES: Array<Record<string, unknown>> = [
  { ticker: "AAPL", name: "Apple Inc.", sector: "Technology", industry: "Consumer electronics", marketCapB: 3450, employees: 164000, founded: 1976, description: "iPhone, Mac, services ecosystem; premium hardware margins." },
  { ticker: "MSFT", name: "Microsoft Corp.", sector: "Technology", industry: "Cloud & software", marketCapB: 3180, employees: 221000, founded: 1975, description: "Azure cloud, Office, Copilot AI stack." },
  { ticker: "NVDA", name: "NVIDIA Corp.", sector: "Technology", industry: "Semiconductors", marketCapB: 3390, employees: 29600, founded: 1993, description: "GPU monopoly in AI training; data-center dominance." },
  { ticker: "GOOGL", name: "Alphabet Inc.", sector: "Technology", industry: "Internet platforms", marketCapB: 2170, employees: 182500, founded: 1998, description: "Search ads, YouTube, Google Cloud, Gemini models." },
  { ticker: "AMZN", name: "Amazon.com Inc.", sector: "Consumer", industry: "E-commerce & cloud", marketCapB: 2150, employees: 1525000, founded: 1994, description: "Retail marketplace, AWS, logistics network." },
  { ticker: "META", name: "Meta Platforms", sector: "Technology", industry: "Social platforms", marketCapB: 1480, employees: 72400, founded: 2004, description: "Facebook/Instagram ads, Llama open models, Reality Labs." },
  { ticker: "TSLA", name: "Tesla Inc.", sector: "Consumer", industry: "Electric vehicles", marketCapB: 790, employees: 140500, founded: 2003, description: "EVs, energy storage, autonomy bets." },
  { ticker: "AMD", name: "Advanced Micro Devices", sector: "Technology", industry: "Semiconductors", marketCapB: 197, employees: 26000, founded: 1969, description: "CPU/GPU challenger; MI300 AI accelerators." },
  { ticker: "INTC", name: "Intel Corp.", sector: "Technology", industry: "Semiconductors", marketCapB: 90, employees: 124800, founded: 1968, description: "x86 incumbency, foundry turnaround attempt." },
  { ticker: "AVGO", name: "Broadcom Inc.", sector: "Technology", industry: "Semiconductors", marketCapB: 800, employees: 37000, founded: 1991, description: "Custom AI silicon (XPU) + networking + VMware." },
  { ticker: "TSM", name: "Taiwan Semiconductor", sector: "Technology", industry: "Foundry", marketCapB: 1010, employees: 76000, founded: 1987, description: "The world's advanced-node foundry; makes chips for nearly everyone." },
  { ticker: "ASML", name: "ASML Holding", sector: "Technology", industry: "Semiconductor equipment", marketCapB: 270, employees: 42000, founded: 1984, description: "Sole EUV lithography supplier — the chokepoint of the chokepoint." },
  { ticker: "ORCL", name: "Oracle Corp.", sector: "Technology", industry: "Enterprise software", marketCapB: 480, employees: 159000, founded: 1977, description: "Database franchise + OCI cloud + AI infra contracts." },
  { ticker: "CRM", name: "Salesforce Inc.", sector: "Technology", industry: "SaaS", marketCapB: 316, employees: 73000, founded: 1999, description: "CRM platform, Slack, Agentforce push." },
  { ticker: "NFLX", name: "Netflix Inc.", sector: "Communication", industry: "Streaming", marketCapB: 385, employees: 13000, founded: 1997, description: "Global streaming leader, ads tier scaling." },
  { ticker: "DIS", name: "Walt Disney Co.", sector: "Communication", industry: "Media", marketCapB: 203, employees: 225000, founded: 1923, description: "Parks cash machine + streaming turnaround." },
  { ticker: "JPM", name: "JPMorgan Chase", sector: "Financials", industry: "Banking", marketCapB: 685, employees: 309000, founded: 1799, description: "Largest US bank; fortress balance sheet." },
  { ticker: "XOM", name: "Exxon Mobil", sector: "Energy", industry: "Integrated oil", marketCapB: 520, employees: 61000, founded: 1870, description: "Permian scale + Guyana growth." },
  { ticker: "BA", name: "Boeing Co.", sector: "Industrials", industry: "Aerospace", marketCapB: 118, employees: 171000, founded: 1916, description: "Duopoly airframes, quality-crisis recovery." },
  { ticker: "GE", name: "GE Aerospace", sector: "Industrials", industry: "Aerospace", marketCapB: 190, employees: 53000, founded: 1892, description: "Jet engines; LEAP ramp with Safran." },
];

const COMPETES: Array<[string, string, string, number]> = [
  ["AAPL", "GOOGL", "Mobile ecosystems & services", 0.7],
  ["MSFT", "GOOGL", "Cloud & AI assistants", 0.9],
  ["NVDA", "AMD", "AI accelerators", 0.9],
  ["NVDA", "INTC", "Silicon mindshare", 0.4],
  ["AMD", "INTC", "x86 CPUs", 0.9],
  ["NFLX", "DIS", "Streaming attention", 0.8],
  ["MSFT", "AMZN", "Cloud infrastructure", 0.9],
  ["ORCL", "MSFT", "Enterprise cloud", 0.6],
  ["BA", "GE", "Aerospace value chain", 0.3],
  ["META", "GOOGL", "Digital advertising", 0.8],
  ["CRM", "MSFT", "Enterprise SaaS", 0.7],
  ["AVGO", "NVDA", "Custom vs merchant AI silicon", 0.6],
];

const SUPPLIES: Array<[string, string, string, number]> = [
  ["TSM", "AAPL", "A-series & M-series silicon", 0.95],
  ["TSM", "NVDA", "GPU die fabrication (CoWoS)", 0.95],
  ["TSM", "AMD", "CPU/GPU die fabrication", 0.9],
  ["ASML", "TSM", "EUV lithography systems", 1.0],
  ["ASML", "INTC", "EUV lithography systems", 1.0],
  ["AVGO", "AAPL", "RF & wireless components", 0.7],
  ["INTC", "MSFT", "Server CPUs", 0.5],
  ["NVDA", "MSFT", "AI datacenter GPUs", 0.9],
  ["NVDA", "ORCL", "AI datacenter GPUs", 0.8],
  ["GE", "BA", "LEAP engines (via CFM JV)", 0.9],
  ["XOM", "TSLA", "Petrochemical feedstocks (indirect)", 0.2],
];

const FUNDS: Array<[string, string, number]> = [
  ["Vanguard", "AAPL", 8.4], ["BlackRock", "AAPL", 6.9], ["StateStreet", "AAPL", 4.1],
  ["Vanguard", "MSFT", 8.9], ["BlackRock", "MSFT", 7.3],
  ["Vanguard", "NVDA", 8.1], ["BlackRock", "NVDA", 6.9],
  ["Vanguard", "JPM", 9.2], ["BlackRock", "GOOGL", 6.6],
];

const SECTORS = ["Technology", "Consumer", "Communication", "Financials", "Energy", "Industrials"];

const PEOPLE = [
  { name: "Mira Chen", role: "Chief Investment Officer" },
  { name: "Dev Okafor", role: "Head of Research" },
  { name: "Sara Lindqvist", role: "Semiconductor Analyst" },
  { name: "Tom Alvarez", role: "Risk Manager" },
  { name: "Priya Nair", role: "Quant Developer" },
  { name: "Jonas Weber", role: "Portfolio Manager" },
];

const TEAMS = [
  { name: "Investment Committee", focus: "Final allocation decisions" },
  { name: "Semis Research Desk", focus: "Semiconductor & hardware coverage" },
  { name: "Risk Group", focus: "Exposure, drawdown, and contagion monitoring" },
];

const PROJECTS: Array<{ name: string; status: string; team: string; lead: string; workers: string[] }> = [
  { name: "AI Capex Tracker", status: "active", team: "Semis Research Desk", lead: "Sara Lindqvist", workers: ["Priya Nair", "Dev Okafor"] },
  { name: "Q3 Rebalance Playbook", status: "active", team: "Investment Committee", lead: "Mira Chen", workers: ["Jonas Weber"] },
  { name: "Supply Shock Watchlist", status: "active", team: "Risk Group", lead: "Tom Alvarez", workers: ["Priya Nair"] },
];

const MEMBERS: Array<[string, string]> = [
  ["Mira Chen", "Investment Committee"], ["Jonas Weber", "Investment Committee"], ["Dev Okafor", "Investment Committee"],
  ["Sara Lindqvist", "Semis Research Desk"], ["Dev Okafor", "Semis Research Desk"], ["Priya Nair", "Semis Research Desk"],
  ["Tom Alvarez", "Risk Group"],
];

const DOCUMENTS: Array<{ title: string; body: string; author: string }> = [
  { title: "TSMC CoWoS Capacity Brief", author: "Sara Lindqvist", body: "CoWoS advanced packaging remains the binding constraint on NVDA and AMD AI accelerator shipments through mid-year. TSM is doubling capacity; ASML EUV deliveries pace the long-term node roadmap. Watch TSM monthly revenue as the earliest public signal." },
  { title: "Q3 Investment Committee Memo", author: "Dev Okafor", body: "The committee reviewed AI capex durability across MSFT, GOOGL and AMZN. Consensus: hyperscaler budgets are titanium-clad for 2 more years; watch custom silicon from AVGO as a margin-risk wedge against NVDA." },
  { title: "EV Demand & Battery Teardown Deck", author: "Jonas Weber", body: "TSLA margin structure depends more on factory software than cell chemistry this decade. XOM's lithium ambitions are long-dated optionality at best." },
  { title: "Streaming Wars Scorecard", author: "Dev Okafor", body: "NFLX ads tier is compounding; DIS parks remain the cash engine funding its streaming gap. Content amortization discipline separates the two." },
];

const DECISIONS: Array<Record<string, unknown>> = [
  { title: "Overweight NVDA position", rationale: "Data-center GPU backlog visibility plus TSM CoWoS ramp — conviction high while hyperscaler capex holds.", date: "2025-08-14", status: "active", by: "Mira Chen", sources: ["TSMC CoWoS Capacity Brief", "Q3 Investment Committee Memo"], mentions: ["NVDA", "TSM", "MSFT"] },
  { title: "Exit full XOM position", rationale: "Capital re-allocated to semis; energy exposure better expressed via optionality later.", date: "2025-07-02", status: "executed", by: "Jonas Weber", sources: ["EV Demand & Battery Teardown Deck"], mentions: ["XOM"] },
  { title: "Add AMD to supply-shock watchlist", rationale: "If TSM capacity tightens, AMD gets squeezed after NVDA — second-order exposure must be monitored.", date: "2025-09-01", status: "active", by: "Tom Alvarez", sources: ["TSMC CoWoS Capacity Brief"], mentions: ["AMD", "TSM", "NVDA"] },
];

const PROCEDURES = [
  "Three-metric snapshot: always quote price, session changePct, and 60-session trend before opining on a ticker.",
  "Before flagging single-stock risk, run graph_risk_paths on its top supplier and list every 2-3 hop dependent.",
  "Any allocation claim must trace to a Decision node with DERIVED_FROM documents — otherwise label it unprovenanced.",
];

let seedPromise: Promise<void> | null = null;
let seededMode: string | null = null;

export async function ensureSeed(): Promise<void> {
  if (seedPromise) {
    // The boot ladder can swap graph backends at runtime (LIVE → LITE →
    // DEGRADED). A seed memoized against the old backend would leave the new
    // one empty forever — detect the swap and re-run for this backend.
    const { mode } = await graphStatus();
    if (mode !== seededMode) seedPromise = null;
  }
  if (!seedPromise) {
    seedPromise = run().catch((e) => {
      seedPromise = null;
      throw e;
    });
  }
  return seedPromise;
}

async function run(): Promise<void> {
  // agents roster (SQL plumbing)
  const aCount = await db.select({ n: sql<number>`count(*)::int` }).from(agents);
  if ((aCount[0]?.n ?? 0) === 0) {
    await db.insert(agents).values(ROSTER.map((r) => ({ ...r })));
  }

  // knowledge graph — only seed the active backend if it is empty
  const overview = await graphRun<{ total: number }>("graphOverview");
  seededMode = overview.mode;
  if ((overview.data?.total ?? 0) > 0) return;

  // companies + sectors
  for (const c of COMPANIES) {
    await graphRun("upsertNode", { label: "Company", key: `Company:${c.ticker}`, props: c });
  }
  for (const sec of SECTORS) {
    await graphRun("upsertNode", { label: "Sector", key: `Sector:${sec}`, props: { name: sec } });
  }
  for (const c of COMPANIES) {
    await graphRun("link", {
      src: `Company:${c.ticker}`,
      dst: `Sector:${c.sector}`,
      type: "IN_SECTOR",
    });
  }
  for (const [a, b, arena, intensity] of COMPETES) {
    await graphRun("link", { src: `Company:${a}`, dst: `Company:${b}`, type: "COMPETES_WITH", props: { arena, intensity } });
    await graphRun("link", { src: `Company:${b}`, dst: `Company:${a}`, type: "COMPETES_WITH", props: { arena, intensity } });
  }
  for (const [from, to, component, criticality] of SUPPLIES) {
    await graphRun("link", { src: `Company:${from}`, dst: `Company:${to}`, type: "SUPPLIES", props: { component, criticality } });
  }
  for (const [fund, ticker, pct] of FUNDS) {
    await graphRun("upsertNode", { label: "Fund", key: `Fund:${fund}`, props: { name: fund } });
    await graphRun("link", { src: `Fund:${fund}`, dst: `Company:${ticker}`, type: "OWNS", props: { pct } });
  }

  // company brain
  for (const p of PEOPLE) {
    await graphRun("upsertNode", { label: "Person", key: `Person:${p.name}`, props: p });
  }
  for (const t of TEAMS) {
    await graphRun("upsertNode", { label: "Team", key: `Team:${t.name}`, props: t });
  }
  for (const [p, t] of MEMBERS) {
    await graphRun("link", { src: `Person:${p}`, dst: `Team:${t}`, type: "MEMBER_OF" });
  }
  for (const pr of PROJECTS) {
    await graphRun("upsertNode", { label: "Project", key: `Project:${pr.name}`, props: { name: pr.name, status: pr.status } });
    await graphRun("link", { src: `Project:${pr.name}`, dst: `Team:${pr.team}`, type: "OWNED_BY" });
    await graphRun("link", { src: `Person:${pr.lead}`, dst: `Project:${pr.name}`, type: "LEADS" });
    for (const w of pr.workers) {
      await graphRun("link", { src: `Person:${w}`, dst: `Project:${pr.name}`, type: "WORKS_ON" });
    }
  }
  for (const d of DOCUMENTS) {
    const key = `Document:${d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    await graphRun("ingestDocument", { key, title: d.title, body: d.body, date: "2025-08-01" });
    await graphRun("link", { src: `Person:${d.author}`, dst: key, type: "AUTHORED" });
  }
  for (const dec of DECISIONS) {
    await graphRun("recordDecision", {
      key: `Decision:${String(dec.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title: dec.title,
      rationale: dec.rationale,
      date: dec.date,
      status: dec.status,
      decidedBy: dec.by,
      sources: dec.sources,
    });
  }
  for (const text of PROCEDURES) {
    await graphRun("putMemory", {
      key: `Memory:desk-1:${Buffer.from(text).toString("base64url").slice(0, 40)}`,
      tenant: "desk-1",
      kind: "procedural",
      text,
      topic: "desk policy",
      ts: Date.now(),
    });
  }
}

export async function wipeAll(): Promise<void> {
  seedPromise = null;
  const { events, chatMessages, chatSessions } = await import("@/db/schema");
  await db.delete(events);
  await db.delete(chatMessages);
  await db.delete(chatSessions);
  await graphWipe();
  await db.delete(agents);
}
