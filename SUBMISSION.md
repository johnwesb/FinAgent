# FinQDesk — Graph Hacks Submission

**Project:** FinQDesk — a graph-centred, multi-agent financial research desk
**Event:** Graph Hacks (WeMakeDevs × FalkorDB), Oct 15–18, 2026
**Tracks entered:** 1 — Agents That Act on Connected Data ·
2 — Agent Memory and Coordination · 3 — Company Brain

## Links (fill in before submitting)

| Item | Link |
| --- | --- |
| Public repository | _https://github.com/YOUR_GITHUB_USERNAME/FinQDesk_ |
| Demo video | _add link_ |
| Live deployment | _add link, or "local setup — see SETUP.md"_ |
| Blog post (side prize) | _add link_ |

## Required-items checklist (rule 10)

- [ ] **Public source-code repository** — pushed and public
- [x] **README with setup instructions and graph data model** — [`README.md`](./README.md), [`SETUP.md`](./SETUP.md), [`docs/GRAPH_MODEL.md`](./docs/GRAPH_MODEL.md)
- [x] **Cypher queries / graph algorithms the product depends on** — [`docs/GRAPH_MODEL.md`](./docs/GRAPH_MODEL.md) §2 (source: `src/lib/graph/queries.ts`)
- [ ] **Demo video** showing the working project — record using the script below
- [ ] **Live deployment, or complete local setup instructions** — local setup is complete in `SETUP.md`; note the app has no authentication, so deploy only behind auth
- [x] **Track(s) named** — all three, listed above

## Rules self-check

| Rule | How FinQDesk meets it |
| --- | --- |
| FalkorDB is the primary graph DB and central to the product (2, 3) | Contagion, provenance, org knowledge and agent memory all execute as Cypher on FalkorDB (graph `finq`). The Postgres store holds only system tables (roster, threads, telemetry); its graph-compat mode is a red-labelled emergency fallback, not the intended path. |
| Graph does real work, not decoration (3) | The agent's plan, its multi-hop answers, its memory recall and its provenance traces are all graph queries; see README "Why a graph?". |
| Allowed data only (6) | Hand-authored synthetic seed data + public market data (stooq / Yahoo) + public SEC EDGAR filings. No private or login-protected data. |
| Work began after the hackathon started (8) | _Confirm via your commit history._ |
| Third-party tools disclosed (9) | Next.js, React, LangGraph, LangChain, FalkorDB clients, Drizzle, zod, Ollama (optional) — see `package.json`. |
| Can explain the code (12, 13) | See "Architecture talking points" below. |

## Demo video script (≈ 3 minutes)

1. **(0:00)** Status bar shows `FALKORDB LIVE`; open `/graph` to show the constellation.
2. **(0:20) Track 1 — act on connected data.**
   Enter a position (`node cli/finq.js position add NVDA 100 120.50`), then ask
   *"If TSMC blows up, who gets hurt?"*. Point out the multi-hop chain, the
   `portfolio_risk` overlap with the position, the reasoning trace and numbered sources.
3. **(1:10) Track 2 — memory across sessions.**
   `node cli/finq.js remember "Our NVDA stop-loss is 8% below cost basis"`, start a
   **new** thread, ask *"What do you remember about our NVDA stop-loss?"*. Show `/memory`
   (episodic / semantic / procedural). Switch tenant to show isolation.
4. **(1:50) Track 3 — company brain.**
   Ask *"Why did we decide to overweight NVDA?"* → show decision → `DERIVED_FROM` documents → deciders.
   Ask *"Who owns the AI Capex Tracker?"*. Ingest a new document on `/brain` and show the new `MENTIONS` edges.
5. **(2:30) Explainability + honesty.**
   Show the critic event, a `simulated`/`yahoo-delayed` source stamp, and the strict
   MCP validation error from a malformed `mcp-call`.
6. **(2:50)** Show the MCP endpoint answering an external `curl` call. Wrap up.

> Tip: if Ollama is slow on your machine, demo with it off — the deterministic
> router answers in seconds — and mention the LLM path verbally.

## Architecture talking points (for judges' Q&A)

- **Pipeline:** LangGraph `supervisor → memory → market → graph → brain → synthesize → scribe`.
  The router is deterministic-first (works offline); the LLM refines the plan and its
  tool plan is *unioned* with the heuristic plan so tools are never dropped.
- **Tool plane:** 22 MCP tools with zod validation, served in-process and at `/api/mcp`.
- **Graph layer:** 29 named Cypher operations behind `graphRun(op, params)`; nothing else
  writes queries. Parameters are sanitised before reaching Cypher.
- **Grounding:** the renderer prints only artifact content; the critic re-checks the brief
  against those same artifacts; failures get one rewrite, then an explicit `⚠ unverified`.
- **Honesty:** every quote is stamped with its true feed; unresolved symbols are rejected,
  not invented; no edges are fabricated for newly-ingested companies.
- **Tenancy:** `tenant` property on `Episode` / `Memory` / `Position`; every recall filters on it.

## Known limitations (be upfront)

See [README → Known limitations](./README.md#known-limitations-read-before-demoing-to-anyone-serious).
