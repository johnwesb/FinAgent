# FinQDesk — Graph-Centred Autonomous Finance Desk

> **Graph Hacks 2026 submission** · WeMakeDevs × FalkorDB · Tracks:
> **1 — Agents That Act on Connected Data** · **2 — Agent Memory and
> Coordination** · **3 — Company Brain**

<img src="https://img.shields.io/badge/Next.js-16.2.6-000000?logo=nextdotjs&logoColor=ffffff" alt="Next.js 16.2.6" />
<img src="https://img.shields.io/badge/React-19.2.6-61DAFB?logo=react&logoColor=000000" alt="React 19.2.6" />
<img src="https://img.shields.io/badge/TypeScript-5.9.3-3178C6?logo=typescript&logoColor=ffffff" alt="TypeScript 5.9.3" />
<img src="https://img.shields.io/badge/Tailwind-4.1.17-06B6D4?logo=tailwindcss&logoColor=ffffff" alt="Tailwind 4.1.17" />
<img src="https://img.shields.io/badge/LangGraph-1.5.1-1C3C3C" alt="LangGraph 1.5.1" />
<img src="https://img.shields.io/badge/MCP-tool%20plane-27B5E8" alt="MCP" />
<img src="https://img.shields.io/badge/FalkorDB-Cypher-8B7CFF" alt="FalkorDB" />
<img src="https://img.shields.io/badge/PostgreSQL-14%2B-4169E1?logo=postgresql&logoColor=ffffff" alt="PostgreSQL 14+" />
<img src="https://img.shields.io/badge/tests-34-4C51BF?logo=vitest&logoColor=ffffff" alt="34 tests" />
<img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license" />

**FinQDesk** is a multi-agent financial research desk where a **FalkorDB
knowledge graph is the shared mind**. Ask *"If TSMC blows up, who gets
hurt?"* and the agents don't guess — they traverse `SUPPLIES` edges in
FalkorDB, mark your own positions against the blast radius, recall what the
desk decided last month, and hand back an answer with a **numbered source for
every figure** and a **reasoning trace of every graph query and tool call**.

- 🎥 **Demo video:** _add link here_
- 🌐 **Live deployment:** _add link here, or use the local setup below_
- 📝 **Blog post:** _add link here_ (draft in [`BLOG.md`](./BLOG.md))

```
        ┌──────────────── FalkorDB knowledge graph  (graph: "finq") ──────────────┐
        │                                                                         │
        │  Company─COMPETES_WITH─Company     Fund─OWNS→Company                    │
        │  Company─SUPPLIES*1..3→Company     Position─POSITION_IN→Company         │
        │  Person─MEMBER_OF→Team             Decision─DERIVED_FROM→Document       │
        │  Company─HAS_QUOTE→Quote           Memory / Episode (per tenant)        │
        │                                                                         │
        │  boot ladder:  LIVE server → LITE embedded engine → DEGRADED (labelled) │
        └─────────────────────────────────────────────────────────────────────────┘

  question ─► ORCHESTRA (policy router + optional LLM · symbol resolver)
                └─► ARCHIVE (recall) ─► [ TICKER | TOPOLOGY | PROVENANCE ]
                        └─► DESK-WRITER (grounded draft) ─► CRITIC (fact-check)
                                └─► ARCHIVE (scribe) ─► answer + sources
                     every specialist call goes through the MCP tool plane
```

---

## Why a graph? (and why the graph is not decoration)

Finance questions are about **connections**, not rows:

| Question | What answers it in FinQDesk |
| --- | --- |
| Who gets hurt if TSMC fails? | Variable-length traversal `(:Company)-[:SUPPLIES*1..3]->(:Company)` |
| Which of *my holdings* sit within 3 hops of that risk? | `Position-[:POSITION_IN]->Company` joined onto the same traversal |
| Why did we overweight NVDA, and from what evidence? | `Decision-[:DERIVED_FROM]->Document`, `Person-[:DECIDED]->Decision` |
| Who on the desk knows about this topic? | `Person-[r]-(Team|Project|Document)` pattern match |
| What did we tell this user last week? | Tenant-scoped `Episode` / `Memory` recall **before every answer** |

