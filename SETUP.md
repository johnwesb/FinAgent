# FinQDesk — Complete Setup Guide

**FinQDesk** is a FalkorDB-centred, multi-agent financial research desk,
built for the Graph Hacks hackathon (WeMakeDevs × FalkorDB):
real-time quotes, multi-hop graph reasoning, persistent agent memory,
a provenanced company brain, portfolio positions, news and SEC filings.
LangGraph + LangChain + MCP. (The in-app UI brand reads `FINQ//DESK`.)

> Looking for the overview, graph data model and Cypher queries? See
> [`README.md`](./README.md) and [`docs/GRAPH_MODEL.md`](./docs/GRAPH_MODEL.md).

This guide takes you from zero to a fully verified installation in
roughly 10 minutes. Sections marked **optional** activate live mode —
everything works without them in clearly-labelled fallback modes.

---

## 0. What you are installing

| Plane | Technology | Required? | Behavior |
| --- | --- | --- | --- |
| App server | Next.js 16 (App Router) | ✅ | — |
| System tables | PostgreSQL + Drizzle ORM | ✅ | plumbing only (roster, threads, telemetry) |
| **Knowledge graph = THE MIND** | **FalkorDB (Cypher)** | **yes — auto-provisioned** | Boot ladder: configured server → auto-booted embedded real FalkorDB engine (FalkorDBLite, persisted to `.data/falkordb`) → loudly-labelled degraded store (red `DEGRADED`) |
| LLM router/prose | Ollama + LangChain ChatOllama | optional | Deterministic policy router + template synthesis |
| Market data | stooq (US) → Yahoo Finance → simulated | optional | Deterministic simulated feed (labeled `simulated`) — every quote stamped with its true source |

---

## 1. Prerequisites

- **Node.js ≥ 20.9** and npm (`node -v` to check) — the Next.js 16 requirement
- **Docker** (easiest path for PostgreSQL and FalkorDB) or native installs
- **Git**
- **OS:** macOS, Linux, or Windows via **WSL2** (the bootstrap script is
  Linux x86_64 only; on Windows/macOS use the FalkorDB Docker image in §8)

## 2. Get the code and install dependencies

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/FinQDesk.git
cd FinQDesk
npm install
```

## 3. Provide PostgreSQL

Any PostgreSQL ≥ 14 works. Quickest with Docker:

```bash
docker run -d --name finq-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=app_db \
  -p 5432:5432 postgres:16
```

## 4. Configure environment

Create `.env` in the project root (values shown are the defaults used
when the variables are absent):

```bash
# required — the platform's system tables (agents, sessions, messages, events)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db

# optional — live graph runtime (falls back to the boot ladder in §8 if unreachable)
FALKORDB_URL=redis://localhost:6379

# optional — local LLM plane (falls back to deterministic router if offline)
OLLAMA_BASE_URL=http://localhost:11434

