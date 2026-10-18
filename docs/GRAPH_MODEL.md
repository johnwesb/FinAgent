# FinQDesk — Graph Data Model & Cypher

FinQDesk keeps its agent context in a single FalkorDB graph named **`finq`**.
This document describes the schema and the queries the product depends on.
Every operation is defined in [`src/lib/graph/queries.ts`](../src/lib/graph/queries.ts)
and is called through `graphRun(op, params)` — the engine, MCP tools, CLI and
API routes never hand-write queries.

> **Backend note.** The Cypher below runs on FalkorDB (a live server or the
> embedded FalkorDBLite engine). Each operation also has an embedded Postgres
> implementation that is used only as a red-labelled `DEGRADED` emergency
> fallback when no graph engine can start. See [`SETUP.md`](../SETUP.md) §8.

---

## 1. Schema

```
                         ┌───────────┐  IN_SECTOR   ┌────────┐
        ┌── COMPETES_WITH┤  Company  ├─────────────►│ Sector │
        │   (arena,      └─┬──┬───┬──┘              └────────┘
        │    intensity)    │  │   │
        ▼                  │  │   └── SUPPLIES (component, criticality) ──► Company
   (other Company)         │  │
                           │  └─ HAS_QUOTE ─► Quote (price, changePct, ts, source)
        Fund ── OWNS(pct) ─┘
        Position ── POSITION_IN ─► Company       Position (tenant, qty, avgCost, …)

   Person ── MEMBER_OF ─► Team ◄── OWNED_BY ── Project ◄── LEADS / WORKS_ON ── Person
   Person ── AUTHORED ─► Document ◄── DERIVED_FROM ── Decision ◄── DECIDED ── Person
   Document ── MENTIONS ─► Company          Decision ── MENTIONS ─► Company

   Episode (tenant, sessionId, role, content, ts)      ← episodic memory
   Memory  (tenant, kind, topic, text, confidence, ts) ← semantic / procedural memory
```

### Nodes

| Label | Key properties | Purpose |
| --- | --- | --- |
| `Company` | `ticker`, `name`, `sector`, `industry`, `marketCapB`, `employees`, `founded`, `description` | Market entities. New companies auto-ingest when first mentioned. |
| `Sector` | `name` | Industry grouping. |
| `Fund` | `name` | Institutional owners. |
| `Person` | `name`, `role` | Desk staff (company brain). |
| `Team` | `name`, `focus` | Org units. |
| `Project` | `name`, `status` | Work items owned by teams. |
| `Document` | `title`, `body` | Ingested research / memos. |
| `Decision` | `title`, `rationale`, `date`, `status` | Recorded decisions with provenance. |
| `Quote` | `price`, `changePct`, `ts`, `source` | Market snapshots; `source` is the true feed (`stooq-delayed` / `yahoo-delayed` / `simulated`). |
| `Position` | `tenant`, `ticker`, `qty`, `avgCost`, `note`, `openedAt`, `updatedAt` | A holding **you** entered. |
| `Episode` | `tenant`, `sessionId`, `role`, `content`, `ts` | One chat message — episodic memory. |
| `Memory` | `tenant`, `kind`, `topic`, `text`, `confidence`, `ts` | Facts (semantic) and desk policies (procedural). |

### Relationships

| Type | Direction | Properties | Used for |
| --- | --- | --- | --- |
| `SUPPLIES` | Company → Company | `component`, `criticality` | Contagion / supply-chain traversal |
| `COMPETES_WITH` | Company ↔ Company | `arena`, `intensity` | Peers, second-order exposure |
| `IN_SECTOR` | Company → Sector | — | Sector peers |
| `OWNS` | Fund → Company | `pct` | Ownership |
| `HAS_QUOTE` | Company → Quote | — | Price history stored in the graph |
| `POSITION_IN` | Position → Company | — | Portfolio × supply-web risk |
| `MEMBER_OF` | Person → Team | — | Org structure |
| `LEADS` / `WORKS_ON` | Person → Project | — | Who owns / knows what |
| `OWNED_BY` | Project → Team | — | Ownership |
| `AUTHORED` | Person → Document | — | Document provenance |
| `MENTIONS` | Document / Decision → Company | — | Links knowledge to the market graph |
| `DERIVED_FROM` | Decision → Document | — | **Decision provenance** |
| `DECIDED` | Person → Decision | — | Accountability |