Remove FalkorDB and none of these have an answer: supply-chain contagion,
decision provenance, org knowledge, and agent memory all execute as
**Cypher on the graph**. The full schema and the exact queries are in
[`docs/GRAPH_MODEL.md`](./docs/GRAPH_MODEL.md).

## How FinQDesk maps to the three Graph Hacks tracks

| Track | What FinQDesk does |
| --- | --- |
| **1 · Agents That Act on Connected Data** | Multi-hop risk propagation (`graph_risk_paths`), shortest path between companies (`graph_path`), degree centrality (`graph_centrality`), peers and supply chains — all exposed as **MCP tools** the agent selects from. The agent acts on what the graph shows: it marks your positions against the contagion set (`portfolio_risk`). Every answer carries a reasoning trace + numbered sources. |
| **2 · Agent Memory and Coordination** | Every turn is scribed as an `Episode` (episodic); facts live as `Memory` nodes (semantic) and desk policies as procedural memory; recall runs **before** every answer. Six specialised agents coordinate through shared graph state in a LangGraph pipeline. Tenancy separates memory, threads and positions per user/desk. |
| **3 · Company Brain** | People, teams, projects, documents and decisions in one graph. Ingest a document → `MENTIONS` edges to companies. Record a decision → `DERIVED_FROM` its source documents. `brain_decisions` traces a decision back to its sources; `brain_who_knows` finds who owns what. |

---

## Highlights

- **Deterministic-first multi-agent engine** — a LangGraph pipeline
  (`supervisor → memory → market → graph → brain → synthesize → scribe`)
  with a keyword policy router that works **with the LLM offline**; when
  Ollama is up an LLM refines the plan and writes the brief, and a plan-union
  safety net keeps missed tools from being dropped.
- **22 MCP tools** over one validated tool plane (zod schemas, strict
  argument checking with readable errors) — served both to the engine and to
  external clients at `/api/mcp` (JSON-RPC over HTTP).
- **FalkorDB-first graph layer** — 29 catalog operations defined as Cypher
  and run against FalkorDB (live server or the embedded FalkorDBLite engine).
  Each also has an embedded Postgres implementation used only as a
  loudly-labelled emergency fallback. The boot ladder degrades loudly,
  never silently.
- **Symbol universe resolver** — company names in plain English
  (`"Adani Power"`, `"Tata"`, `"TSMC"`) resolve to canonical exchange symbols
  via graph fast-path → Yahoo search, **new companies auto-ingest** into the
  graph on first mention, and a feed-side existence check rejects tickers the
  market has never heard of (no fabricated quotes, ever).
- **Honest market data chain** — `stooq (US) → Yahoo Finance → simulated`,
  each quote stamped with its true source; currency-aware rendering
  (`₹195.85`, `$214.13`) from exchange metadata.
- **Filings & news** — audited XBRL fundamentals from **SEC EDGAR**
  (revenue / net income / EPS / assets / equity with filing dates) and
  Yahoo news headlines, both citation-backed.
- **Portfolio book** — enter real positions (`position_set`), mark them to
  live prices with P&L, and stress them against the graph's supply web
  (`portfolio_risk`: "which of my holdings sit within 3 hops of the risk?").
- **Critic pass** — after the draft, a second LLM call fact-checks every
  figure **against the tool artifacts only**; failures get one rewrite, then
  an explicit `⚠ unverified` annotation. Outcomes are logged as `CRITIC`
  events.
- **Per-tenant memory** — every turn is scribed as an `Episode`, facts live
  as semantic/procedural `Memory` nodes, and recall runs **before** every
  answer. Tenancy isolates threads, memory and positions (UI, CLI, and the
  `x-tenant` MCP header).

---

## Quickstart