# optional — LLM tuning (defaults shown)
LLM_TIMEOUT_MS=45000     # per-call wall-clock cap
# LLM_THINK=1            # opt in to Ollama thinking mode (slow on CPU; off by default)
```

> The FalkorDB endpoint can also be changed later from **Settings →
> FalkorDB graph runtime** — the DB-stored value takes precedence over env.

## 5. Create the database schema

```bash
npx drizzle-kit push
```

Expected output: `[✓] Changes applied`.

> Re-installing over an older version of this project? If drizzle asks
> about conflicting renames, either answer with `+` (create) or reset first:
> `psql "$DATABASE_URL" -c "DROP TABLE IF EXISTS agents, events, settings, chat_sessions, chat_messages, graph_nodes, graph_edges CASCADE;"` then push again.
> Those seven tables are the full schema — anything else in the dump is not ours.

## 6. Start the platform

Development:

```bash
npm run dev
```

Production:

```bash
npm run build && npm start
```

Open **http://localhost:3000**.

Sanity check:

```bash
curl -s localhost:3000/api/health     # {"ok":true,"service":"agentco"}
```

> Yes, the service name really is `agentco` — a legacy identifier kept for
> client compatibility.

## 7. First boot — the desk seeds itself

The first request to any stats/agents endpoint triggers `ensureSeed()`.
The seed writes, exactly:

- **6 agents** (SQL roster) — ORCHESTRA (supervisor), TICKER (market),
  TOPOLOGY (graph), PROVENANCE (brain), ARCHIVE (memory), DESK-WRITER
  (synthesis)
- **Graph fuel:** 20 companies, 6 sectors, 3 funds — `IN_SECTOR` (20),
  `COMPETES_WITH` (24), `SUPPLIES` (11), `OWNS` (9)
- **Company brain:** 6 people, 3 teams, 3 projects, 4 documents, 3
  decisions — with `MENTIONS` (19), `MEMBER_OF` (7), `AUTHORED` (4),
  `DERIVED_FROM` (4), `WORKS_ON` (4), `OWNED_BY` (3), `LEADS` (3),
  `DECIDED` (3)
- **Procedural memory:** 3 desk policies

That is **51 nodes · 111 edges** immediately after seeding. The graph then
grows on its own: every `get_quote` call (the `quote` CLI command or the
chat tool) persists `Quote` nodes, every conversation an
`Episode`, every position you enter a `Position` — so a healthy desk
quickly reads `158 nodes · 125 edges` or more. Growth is expected.

Verify with the status bar (top of the Console) or:

```bash
node cli/finq.js status
```

The graph line prints exactly one of three labels (this is the real output
format — LITE prints the unix socket it auto-booted, LIVE your configured
endpoint):

```
graph     FALKORDB LIVE @ redis://localhost:6379
graph     FALKORDB LITE · embedded engine @ unix:///…/.data/falkordb/fdb-*.sock
graph     DEGRADED · falkordb required @  · <the exact engine error>
```

On a machine with no FalkorDB engine available you will see `DEGRADED`
(red) plus the reason inline — §8 explains how to leave that state.

## 8. FalkorDB is the mind (auto-provisioned, already real)

FalkorDB is **not optional** in this project — the knowledge graph is the
desk's mind: supply chains, contagion maps, agent memory, and the company
brain execute as Cypher on a real FalkorDB engine. Boot ladder:

```
1. FALKORDB LIVE ... configured server at FALKORDB_URL (docker / cloud)
2. FALKORDB LITE ... auto-booted embedded REAL FalkorDB engine via
                     falkordblite (bundled module + vendored Redis 8),
                     persisted to .data/falkordb — zero config
3. DEGRADED ........ Postgres compat store, emergency-only, red label,
                     with the engine error printed in the status line
```

**Which level you land on depends on your platform — the ladder never
lies about it:**

- **Linux x86_64:** run the idempotent bootstrap once (no sudo) to vendor a
  portable rootless Redis 8; first boot then lands at level 2 in ~200 ms
  and persists across restarts:

  ```bash
  ./scripts/bootstrap-falkordb.sh   # idempotent, no sudo, x86_64 linux
  ```

- **macOS / any host without a redis binary:** the embedded engine needs
  `redis-server` (`brew install redis` or `apt install redis-server`).
  Without it, level 2 fails and the desk honestly drops to level 3 with
  the reason, e.g.:

  ```
  lite engine failed: redis-server not found. Install it with:
    Ubuntu/Debian: sudo apt install redis-server
    macOS:         brew install redis
  ```

  Everything keeps working meanwhile — quotes, memory, answers — on the
  labelled compat store.

For a production/shared desk, run the full server — it takes priority:

```bash
docker run -p 6379:6379 -it --rm falkordb/falkordb:latest
```

Then either save `redis://localhost:6379` in **Settings** (persists in DB,
auto re-probes) or set `FALKORDB_URL` and restart. Status bar flips to
`FALKORDB LIVE`. Sanity-check directly:

```bash
redis-cli GRAPH.QUERY finq "MATCH (n) RETURN head(labels(n)), count(n)"
```

> Graph name is **`finq`**. After connecting a production server, use
> **Settings → Burn & reseed desk** to repopulate it. The `DEGRADED`
> label means no real engine could start at all — the inline error says
> why; Settings shows it too.

## 9. Optional: local LLM plane

Routing and executive summaries become model-generated:

```bash
# install from https://ollama.com, then:
ollama serve
ollama pull llama3.1:8b
```

Honest expectations:

- The engine **probes Ollama per question** — no restart needed. The `LLM`
  indicator in the status bar turns green.
- Model selection: an explicitly requested model if installed, otherwise
  **the first model Ollama reports** (`llama3.1:8b` is the conventional
  default; any instruct model works).
- Thinking mode is **off by default** (`LLM_THINK=1` opts in) — on CPU it
  can add ~100 s per call.
- Every LLM call is wall-clock capped by `LLM_TIMEOUT_MS` (default 45 s).