### Tenancy

`Episode`, `Memory` and `Position` carry a `tenant` property and every
recall query filters on it, so memory never crosses tenants. Tenants are
selected by the UI tenant field, the CLI `--tenant` flag, or the MCP
`x-tenant` header (default `desk-1`). Tenancy is **logical** (one graph,
property-scoped) and is not an authentication boundary.

### Seed data

All graph content shipped in `src/lib/seed.ts` is **hand-authored synthetic
demo data** (20 companies, 6 sectors, 3 funds, 6 people, 3 teams, 3 projects,
4 documents, 3 decisions, 3 procedural memories ≈ 51 nodes / 111 edges). It
contains no private or restricted information. The graph then grows from real
usage: `Quote`, `Episode`, `Memory` and `Position` nodes, plus `Company`
nodes ingested on demand.

---

## 2. Queries the product depends on

### Track 1 — Agents That Act on Connected Data

**Supply-chain contagion (multi-hop)** — op `riskPropagation`, MCP tool `graph_risk_paths`

```cypher
MATCH path = (sup:Company {ticker: $ticker})-[:SUPPLIES*1..3]->(dependent:Company)
WITH length(path) AS hops, dependent, path
RETURN {ticker: dependent.ticker, name: dependent.name, hops: hops,
        chain: [n IN nodes(path) | n.ticker]} AS row
ORDER BY hops LIMIT 20
```

**Suppliers and customers** — op `supplyChain`, tool `graph_supply_chain`

```cypher
MATCH (c:Company {ticker: $ticker})
OPTIONAL MATCH (sup:Company)-[r1:SUPPLIES]->(c)
OPTIONAL MATCH (c)-[r2:SUPPLIES]->(cust:Company)
RETURN {suppliers: collect(DISTINCT {ticker: sup.ticker, name: sup.name,
                                     component: r1.component, criticality: r1.criticality}),
        customers: collect(DISTINCT {ticker: cust.ticker, name: cust.name,
                                     component: r2.component})} AS row
```

**Shortest connection between two companies (any relationship, ≤ 4 hops)** — op `pathBetween`, tool `graph_path`

```cypher
MATCH path = (a:Company {ticker: $a})-[*1..4]-(b:Company {ticker: $b})
RETURN {hops: length(path), chain: [n IN nodes(path) | coalesce(n.ticker, n.name)]} AS row
ORDER BY hops LIMIT 1
```

**Peers** — op `peersOf`, tool `graph_peers`

```cypher
MATCH (c:Company {ticker: $ticker})-[r:COMPETES_WITH]-(peer:Company)
RETURN DISTINCT {ticker: peer.ticker, name: peer.name,
                 arena: r.arena, intensity: r.intensity} AS row
```

**Degree centrality — most connected companies** — op `centrality`, tool `graph_centrality`

```cypher
MATCH (c:Company)
OPTIONAL MATCH (c)-[r]-()
WITH c, count(r) AS degree
RETURN {ticker: c.ticker, name: c.name, degree: degree} AS row
ORDER BY degree DESC LIMIT 10
```

**Acting on the graph — portfolio × contagion.** `portfolio_risk` reads the
tenant's `Position` nodes and intersects them with the `riskPropagation`
result: *"which of my holdings sit within 3 hops of the risk?"*

### Track 2 — Agent Memory and Coordination

**Episodic write** — op `putEpisode` (every turn is scribed by the ARCHIVE agent)

```cypher
MERGE (e:Episode {key: $key})
ON CREATE SET e = {key: $key, tenant: $tenant, sessionId: $sessionId,
                   role: $role, content: $content, ts: $ts}
RETURN properties(e) AS row
```

**Episodic recall** — op `recallEpisodes`

```cypher
MATCH (e:Episode {tenant: $tenant})
WHERE size($words) = 0 OR size([w IN $words WHERE toLower(e.content) CONTAINS w]) >= $minHits
RETURN properties(e) AS row ORDER BY e.ts DESC LIMIT 6
```