**Prerequisites:** Node.js ≥ 20.9, Git, PostgreSQL ≥ 14
([Docker](https://docs.docker.com/get-docker/) is the easiest path).
Optional: Docker for a live FalkorDB server, [Ollama](https://ollama.com)
for the local LLM plane. The embedded graph engine (FalkorDB Lite) also needs
a `redis-server` binary — `brew install redis` on macOS,
`./scripts/bootstrap-falkordb.sh` on Linux x86_64 — otherwise the desk runs
on the clearly-labelled Postgres fallback store. **For the best experience
(and the intended demo), run the FalkorDB server image — step 2 below.**

```bash
git clone https://github.com/johnwesb/FinQDesk.git
cd FinQDesk
npm install

# 1. system database — any PostgreSQL ≥ 14 (Docker example)
docker run -d --name finq-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app_db \
  -p 5432:5432 postgres:16

# 2. FalkorDB — the knowledge graph (recommended: boots at FALKORDB LIVE)
docker run -d --name finq-falkordb -p 6379:6379 falkordb/falkordb:latest

# 3. environment — required value only
echo 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db' > .env

# 4. schema
npx drizzle-kit push          # expect: [✓] Changes applied

# 5. run
npm run dev                   # http://localhost:3000
```

Open http://localhost:3000 — the status bar should read **`FALKORDB LIVE`**.
The first request seeds the desk itself: **6 agents, 20 companies** with a
competition/supply web, funds, sectors, an org brain (people, teams,
projects, documents, decisions) and desk procedures.

### Try it in 60 seconds

```bash
node cli/finq.js status                                   # which graph level you're on
node cli/finq.js ask "If TSMC blows up, who gets hurt?"   # Track 1: multi-hop
node cli/finq.js remember "Our NVDA stop-loss is 8% below cost basis"
node cli/finq.js ask "What do you remember about our NVDA stop-loss?"   # Track 2
node cli/finq.js ask "Why did we decide to overweight NVDA?"            # Track 3
node cli/finq.js mcp-call graph_risk_paths '{"ticker":"TSM"}'           # instant, no LLM
```

No Ollama? Everything still works — the deterministic router and template
synthesizer answer in seconds. With a local CPU model the first answer takes
roughly 40–90 s (draft + critic pass).

**Full setup guide — the FalkorDB boot ladder, LLM setup, verification,
troubleshooting and a production checklist — lives in
[`SETUP.md`](./SETUP.md).**

---

## Graph data model (summary)

**Nodes:** `Company` · `Sector` · `Fund` · `Person` · `Team` · `Project` ·
`Document` · `Decision` · `Quote` · `Position` · `Episode` · `Memory`

**Relationships:** `COMPETES_WITH` · `SUPPLIES {component, criticality}` ·
`IN_SECTOR` · `OWNS {pct}` · `HAS_QUOTE` · `POSITION_IN` · `MEMBER_OF` ·
`LEADS` · `WORKS_ON` · `OWNED_BY` · `AUTHORED` · `MENTIONS` · `DERIVED_FROM` ·
`DECIDED`

### Three queries the product depends on

```cypher
// Track 1 — contagion: who depends on TSMC, up to 3 hops away?
MATCH path = (sup:Company {ticker: $ticker})-[:SUPPLIES*1..3]->(dependent:Company)
WITH length(path) AS hops, dependent, path
RETURN {ticker: dependent.ticker, name: dependent.name, hops: hops,
        chain: [n IN nodes(path) | n.ticker]} AS row
ORDER BY hops LIMIT 20

// Track 3 — provenance: which decisions mention a topic, and where did they come from?
MATCH (d:Decision)
WHERE size($words) = 0 OR size([w IN $words WHERE toLower(d.title + ' ' + d.rationale) CONTAINS w]) >= $minHits
OPTIONAL MATCH (d)-[:DERIVED_FROM]->(doc:Document)
OPTIONAL MATCH (per:Person)-[:DECIDED]->(d)
OPTIONAL MATCH (d)-[:MENTIONS]->(c:Company)
WITH d, collect(DISTINCT doc.title) AS sources, collect(DISTINCT per.name) AS deciders,
     collect(DISTINCT c.ticker) AS tickers
RETURN {title: d.title, date: d.date, rationale: d.rationale, status: d.status,
        sources: sources, deciders: deciders, tickers: tickers} AS row

// Track 2 — memory recall, scoped to a tenant, strongest memories first
MATCH (m:Memory {tenant: $tenant})
WHERE size($words) = 0 OR size([w IN $words WHERE toLower(m.text + ' ' + m.topic) CONTAINS w]) >= $minHits
RETURN properties(m) AS row ORDER BY m.confidence DESC, m.ts DESC LIMIT 8
```

All 29 operations live in [`src/lib/graph/queries.ts`](./src/lib/graph/queries.ts);
the schema, every relationship, and the rest of the key queries are
documented in [`docs/GRAPH_MODEL.md`](./docs/GRAPH_MODEL.md).

---

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string (system tables: agents, threads, events, graph compat store) |
| `FALKORDB_URL` | no | `redis://localhost:6379` | Live graph server. A URL saved in **Settings** (DB-stored) takes precedence and is re-probed automatically |
| `OLLAMA_BASE_URL` | no | `http://localhost:11434` | Local LLM plane; when down, the deterministic router + template synthesizer carry the desk |
| `LLM_THINK` | no | off | `1` enables Ollama thinking mode (large latency cost; off by default for speed) |
| `LLM_TIMEOUT_MS` | no | `45000` | Per-LLM-call timeout |
| `FINQ_API` | no | `http://localhost:3000` | CLI target server (`cli/finq.js`) |

**Graph boot ladder** (status bar shows which level you're on):

```
FALKORDB LIVE  →  configured server (FALKORDB_URL / Settings)
FALKORDB LITE  →  embedded real FalkorDB engine (falkordblite, .data/falkordb)
DEGRADED       →  Postgres compat store — red-labelled, never silent
```

---

## Using the desk

### Web console — http://localhost:3000

| Page | What it does |
| --- | --- |
| `/` | Chat with the desk. Live reasoning trace + numbered sources per answer; session threads per tenant. The **status-bar ticker scrolls every Company in the graph** with live prices and re-syncs as the graph grows. |
| `/graph` | Interactive constellation explorer with node inspector and neighborhood walks. |
| `/brain` | Org graph, decision provenance, document corpus — ingest docs, record decisions. |
| `/memory` | Episodic / semantic / procedural memory drawers per tenant. |
| `/agents` | The six agents, their MCP tools, the execution topology. |
| `/setup` | In-app copy of the setup guide with a live system checklist. |
| `/settings` | FalkorDB endpoint, CLI/MCP reference, reseed/wipe controls. |

### CLI — zero dependencies

```bash
node cli/finq.js status                              # platform report
node cli/finq.js ask "How is Adani Power doing?" # full pipeline, resolved symbols
node cli/finq.js quote AAPL NVDA "TSMC"              # quotes (names/aliases resolve)
node cli/finq.js history NVDA --days 90              # sparkline trend
node cli/finq.js news NVDA                           # headlines
node cli/finq.js position add NVDA 100 120.50        # enter a real holding
node cli/finq.js position list                       # marked to market with P&L
node cli/finq.js position risk                       # book × supply-web exposure
node cli/finq.js brain                               # org + decisions + documents
node cli/finq.js ingest "<title>" "<body>"           # document → graph
node cli/finq.js decide "<title>" "<rationale>" --by "Mira Chen"
node cli/finq.js memory --kind procedural
node cli/finq.js tools                               # MCP manifest
node cli/finq.js mcp-call graph_risk_paths '{"ticker":"TSM"}'
```

`FINQ_API` overrides the target (default `http://localhost:3000`);
`--tenant <name>` on any command switches tenant (default `desk-1`).

### MCP — attach any client

Endpoint `http://localhost:3000/api/mcp` · stateless JSON-RPC over HTTP ·
tenant via `x-tenant` header:

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' -H 'x-tenant: desk-1' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_quote","arguments":{"tickers":["NVDA"]}}}'
```

Methods: `initialize`, `ping`, `tools/list`, `tools/call`.

### The 22 tools

| Plane | Tools |
| --- | --- |
| **Market (5)** | `get_quote` · `get_history` · `get_fundamentals` · `get_news` · `get_facts` (SEC EDGAR XBRL) |
| **Graph (6)** | `company_profile` · `graph_peers` · `graph_supply_chain` · `graph_risk_paths` · `graph_path` · `graph_centrality` |
| **Positions (3)** | `position_set` · `position_list` · `portfolio_risk` |
| **Brain (5)** | `brain_ingest_document` · `brain_record_decision` · `brain_decisions` · `brain_who_knows` · `brain_org` |
| **Memory (3)** | `memory_recall` · `memory_store` · `list_procedures` |

Argument validation is strict: malformed calls fail loudly with
`invalid arguments for <tool>: <field>: <message>` before anything touches
the graph or the feeds.

---

## How it works

### Engine pipeline

```
START → supervisor ─► memory(recall) ─► market ─► graph ─► brain ─► synthesize ─► scribe → END
         │                              (order per plan; conditional edges; loop-safe via `attempted` state)
         ├─ extractTickers (cashtags, aliases, name patterns, finance-shorthand blacklist)
         ├─ extractMentions → resolveToSymbol (graph → Yahoo search → one-time Company ingest)
         ├─ heuristicRoute: deterministic keyword policy (works offline)
         └─ llmRoute (when Ollama is up): schema-aware tool plan + union with the heuristic plan
```

**Synthesis** is grounded by construction: the deterministic renderer only
prints what the artifacts contain; the LLM brief must cite figures from
artifact summaries; the **critic** re-checks the brief against those same
artifacts and gets exactly one rewrite before annotating issues honestly.

### Graph layer

- **29 catalog operations** (`src/lib/graph/queries.ts`), each defined once
  as Cypher *and* once as an embedded Postgres implementation.
- Reads/writes flow through `graphRun(op, params)`; the engine, tools, CLI
  and routes never hand-write queries — which is what keeps the two
  backends in lockstep.
- Seed data supplies the initial org brain and supply/competition web;
  the resolver keeps adding real `Company` nodes as questions introduce new
  names (edges for new companies are **not** invented — empty traversals
  return honestly).

### Data sources (and what they actually are)

| Data | Source | Honesty properties |
| --- | --- | --- |
| Quotes / history | stooq (US) → Yahoo Finance → deterministic fallback | Stamped `stooq-delayed` / `yahoo-delayed` / `simulated` — a simulated price is never labeled live; currency from exchange metadata |
| Valuation | Yahoo quoteSummary (cookie+crumb) | Live metrics with per-ticker caching |
| Fundamentals (audited) | **SEC EDGAR** XBRL company facts | US registrants only; every metric carries `form` + `filed` date; non-US symbols get an explicit “no SEC filings” answer |
| News | Yahoo Finance news search | Publisher + URL + timestamp per headline, cited |
| Symbols | Graph → Yahoo symbol search → feed existence check | Weak matches are rejected as *unresolved*; nothing is invented |
| Positions | **You** (`position_set` / CLI / chat) | No broker link — the desk only ever reports what you entered |
| Graph edges (competition/supply/org) | Hand-authored demo seed | Real architecture, demo content — see *Known limitations* |

---

## Development & quality gates

```bash
npm run dev         # dev server
npm run build       # production build
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest — unit + contract suites
```

The test suites (`tests/`) target the bug classes this codebase actually
had, by construction:

- **`extract.test.ts`** — ticker/mention extraction adversaries (`P/E` must
  not quote Papa John's, cashtags, aliases, blacklist words) and heuristic
  routing plans for quotes, supply-chain, valuation, news, filings,
  positions, memory fallback.
- **`universe.test.ts`** — resolver: graph fast-path, auto-ingest, null on
  no match, feed-404 rejection, offline trust, aliases (all network and
  graph calls mocked).
- **`mcp-tools.test.ts`** — currency formatting, strict tool-argument
  contracts, deterministic render snapshots (INR symbols, empty-profile
  guards, P&L tables, headlines, SEC facts).

**Current gate status:** typecheck 0 errors · lint clean · 34/34 tests ·
production build green.

---

## Project structure

```
cli/finq.js                  zero-dependency CLI (ask/quote/news/position/…)
scripts/                     FalkorDB bootstrap script (rootless Redis 8, Linux x86_64)
src/
  app/                       Next.js App Router — pages + API routes
    api/                     chat, events, quotes, stats, brain, graph,
                             memory, agents, mcp, settings, admin, health
  components/chrome.tsx      app shell: nav, status bar, graph-mirroring ticker
  lib/
    engine.ts                LangGraph pipeline: routing, nodes, renders, critic
    universe.ts              symbol resolution + auto-ingest + aliases
    market.ts                quote/history/fundamentals/news chain + currency
    sec.ts                   SEC EDGAR XBRL client
    mcp/tools.ts             22 tool definitions + strict callTool validation
    graph/                   29 dual-implemented graph ops + drivers
    llm.ts                   Ollama helpers (timeouts, think mode, JSON mode)
    seed.ts                  demo desk: agents, companies, supply web, brain
  db/                        Drizzle schema + client
tests/                       vitest suites
SETUP.md                     full setup, verification & troubleshooting guide
docs/GRAPH_MODEL.md          graph schema + the Cypher the product runs on
SUBMISSION.md                Graph Hacks submission checklist + demo script
BLOG.md                      write-up for the best-blog-post side prize
```

---

## Known limitations (read before demoing to anyone serious)

1. **Graph edges are demo content.** Supply-chain (`SUPPLIES`), competition,
   fund-ownership and org-brain edges ship hand-authored as **synthetic seed
   data** (allowed by the hackathon rules: public, synthetic, or your own).
   The architecture for derived edges exists (and new *nodes* ingest
   automatically), but edges are not yet mined from filings or news.
2. **EDGAR covers US registrants only.** `get_facts` answers `no SEC
   filings` for non-US names (e.g. `ADANIPOWER.NS`, `TCS.NS`).
3. **No broker integration.** Positions are entered by you (tool/CLI/chat);
   there is no live brokerage sync or holdings import.
4. **Market data is delayed, not real-time,** and can fall back to a
   clearly-labeled simulated feed when outbound network access is blocked.
5. **The critic is best-effort on a local model.** It logs `verified`,
   `rewrite applied`, `inconclusive`, or `skipped` as events — it can never
   silently pass a failure, but it is not a formal proof.
6. **The embedded lite engine needs a `redis-server` binary.** Linux x86_64
   gets a vendored one from `scripts/bootstrap-falkordb.sh`; macOS needs
   `brew install redis`. The recommended path is the FalkorDB Docker image.
   Where no graph engine can run, the desk falls back to the Postgres
   compat store and says so (red `DEGRADED` label) — an emergency mode, not
   the intended deployment. Parity between the two backends is defined in
   code and exercised by the shared catalog, not by CI on every backend.
7. **Tenancy is logical, not a security boundary.** Tenants are separated by
   a `tenant` property inside one graph (`finq`), not by separate graphs, and
   there is no authentication. Do not expose the app publicly as-is.
8. **No CI pipeline yet** — the quality gates above are local commands.
9. **Not financial advice.** FinQDesk is a research tool.

## Docs

- **Setup, verification, troubleshooting:** [`SETUP.md`](./SETUP.md)
- **Graph schema and Cypher:** [`docs/GRAPH_MODEL.md`](./docs/GRAPH_MODEL.md)
- **Hackathon submission checklist & demo script:** [`SUBMISSION.md`](./SUBMISSION.md)
- **Security:** [`SECURITY.md`](./SECURITY.md) · **Conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)

## License

[MIT](./LICENSE) © 2026 FinQDesk contributors.