## 10. Verify the three tracks (5 commands)

```bash
export FINQ_API=http://localhost:3000

# Track 1 — multi-hop action on connected data
node cli/finq.js ask "If TSMC blows up, who gets hurt?"

# Track 2 — persistent memory across sessions
node cli/finq.js remember "Our NVDA stop-loss is 8% below cost basis"
node cli/finq.js ask "What do you remember about our NVDA stop-loss?"

# Track 3 — company brain provenance
node cli/finq.js ask "Why did we decide to overweight NVDA?"
node cli/finq.js ask "Who owns the AI Capex Tracker?"
```

Each answer ends with a **reasoning trace** (which agent called which
MCP tool) and a numbered **sources** block. Timing: with a local CPU
model the first answer takes **roughly 40–90 seconds** (draft + critic
pass); with Ollama down it is template-synthesized in seconds and the
router still plans correctly.

If you skip the `ask` variants, the tool layer itself is instantly
checkable:

```bash
node cli/finq.js mcp-call brain_decisions '{"topic":"NVDA"}'   # decisions found
node cli/finq.js mcp-call brain_org '{}'                       # 3 teams on the org graph
node cli/finq.js mcp-call memory_recall '{"query":"stop-loss"}' # stored fact comes back
```

Malformed arguments fail loudly — that's the strict validation working
(exact CLI output):

```
err MCP tool error: tool error: invalid arguments for brain_decisions: topic: Required
```

## 11. The CLI

Zero dependencies, Node ≥ 18:

```bash
node cli/finq.js status                              # platform report
node cli/finq.js ask "<question>"                    # full agent pipeline
node cli/finq.js quote AAPL NVDA "TSMC"              # quotes (names/aliases resolve)
node cli/finq.js history NVDA --days 90              # sparkline trend
node cli/finq.js news NVDA                           # headlines
node cli/finq.js position add NVDA 100 120.50        # enter a real holding
node cli/finq.js position list                       # marked to market, P&L
node cli/finq.js position risk                       # book × supply-web exposure
node cli/finq.js remember "<fact>"                   # write semantic memory
node cli/finq.js memory --kind procedural            # list stored memory
node cli/finq.js brain                               # org + decisions + docs
node cli/finq.js ingest "<title>" "<body>"           # document → graph
node cli/finq.js decide "<title>" "<rationale>" --by "Mira Chen"
node cli/finq.js tools                               # MCP manifest
node cli/finq.js mcp-call graph_risk_paths '{"ticker":"TSM"}'
```

`FINQ_API` overrides the target (default `http://localhost:3000`);
`--tenant <name>` on any command switches tenant (default `desk-1`).

## 12. Web UI tour

| Page | What it shows |
| --- | --- |
| **Console** `/` | Chat with the whole desk. Live engine trace per answer, session threads per tenant, quick prompts. |
| **Brain** `/brain` | Org graph, decision provenance, document corpus; ingest docs, record decisions, add people. |
| **Graph** `/graph` | Interactive constellation explorer + node inspector with neighborhood walks. |
| **Memory** `/memory` | Episodic / semantic / procedural drawers per tenant, plus manual memory writes. |
| **Agents** `/agents` | The six agents, their MCP tools, the LangGraph execution topology. |
| **Guide** `/setup` | This guide, with a live system checklist. |
| **Settings** `/settings` | FalkorDB endpoint, MCP endpoint docs, CLI reference, danger zone (reseed/wipe). |

## 13. Attach an external MCP client

Endpoint: `http://localhost:3000/api/mcp`
Transport: stateless JSON-RPC over HTTP
Tenant header: `x-tenant` (default `desk-1`)

Handshake:

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