**Semantic / procedural memory write** — op `putMemory` (dedupes; repeated facts gain confidence)

```cypher
MERGE (m:Memory {key: $key})
ON CREATE SET m = $props, m.confidence = 1
ON MATCH SET m.confidence = m.confidence + 1, m.ts = $ts
RETURN properties(m) AS row
```

**Memory recall** — op `recallMemory`, tool `memory_recall`

```cypher
MATCH (m:Memory {tenant: $tenant})
WHERE size($words) = 0 OR size([w IN $words WHERE toLower(m.text + ' ' + m.topic) CONTAINS w]) >= $minHits
RETURN properties(m) AS row ORDER BY m.confidence DESC, m.ts DESC LIMIT 8
```

**Coordination.** The six agents (ORCHESTRA, ARCHIVE, TICKER, TOPOLOGY,
PROVENANCE, DESK-WRITER) share a LangGraph state and the graph itself: ARCHIVE
recalls from the graph before any specialist runs, specialists write artifacts
back (`Quote`, `Position`, `Document`, `Decision`), and ARCHIVE scribes the
finished turn so the next session — and the next agent — can see it.

### Track 3 — Company Brain

**Decision provenance** — op `decisionsAbout`, tool `brain_decisions`

```cypher
MATCH (d:Decision)
WHERE size($words) = 0 OR size([w IN $words WHERE toLower(d.title + ' ' + d.rationale) CONTAINS w]) >= $minHits
OPTIONAL MATCH (d)-[:DERIVED_FROM]->(doc:Document)
OPTIONAL MATCH (per:Person)-[:DECIDED]->(d)
OPTIONAL MATCH (d)-[:MENTIONS]->(c:Company)
WITH d, collect(DISTINCT doc.title) AS sources, collect(DISTINCT per.name) AS deciders,
     collect(DISTINCT c.ticker) AS tickers
RETURN {title: d.title, date: d.date, rationale: d.rationale, status: d.status,
        sources: sources, deciders: deciders, tickers: tickers} AS row
```

**Who knows about this?** — op `whoKnows`, tool `brain_who_knows`

```cypher
MATCH (per:Person)-[r]-(x)
WHERE (x:Team OR x:Project OR x:Document)
  AND (size($words) = 0 OR size([w IN $words WHERE
       toLower(coalesce(x.name,'') + ' ' + coalesce(x.title,'')) CONTAINS w]) >= $minHits)
RETURN DISTINCT {person: per.name, role: per.role, via: type(r),
                 thing: coalesce(x.name, x.title)} AS row
LIMIT 15
```

**Org overview** — op `orgOverview`, tool `brain_org`

```cypher
MATCH (t:Team)
OPTIONAL MATCH (per:Person)-[:MEMBER_OF]->(t)
OPTIONAL MATCH (pr:Project)-[:OWNED_BY]->(t)
OPTIONAL MATCH (lead:Person)-[:LEADS]->(pr)
WITH t, collect(DISTINCT per.name) AS members,
     collect(DISTINCT {name: pr.name, status: pr.status, lead: lead.name}) AS projects
RETURN {team: t.name, focus: t.focus, members: members, projects: projects} AS row
```

**Keeping knowledge current** — `ingestDocument` and `recordDecision` are
`MERGE`-based writes (`brain_ingest_document`, `brain_record_decision`), so
re-ingesting updates rather than duplicates, and new documents/decisions
immediately gain `MENTIONS` / `DERIVED_FROM` edges that later queries follow.

---

## 3. Explainability: how an answer shows its path

Every answer the desk returns includes:

1. a **reasoning trace** — which agent called which MCP tool, with which arguments;
2. a numbered **sources** block — each figure maps to a tool artifact
   (e.g. `S1: Position nodes · knowledge graph`, SEC filing + filed date,
   news publisher + URL + timestamp);
3. a **critic** verdict logged as an event — `verified`, `rewrite applied`,
   `inconclusive`, or `skipped`.

You can inspect the same graph visually in the app at `/graph`, or directly:

```bash
redis-cli GRAPH.QUERY finq "MATCH (n) RETURN head(labels(n)), count(n)"
```