List tools: `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`
Call a tool:

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' -H 'x-tenant: desk-1' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"graph_risk_paths","arguments":{"ticker":"TSM"}}}'
```

22 tools ship, grouped by plane:

- **Market (5):** `get_quote`, `get_history`, `get_fundamentals`, `get_news`, `get_facts`
- **Graph (6):** `company_profile`, `graph_peers`, `graph_supply_chain`, `graph_risk_paths`, `graph_path`, `graph_centrality`
- **Positions (3):** `position_set`, `position_list`, `portfolio_risk`
- **Brain (5):** `brain_ingest_document`, `brain_record_decision`, `brain_decisions`, `brain_who_knows`, `brain_org`
- **Memory (3):** `memory_recall`, `memory_store`, `list_procedures`

## 14. Tenancy

Every memory node, thread and position is tenant-scoped. Tenancy is
implemented as a `tenant` property on tenant-owned nodes (`Episode`,
`Memory`, `Position`) inside the single `finq` graph, and every recall
query filters on it — so recall never crosses tenants.

- **Web UI:** change the tenant field on the Console (persisted in
  localStorage key `finq-tenant`, isolates threads + memory).
- **CLI:** `--tenant my-desk` on any command.
- **MCP:** `x-tenant` header.

Use one tenant per user, fund, or strategy — recall never crosses tenants.

## 15. Reset

- **UI:** Settings → *Burn & reseed desk* (full rebuild) or *Purge everything*.
- **API:** `POST /api/admin {"mode":"reseed"}` or `{"mode":"wipe"}`.

Reseed rebuilds agents + graph from `src/lib/seed.ts`; wipe clears
messages, events, the graph and the roster first.

## 16. Troubleshooting

| Symptom | Cause → Fix |
| --- | --- |
| `DEGRADED · falkordb required` (red) | No graph engine could start. Read the inline error: missing `redis-server` → `brew install redis` / `apt install redis-server` or `./scripts/bootstrap-falkordb.sh` (Linux x86_64); server configured but down → start the container (step 8). The desk keeps working on the labelled compat store meanwhile. |
| `drizzle-kit push` fails `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL isn't running. `docker start finq-pg` (or start your native service) and re-check the port/user in `DATABASE_URL`. |
| Quotes or history say `simulated` while the internet works | Either both feeds are unreachable (outbound network to stooq.com **and** Yahoo blocked), or they are temporarily failing: stooq times out, Yahoo rate-limits bursts (HTTP 429) — history retries Yahoo's `range=` endpoint and the next request usually recovers. The stamp always tells the truth; a live source otherwise shows in status (e.g. `yahoo delayed feed`). |
| Changed the FalkorDB URL and the graph broke | Saving in Settings re-probes automatically and falls back to `FALKORDB LITE`; correct the URL in Settings (default `redis://localhost:6379`) or leave it — `finq status` always shows the level you're on. |
| Chat answer shows **engine fault** | One pipeline node threw. Check the dev-server log, confirm PostgreSQL is reachable, then retry — the desk answers with an honest error banner, never a silent one. |
| `LLM OFF` | Ollama not running at `OLLAMA_BASE_URL`. The desk uses the deterministic policy router — everything still works. |
| `drizzle-kit push` interactive conflict | Old tables from a previous template. Drop them with the exact seven-table statement in step 5, then push again. |
| `npm run build` fails type-check | Run `npx next typegen` once, then `npx tsc --noEmit` to see the real error. |
| Port 3000 busy | `PORT=3001 npm run dev` → set `FINQ_API=http://localhost:3001` for the CLI. |
| Health check | `curl localhost:3000/api/health` should return `{"ok":true,"service":"agentco"}`. |
| `npm install` fails on `falkordblite` | Use Node ≥ 20.9 and a supported platform; if it still fails, skip the embedded engine and run the FalkorDB Docker image (§8) — the desk will boot at `FALKORDB LIVE`. |
| Port 5432 already in use | Another PostgreSQL is running. Stop it, or map Docker to another port (`-p 5433:5432`) and update `DATABASE_URL`. |
| Windows: `bootstrap-falkordb.sh` won't run | The script is Linux x86_64 only. Use WSL2, or run `docker run -p 6379:6379 falkordb/falkordb:latest`. |
| Answers feel slow | Expected with a local CPU model: draft + critic ≈ 40–90 s (see §10). Offline LLM is fast; `LLM_THINK=1` is slower still. |

## 17. Production checklist

1. `npm run build && npm start` (or a process manager / container)
2. Set `DATABASE_URL`, `FALKORDB_URL`, `OLLAMA_BASE_URL` in the environment
3. `npx drizzle-kit push` against the production database
4. Confirm `FALKORDB LIVE` in the status bar and run the step-10 checks
5. Run the local quality gates: `npm run lint && npm run typecheck && npm test`
6. Restrict or proxy `/api/admin` if the deployment is shared — it is
   **unauthenticated by design** for local use (see [`SECURITY.md`](./SECURITY.md))
7. Put authentication (reverse proxy, SSO, or middleware) in front of the
   whole app before exposing it to the public internet
