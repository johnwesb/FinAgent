/**
 * The Cypher catalog — every graph operation the agents can run,
 * expressed once as Cypher (executed against FalkorDB when live)
 * and once as an embedded executor (Postgres-backed compatibility
 * layer, same semantics, used when no FalkorDB server is reachable).
 */

export type Params = Record<string, unknown>;

export interface EmbeddedStore {
  allNodes(tenant: string | null, label?: string): Promise<NodeRec[]>;
  allEdges(tenant: string | null): Promise<EdgeRec[]>;
  nodeByKey(tenant: string, key: string): Promise<NodeRec | null>;
  upsertNode(
    tenant: string,
    label: string,
    key: string,
    props: Params,
  ): Promise<NodeRec>;
  addEdge(
    tenant: string,
    srcId: number,
    dstId: number,
    type: string,
    props: Params,
  ): Promise<void>;
  deleteEdges?(tenant: string, type: string, srcId: number): Promise<void>;
}

export interface NodeRec {
  id: number;
  tenant: string;
  label: string;
  key: string;
  props: Params;
}

export interface EdgeRec {
  id: number;
  src: number;
  dst: number;
  type: string;
  props: Params;
}

const LIT = (s: unknown) => String(s).replace(/[^A-Za-z0-9_.:-]/g, "");

export interface CatalogEntry {
  desc: string;
  cypher: (p: Params) => { text: string; params: Params };
  embedded: (p: Params, s: EmbeddedStore) => Promise<unknown>;
}

/* ---------------- helpers shared by embedded executors ---------------- */

function indexNodes(nodes: NodeRec[]): Map<number, NodeRec> {
  return new Map(nodes.map((n) => [n.id, n]));
}

interface MiniGraph {
  nodes: Map<number, NodeRec>;
  edges: EdgeRec[];
  out: Map<number, EdgeRec[]>;
  inn: Map<number, EdgeRec[]>;
  byKey: Map<string, NodeRec>;
}

async function loadGraph(s: EmbeddedStore, tenant: string): Promise<MiniGraph> {
  const [nodes, edges] = await Promise.all([
    s.allNodes(tenant),
    s.allEdges(tenant),
  ]);
  const out = new Map<number, EdgeRec[]>();
  const inn = new Map<number, EdgeRec[]>();
  for (const e of edges) {
    (out.get(e.src) ?? out.set(e.src, []).get(e.src)!).push(e);
    (inn.get(e.dst) ?? inn.set(e.dst, []).get(e.dst)!).push(e);
  }
  return {
    nodes: indexNodes(nodes),
    edges,
    out,
    inn,
    byKey: new Map(nodes.map((n) => [n.key, n])),
  };
}

function resolveKey(g: MiniGraph, ref: string): NodeRec | null {
  const upper = ref.toUpperCase();
  return (
    g.byKey.get(`Company:${upper}`) ??
    g.byKey.get(ref) ??
    [...g.byKey.values()].find(
      (n) =>
        String(n.props.ticker ?? "").toUpperCase() === upper ||
        String(n.props.name ?? "").toLowerCase() === ref.toLowerCase() ||
        String(n.key).toLowerCase() === ref.toLowerCase(),
    ) ??
    null
  );
}

function pathToString(g: MiniGraph, ids: number[], edgeTypes: string[]): string {
  return ids
    .map((id, i) => {
      const n = g.nodes.get(id)!;
      const label = n.props.ticker ?? n.props.name ?? n.key;
      return i === 0 ? String(label) : ` -[${edgeTypes[i - 1]}]-> ${label}`;
    })
    .join("");
}

function bfs(
  g: MiniGraph,
  start: NodeRec,
  opts: { edgeTypes?: string[]; reverse?: boolean; maxDepth: number; limit?: number },
): { node: NodeRec; depth: number; path: number[]; edgePath: string[] }[] {
  const results: {
    node: NodeRec;
    depth: number;
    path: number[];
    edgePath: string[];
  }[] = [];
  const seen = new Set<number>([start.id]);
  const queue: { id: number; depth: number; path: number[]; edgePath: string[] }[] = [
    { id: start.id, depth: 0, path: [start.id], edgePath: [] },
  ];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= opts.maxDepth) continue;
    const edges = opts.reverse ? g.inn.get(cur.id) ?? [] : g.out.get(cur.id) ?? [];
    for (const e of edges) {
      if (opts.edgeTypes && !opts.edgeTypes.includes(e.type)) continue;
      const nxt = opts.reverse ? e.src : e.dst;
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      const node = g.nodes.get(nxt);
      if (!node) continue;
      const path = [...cur.path, nxt];
      const edgePath = [...cur.edgePath, e.type];
      results.push({ node, depth: cur.depth + 1, path, edgePath });
      queue.push({ id: nxt, depth: cur.depth + 1, path, edgePath });
      if (opts.limit && results.length >= opts.limit) return results;
    }
  }
  return results;
}

const like = (hay: unknown, needle: string) =>
  String(hay ?? "").toLowerCase().includes(needle.toLowerCase());

/**
 * Word-boundary company mention extraction — shared by the embedded
 * executors AND the FalkorDB composite pipelines, so both backends
 * link identical MENTIONS edges.
 */
export function computeMentions(
  text: string,
  companies: { ticker?: unknown; name?: unknown }[],
): string[] {
  const padded = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const out: string[] = [];
  for (const c of companies) {
    const ticker = String(c.ticker ?? "");
    const name = String(c.name ?? "").toLowerCase();
    if (
      (ticker && padded.includes(` ${ticker.toLowerCase()} `)) ||
      (name && String(text).toLowerCase().includes(name))
    ) {
      out.push(ticker);
    }
  }
  return out;
}

/** Split a query into significant words + hit threshold (parity across backends). */
export function wordsOf(q: unknown): { words: string[]; minHits: number } {
  const words = String(q ?? "")
    .toLowerCase()
    .split(/[^\w]+/)
    .filter((w) => w.length > 3);
  return { words, minHits: words.length ? Math.min(2, words.length) : 0 };
}

/* ------------------------------ catalog ------------------------------ */

export const CATALOG: Record<string, CatalogEntry> = {
  companyProfile: {
    desc: "Company node by ticker",
    cypher: (p) => ({
      text: "MATCH (c:Company {ticker: $ticker}) RETURN properties(c) AS row",
      params: { ticker: LIT(p.ticker) },
    }),
    embedded: async (p, s) => {
      const n = await s.nodeByKey("global", `Company:${LIT(p.ticker)}`);
      return n ? n.props : null;
    },
  },

  searchCompanies: {
    desc: "Fuzzy company search by name/ticker",
    cypher: (p) => ({
      text: "MATCH (c:Company) WHERE toLower(c.name) CONTAINS toLower($q) OR toLower(c.ticker) CONTAINS toLower($q) RETURN properties(c) AS row LIMIT 8",
      params: { q: String(p.q) },
    }),
    embedded: async (p, s) => {
      const nodes = await s.allNodes("global", "Company");
      return nodes
        .filter(
          (n) =>
            like(n.props.name, String(p.q)) ||
            like(n.props.ticker, String(p.q)) ||
            like(n.props.industry, String(p.q)),
        )
        .slice(0, 8)
        .map((n) => n.props);
    },
  },

  peersOf: {
    desc: "Direct competitors via COMPETES_WITH",
    cypher: (p) => ({
      text: "MATCH (c:Company {ticker: $ticker})-[r:COMPETES_WITH]-(peer:Company) RETURN DISTINCT {ticker: peer.ticker, name: peer.name, arena: r.arena, intensity: r.intensity} AS row",
      params: { ticker: LIT(p.ticker) },
    }),
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      const me = resolveKey(g, String(p.ticker));
      if (!me) return [];
      const edges = [...(g.out.get(me.id) ?? []), ...(g.inn.get(me.id) ?? [])]
        .filter((e) => e.type === "COMPETES_WITH");
      const seen = new Set<number>();
      const rows: {
        ticker: unknown;
        name: unknown;
        arena: unknown;
        intensity: unknown;
      }[] = [];
      for (const e of edges) {
        const other = g.nodes.get(e.src === me.id ? e.dst : e.src)!;
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        rows.push({
          ticker: other.props.ticker,
          name: other.props.name,
          arena: e.props.arena,
          intensity: e.props.intensity,
        });
      }
      return rows;
    },
  },

  sectorPeers: {
    desc: "Companies in the same sector (2-hop via Sector node)",
    cypher: (p) => ({
      text: "MATCH (c:Company {ticker: $ticker})-[:IN_SECTOR]->(sec:Sector)<-[:IN_SECTOR]-(peer:Company) RETURN {ticker: peer.ticker, name: peer.name, sector: sec.name} AS row",
      params: { ticker: LIT(p.ticker) },
    }),
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      const me = resolveKey(g, String(p.ticker));
      if (!me) return [];
      const secs = (g.out.get(me.id) ?? [])
        .filter((e) => e.type === "IN_SECTOR")
        .map((e) => g.nodes.get(e.dst)!);
      const rows: unknown[] = [];
      for (const sec of secs) {
        for (const e of g.inn.get(sec.id) ?? []) {
          if (e.type !== "IN_SECTOR") continue;
          const peer = g.nodes.get(e.src)!;
          if (peer.id !== me.id)
            rows.push({ ticker: peer.props.ticker, name: peer.props.name, sector: sec.props.name });
        }
      }
      return rows;
    },
  },

  supplyChain: {
    desc: "Suppliers and customers around a company",
    cypher: (p) => ({
      text: "MATCH (c:Company {ticker: $ticker}) OPTIONAL MATCH (sup:Company)-[r1:SUPPLIES]->(c) OPTIONAL MATCH (c)-[r2:SUPPLIES]->(cust:Company) RETURN {suppliers: collect(DISTINCT {ticker: sup.ticker, name: sup.name, component: r1.component, criticality: r1.criticality}), customers: collect(DISTINCT {ticker: cust.ticker, name: cust.name, component: r2.component})} AS row",
      params: { ticker: LIT(p.ticker) },
    }),
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      const me = resolveKey(g, String(p.ticker));
      if (!me) return { suppliers: [], customers: [] };
      const suppliers = (g.inn.get(me.id) ?? [])
        .filter((e) => e.type === "SUPPLIES")
        .map((e) => ({
          ticker: g.nodes.get(e.src)!.props.ticker,
          name: g.nodes.get(e.src)!.props.name,
          component: e.props.component,
          criticality: e.props.criticality,
        }));
      const customers = (g.out.get(me.id) ?? [])
        .filter((e) => e.type === "SUPPLIES")
        .map((e) => ({
          ticker: g.nodes.get(e.dst)!.props.ticker,
          name: g.nodes.get(e.dst)!.props.name,
          component: e.props.component,
        }));
      return [{ suppliers, customers }];
    },
  },

  riskPropagation: {
    desc: "Multi-hop: which companies depend on this one (SUPPLIES reversed BFS)",
    cypher: (p) => ({
      text: "MATCH path = (sup:Company {ticker: $ticker})-[:SUPPLIES*1..3]->(dependent:Company) WITH length(path) AS hops, dependent, path RETURN {ticker: dependent.ticker, name: dependent.name, hops: hops, chain: [n IN nodes(path) | n.ticker]} AS row ORDER BY hops LIMIT 20",
      params: { ticker: LIT(p.ticker) },
    }),
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      const me = resolveKey(g, String(p.ticker));
      if (!me) return [];
      return bfs(g, me, { edgeTypes: ["SUPPLIES"], maxDepth: 3, limit: 20 }).map(
        (r) => ({
          ticker: r.node.props.ticker,
          name: r.node.props.name,
          hops: r.depth,
          chain: r.path.map((id) => g.nodes.get(id)!.props.ticker),
          readable: pathToString(g, r.path, r.edgePath),
        }),
      );
    },
  },

  pathBetween: {
    desc: "Shortest path between two companies (any relationship, ≤4 hops)",
    cypher: (p) => ({
      text: "MATCH path = (a:Company {ticker: $a})-[*1..4]-(b:Company {ticker: $b}) RETURN {hops: length(path), chain: [n IN nodes(path) | coalesce(n.ticker, n.name)]} AS row ORDER BY hops LIMIT 1",
      params: { a: LIT(p.a), b: LIT(p.b) },
    }),
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      const a = resolveKey(g, String(p.a));
      const b = resolveKey(g, String(p.b));
      if (!a || !b) return [];
      const queue: { id: number; path: number[]; edgePath: string[] }[] = [
        { id: a.id, path: [a.id], edgePath: [] },
      ];
      const seen = new Set([a.id]);
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur.path.length > 5) break;
        const edges = [...(g.out.get(cur.id) ?? []), ...(g.inn.get(cur.id) ?? [])];
        for (const e of edges) {
          const nxt = e.src === cur.id ? e.dst : e.src;
          if (seen.has(nxt)) continue;
          const path = [...cur.path, nxt];
          const edgePath = [...cur.edgePath, e.type];
          if (nxt === b.id) return [{ readable: pathToString(g, path, edgePath), hops: path.length - 1 }];
          seen.add(nxt);
          queue.push({ id: nxt, path, edgePath });
        }
      }
      return [];
    },
  },

  centrality: {
    desc: "Degree centrality — most connected companies",
    cypher: () => ({
      text: "MATCH (c:Company) OPTIONAL MATCH (c)-[r]-() WITH c, count(r) AS degree RETURN {ticker: c.ticker, name: c.name, degree: degree} AS row ORDER BY degree DESC LIMIT 10",
      params: {},
    }),
    embedded: async (_p, s) => {
      const g = await loadGraph(s, "global");
      const deg = new Map<number, number>();
      for (const e of g.edges) {
        deg.set(e.src, (deg.get(e.src) ?? 0) + 1);
        deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1);
      }
      return [...deg.entries()]
        .map(([id, d]) => ({ node: g.nodes.get(id)!, degree: d }))
        .filter((r) => r.node?.label === "Company")
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 10)
        .map((r) => ({
          ticker: r.node.props.ticker,
          name: r.node.props.name,
          degree: r.degree,
        }));
    },
  },

  decisionsAbout: {
    desc: "Decisions mentioning a topic/company, with provenance (DERIVED_FROM, DECIDED_BY)",
    cypher: (p) => {
      const { words, minHits } = wordsOf(p.q);
      return {
        text: "MATCH (d:Decision) WHERE size($words) = 0 OR size([w IN $words WHERE toLower(d.title + ' ' + d.rationale) CONTAINS w]) >= $minHits OPTIONAL MATCH (d)-[:DERIVED_FROM]->(doc:Document) OPTIONAL MATCH (per:Person)-[:DECIDED]->(d) OPTIONAL MATCH (d)-[:MENTIONS]->(c:Company) WITH d, collect(DISTINCT doc.title) AS sources, collect(DISTINCT per.name) AS deciders, collect(DISTINCT c.ticker) AS tickers RETURN {title: d.title, date: d.date, rationale: d.rationale, status: d.status, sources: sources, deciders: deciders, tickers: tickers} AS row",
        params: { words, minHits },
      };
    },
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      // parity with the live cypher: wordsOf (len > 3) + minHits threshold,
      // not a hand-rolled >2 split with any-one-hit matching.
      const { words, minHits } = wordsOf(p.q);
      const hay = (d: NodeRec) =>
        `${d.props.title ?? ""} ${d.props.rationale ?? ""}`.toLowerCase();
      const out: unknown[] = [];
      for (const d of g.byKey.values()) {
        if (d.label !== "Decision") continue;
        if (words.filter((w) => hay(d).includes(w)).length < minHits) continue;
        const sources = (g.out.get(d.id) ?? [])
          .filter((e) => e.type === "DERIVED_FROM")
          .map((e) => g.nodes.get(e.dst)!.props.title);
        const deciders = (g.inn.get(d.id) ?? [])
          .filter((e) => e.type === "DECIDED")
          .map((e) => g.nodes.get(e.src)!.props.name);
        const tickers = (g.out.get(d.id) ?? [])
          .filter((e) => e.type === "MENTIONS")
          .map((e) => g.nodes.get(e.dst)!.props.ticker);
        out.push({
          title: d.props.title,
          date: d.props.date,
          status: d.props.status,
          rationale: d.props.rationale,
          sources,
          deciders,
          tickers,
        });
      }
      return out;
    },
  },

  whoKnows: {
    desc: "People connected to teams/projects/documents matching a topic",
    cypher: (p) => {
      const { words, minHits } = wordsOf(p.q);
      return {
        text: "MATCH (per:Person)-[r]-(x) WHERE (x:Team OR x:Project OR x:Document) AND (size($words) = 0 OR size([w IN $words WHERE toLower(coalesce(x.name,'') + ' ' + coalesce(x.title,'')) CONTAINS w]) >= $minHits) RETURN DISTINCT {person: per.name, role: per.role, via: type(r), thing: coalesce(x.name, x.title)} AS row LIMIT 15",
        params: { words, minHits },
      };
    },
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      // parity with the live cypher: wordsOf (len > 3) + minHits, and the
      // haystack concatenates name + title the way coalesce(x.name)+coalesce(x.title) does.
      const { words, minHits } = wordsOf(p.q);
      const rows: unknown[] = [];
      for (const per of g.byKey.values()) {
        if (per.label !== "Person") continue;
        const edges = [...(g.out.get(per.id) ?? []), ...(g.inn.get(per.id) ?? [])];
        for (const e of edges) {
          const other = g.nodes.get(e.src === per.id ? e.dst : e.src)!;
          if (!["Team", "Project", "Document"].includes(other.label)) continue;
          const thing = String(other.props.name ?? other.props.title ?? "");
          const hay = `${other.props.name ?? ""} ${other.props.title ?? ""}`.toLowerCase();
          if (words.filter((w) => hay.includes(w)).length < minHits) continue;
          rows.push({ person: per.props.name, role: per.props.role, via: e.type, thing });
        }
      }
      return rows.slice(0, 15);
    },
  },

  orgOverview: {
    desc: "Teams with members, projects and owners",
    cypher: () => ({
      text: "MATCH (t:Team) OPTIONAL MATCH (per:Person)-[:MEMBER_OF]->(t) OPTIONAL MATCH (pr:Project)-[:OWNED_BY]->(t) OPTIONAL MATCH (lead:Person)-[:LEADS]->(pr) WITH t, collect(DISTINCT per.name) AS members, collect(DISTINCT {name: pr.name, status: pr.status, lead: lead.name}) AS projects RETURN {team: t.name, focus: t.focus, members: members, projects: projects} AS row",
      params: {},
    }),
    embedded: async (_p, s) => {
      const g = await loadGraph(s, "global");
      const rows: unknown[] = [];
      for (const t of g.byKey.values()) {
        if (t.label !== "Team") continue;
        const members = (g.inn.get(t.id) ?? [])
          .filter((e) => e.type === "MEMBER_OF")
          .map((e) => g.nodes.get(e.src)!.props.name);
        const projects = (g.inn.get(t.id) ?? [])
          .filter((e) => e.type === "OWNED_BY")
          .map((e) => {
            const pr = g.nodes.get(e.src)!;
            const lead = (g.inn.get(pr.id) ?? []).find((l) => l.type === "LEADS");
            return {
              name: pr.props.name,
              status: pr.props.status,
              lead: lead ? g.nodes.get(lead.src)!.props.name : null,
            };
          });
        rows.push({ team: t.props.name, focus: t.props.focus, members, projects });
      }
      return rows;
    },
  },

  ingestDocument: {
    desc: "Add a Document node, link mentions + storage",
    cypher: (p) => ({
      text: "MERGE (d:Document {key: $key}) SET d += $props RETURN d AS row",
      params: { key: String(p.key), props: p },
    }),
    embedded: async (p, s) => {
      const n = await s.upsertNode("global", "Document", String(p.key), p);
      const g = await loadGraph(s, "global");
      const mentioned: string[] = [];
      const body = `${p.title ?? ""} ${p.body ?? ""}`.toLowerCase();
      for (const c of g.byKey.values()) {
        if (c.label !== "Company") continue;
        const ticker = String(c.props.ticker ?? "");
        const name = String(c.props.name ?? "");
        const tickerHit =
          ticker && new RegExp(`\\b${ticker}\\b`, "i").test(body);
        const nameHit = name && body.includes(name.toLowerCase());
        if (tickerHit || nameHit) {
          await s.addEdge("global", n.id, c.id, "MENTIONS", {});
          mentioned.push(ticker);
        }
      }
      return { nodeKey: n.key, mentioned };
    },
  },

  recordDecision: {
    desc: "Add a Decision with provenance links",
    cypher: (p) => ({
      text: "MERGE (d:Decision {key: $key}) SET d += $props RETURN d AS row",
      params: { key: String(p.key), props: p },
    }),
    embedded: async (p, s) => {
      const n = await s.upsertNode("global", "Decision", String(p.key), {
        title: p.title,
        rationale: p.rationale ?? "",
        date: p.date ?? new Date().toISOString().slice(0, 10),
        status: p.status ?? "active",
      });
      const g = await loadGraph(s, "global");
      const linked: string[] = [];
      // link mentioned companies (word-boundary for tickers: BA must not match "backlog")
      const text = `${p.title} ${p.rationale ?? ""}`.toLowerCase();
      for (const c of g.byKey.values()) {
        if (c.label !== "Company") continue;
        const ticker = String(c.props.ticker ?? "");
        const name = String(c.props.name ?? "");
        const tickerHit =
          ticker && new RegExp(`\\b${ticker}\\b`, "i").test(text);
        const nameHit = name && text.includes(name.toLowerCase());
        if (tickerHit || nameHit) {
          await s.addEdge("global", n.id, c.id, "MENTIONS", {});
          linked.push(ticker);
        }
      }
      // provenance — accept an array or a comma-separated string (never
      // iterate a raw string char-by-char, which links garbage edges)
      const rawSources = p.sources;
      const sourceTitles = Array.isArray(rawSources)
        ? rawSources.map(String)
        : rawSources
          ? String(rawSources)
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
      for (const title of sourceTitles) {
        const doc = [...g.byKey.values()].find(
          (x) => x.label === "Document" && like(x.props.title, title),
        );
        if (doc) await s.addEdge("global", n.id, doc.id, "DERIVED_FROM", {});
      }
      if (p.decidedBy) {
        const per = [...g.byKey.values()].find(
          (x) => x.label === "Person" && like(x.props.name, String(p.decidedBy)),
        );
        if (per) await s.addEdge("global", per.id, n.id, "DECIDED", {});
      }
      return { nodeKey: n.key, mentioned: linked };
    },
  },

  putQuote: {
    desc: "Attach a fresh Quote node to a company, prune to last 40",
    cypher: (p) => {
      // key mirrors the embedded contract (Quote:TICKER:ts) — without it viz
      // renders null-keyed nodes and React duplicate-keys the graph page.
      // ts/price/etc are $-referenced: default them so sanitizeParams can't
      // drop a key the engine needs.
      const ts = Number(p.ts ?? Date.now());
      return {
        // MERGE, not CREATE: the key is stable per ticker+close-time, so a
        // second get_quote the same day would otherwise stack duplicate
        // nodes/edges — and React would duplicate-key the viz again.
        text: "MATCH (c:Company {ticker: $ticker}) MERGE (q:Quote {key: $key}) SET q.price = $price, q.changePct = $changePct, q.ts = $ts, q.source = $source MERGE (c)-[:HAS_QUOTE]->(q) RETURN properties(q) AS row",
        params: {
          ticker: LIT(p.ticker),
          key: `Quote:${LIT(p.ticker)}:${ts}`,
          price: Number(p.price ?? 0),
          changePct: Number(p.changePct ?? 0),
          ts,
          source: String(p.source ?? "simulated"),
        },
      };
    },
    embedded: async (p, s) => {
      const c = await s.nodeByKey("global", `Company:${LIT(p.ticker)}`);
      if (!c) return null;
      const q = await s.upsertNode(
        "global",
        "Quote",
        `Quote:${LIT(p.ticker)}:${p.ts}`,
        { price: p.price, changePct: p.changePct, ts: p.ts, source: p.source },
      );
      await s.addEdge("global", c.id, q.id, "HAS_QUOTE", {});
      return { stored: true, key: q.key };
    },
  },

  latestQuote: {
    desc: "Most recent stored quote for a ticker",
    cypher: (p) => ({
      text: "MATCH (c:Company {ticker: $ticker})-[:HAS_QUOTE]->(q:Quote) RETURN properties(q) AS row ORDER BY q.ts DESC LIMIT 1",
      params: { ticker: LIT(p.ticker) },
    }),
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      const c = g.byKey.get(`Company:${LIT(p.ticker)}`);
      if (!c) return null;
      const quotes = (g.out.get(c.id) ?? [])
        .filter((e) => e.type === "HAS_QUOTE")
        .map((e) => g.nodes.get(e.dst)!)
        .filter((n) => n?.label === "Quote");
      quotes.sort((a, b) => Number(b.props.ts) - Number(a.props.ts));
      return quotes[0]?.props ?? null;
    },
  },

  putEpisode: {
    desc: "Track 2 episodic memory — a message node for a tenant session",
    cypher: (p) => {
      // sessionId/ts are $-referenced: an undefined would be dropped by
      // sanitizeParams and the engine rejects unbound params ("Missing
      // parameters") — which demotes the whole driver. Default them here.
      const sessionId = Number(p.sessionId ?? 0);
      const ts = Number(p.ts ?? Date.now());
      return {
        text: "MERGE (e:Episode {key: $key}) ON CREATE SET e = {key: $key, tenant: $tenant, sessionId: $sessionId, role: $role, content: $content, ts: $ts} RETURN properties(e) AS row",
        params: {
          key: String(p.key),
          tenant: String(p.tenant),
          sessionId,
          role: String(p.role),
          content: String(p.content).slice(0, 4000),
          ts,
        },
      };
    },
    embedded: async (p, s) => {
      const n = await s.upsertNode(String(p.tenant), "Episode", String(p.key), {
        sessionId: p.sessionId,
        role: p.role,
        content: String(p.content).slice(0, 4000),
        ts: p.ts,
      });
      return { stored: true, key: n.key };
    },
  },

  recallEpisodes: {
    desc: "Search episodic memory (past messages) for a tenant",
    cypher: (p) => {
      const { words, minHits } = wordsOf(p.q);
      return {
        text: "MATCH (e:Episode {tenant: $tenant}) WHERE size($words) = 0 OR size([w IN $words WHERE toLower(e.content) CONTAINS w]) >= $minHits RETURN properties(e) AS row ORDER BY e.ts DESC LIMIT 6",
        params: { tenant: String(p.tenant), words, minHits },
      };
    },
    embedded: async (p, s) => {
      const nodes = await s.allNodes(String(p.tenant), "Episode");
      const words = String(p.q)
        .toLowerCase()
        .split(/[^\w]+/)
        .filter((w) => w.length > 3);
      return nodes
        .filter((n) => {
          const content = String(n.props.content ?? "").toLowerCase();
          if (!words.length) return true;
          const hits = words.filter((w) => content.includes(w)).length;
          return hits >= Math.min(2, words.length);
        })
        .sort((a, b) => Number(b.props.ts) - Number(a.props.ts))
        .slice(0, 6)
        .map((n) => n.props);
    },
  },

  putMemory: {
    desc: "Semantic/procedural memory upsert, dedupes on text, bumps confidence",
    cypher: (p) => {
      // $ts is referenced by both SET and MATCH clauses — undefined would be
      // dropped by sanitizeParams and the engine rejects the whole query.
      const ts = Number(p.ts ?? Date.now());
      return {
        text: "MERGE (m:Memory {key: $key}) ON CREATE SET m = $props, m.confidence = 1 ON MATCH SET m.confidence = m.confidence + 1, m.ts = $ts RETURN properties(m) AS row",
        params: {
          key: String(p.key),
          props: {
            key: String(p.key),
            tenant: p.tenant,
            kind: p.kind,
            text: p.text,
            topic: p.topic ?? "",
            ts,
          },
          ts,
        },
      };
    },
    embedded: async (p, s) => {
      const existing = await s.nodeByKey(String(p.tenant), String(p.key));
      const conf = existing ? Number(existing.props.confidence ?? 1) + 1 : 1;
      const n = await s.upsertNode(String(p.tenant), "Memory", String(p.key), {
        kind: p.kind,
        text: String(p.text).slice(0, 1000),
        topic: p.topic ?? "",
        ts: p.ts,
        confidence: conf,
      });
      return { stored: true, key: n.key, confidence: conf };
    },
  },

  recallMemory: {
    desc: "Semantic + procedural memory search for a tenant",
    cypher: (p) => {
      const { words, minHits } = wordsOf(p.q);
      return {
        text: "MATCH (m:Memory {tenant: $tenant}) WHERE size($words) = 0 OR size([w IN $words WHERE toLower(m.text + ' ' + m.topic) CONTAINS w]) >= $minHits RETURN properties(m) AS row ORDER BY m.confidence DESC, m.ts DESC LIMIT 8",
        params: { tenant: String(p.tenant), words, minHits },
      };
    },
    embedded: async (p, s) => {
      const nodes = await s.allNodes(String(p.tenant), "Memory");
      const words = String(p.q)
        .toLowerCase()
        .split(/[^\w]+/)
        .filter((w) => w.length > 3);
      return nodes
        .filter((n) => {
          const hay = `${n.props.text ?? ""} ${n.props.topic ?? ""}`.toLowerCase();
          if (!words.length) return true;
          const hits = words.filter((w) => hay.includes(w)).length;
          return hits >= Math.min(2, words.length);
        })
        .sort(
          (a, b) =>
            Number(b.props.confidence ?? 1) - Number(a.props.confidence ?? 1) ||
            Number(b.props.ts) - Number(a.props.ts),
        )
        .slice(0, 8)
        .map((n) => n.props);
    },
  },

  listMemory: {
    desc: "All memory for a tenant, optionally by kind",
    cypher: (p) => ({
      text: p.kind
        ? "MATCH (m:Memory {tenant: $tenant, kind: $kind}) RETURN properties(m) AS row ORDER BY m.ts DESC LIMIT 100"
        : "MATCH (m:Memory {tenant: $tenant}) RETURN properties(m) AS row ORDER BY m.ts DESC LIMIT 100",
      params: { tenant: String(p.tenant), kind: p.kind },
    }),
    embedded: async (p, s) => {
      const nodes = await s.allNodes(String(p.tenant), "Memory");
      return nodes
        .filter((n) => !p.kind || n.props.kind === p.kind)
        .sort((a, b) => Number(b.props.ts) - Number(a.props.ts))
        .slice(0, 100)
        .map((n) => n.props);
    },
  },

  graphOverview: {
    desc: "Node counts by label + edge counts by type (viz + status)",
    cypher: () => ({
      text: "MATCH (n) RETURN {label: head(labels(n)), count: count(n)} AS row",
      params: {},
    }),
    embedded: async (_p, s) => {
      const nodes = await s.allNodes(null);
      const edges = await s.allEdges(null);
      const byLabel: Record<string, number> = {};
      for (const n of nodes) byLabel[n.label] = (byLabel[n.label] ?? 0) + 1;
      const byType: Record<string, number> = {};
      for (const e of edges) byType[e.type] = (byType[e.type] ?? 0) + 1;
      return { byLabel, byType, total: nodes.length, edgeTotal: edges.length };
    },
  },

  vizNodes: {
    desc: "Node sample for the graph explorer (works on live engines + compat store)",
    cypher: () => ({
      text: "MATCH (n) RETURN {key: n.key, label: head(labels(n)), props: properties(n)} AS row LIMIT 160",
      params: {},
    }),
    embedded: async (_p, s) => {
      const nodes = await s.allNodes(null);
      return nodes.slice(0, 160).map((n) => ({ key: n.key, label: n.label, props: n.props }));
    },
  },

  vizEdges: {
    desc: "Edge sample for the graph explorer (key-addressed)",
    cypher: () => ({
      text: "MATCH (a)-[r]->(b) RETURN {from: a.key, to: b.key, type: type(r)} AS row LIMIT 400",
      params: {},
    }),
    embedded: async (_p, s) => {
      const edges = await s.allEdges(null);
      const nodes = await s.allNodes(null);
      const key = new Map(nodes.map((n) => [n.id, n.key]));
      return edges
        .slice(0, 400)
        .map((e) => ({ from: key.get(e.src) ?? "", to: key.get(e.dst) ?? "", type: e.type }));
    },
  },

  exploreNeighborhood: {
    desc: "Node + its neighbors for the graph explorer",
    cypher: (p) => ({
      // WITH must group ONLY n: `WITH n, r, m` + collect() made FalkorDB
      // return null for the sibling node map (properties of grouping keys
      // outside the aggregate go null). Null-guards keep isolated nodes.
      text: "MATCH (n {key: $key}) OPTIONAL MATCH (n)-[r]-(m) WITH n, collect({type: CASE WHEN r IS NULL THEN null ELSE type(r) END, dir: CASE WHEN r IS NULL THEN 'none' WHEN startNode(r).key = n.key THEN 'out' ELSE 'in' END, other: {key: CASE WHEN m IS NULL THEN null ELSE m.key END, label: CASE WHEN m IS NULL THEN null ELSE head(labels(m)) END, props: CASE WHEN m IS NULL THEN {} ELSE properties(m) END}}) AS edges RETURN {node: {key: n.key, label: head(labels(n)), props: properties(n)}, edges: [e IN edges WHERE e.dir <> 'none']} AS row LIMIT 60",
      params: { key: String(p.key) },
    }),
    embedded: async (p, s) => {
      const g = await loadGraph(s, "global");
      const me = g.byKey.get(String(p.key));
      if (!me) return null;
      const edges = [...(g.out.get(me.id) ?? []), ...(g.inn.get(me.id) ?? [])]
        .slice(0, 60)
        .map((e) => {
          const otherId = e.src === me.id ? e.dst : e.src;
          const other = g.nodes.get(otherId)!;
          return {
            type: e.type,
            dir: e.src === me.id ? "out" : "in",
            other: { key: other.key, label: other.label, props: other.props },
          };
        });
      return { node: { key: me.key, label: me.label, props: me.props }, edges };
    },
  },

  upsertCompany: {
    desc: "Write: upsert a company node",
    cypher: (p) => ({
      text: "MERGE (c:Company {ticker: $ticker}) SET c += $props, c.key = $key RETURN properties(c) AS row",
      params: { ticker: LIT(p.ticker), props: p.props, key: `Company:${LIT(p.ticker)}` },
    }),
    embedded: async (p, s) => {
      const props = (p.props ?? {}) as Params;
      return s.upsertNode("global", "Company", `Company:${LIT(p.ticker)}`, {
        ticker: LIT(p.ticker),
        ...props,
      });
    },
  },

  link: {
    desc: "Write: create an edge between two node keys",
    cypher: (p) => ({
      text: `MATCH (a {key: $src}), (b {key: $dst}) MERGE (a)-[r:${LIT(p.type)}]->(b) SET r += $props RETURN a.key AS row`,
      params: {
        src: String(p.src),
        dst: String(p.dst),
        props: (p.props ?? {}) as Params,
      },
    }),
    embedded: async (p, s) => {
      const a = (await s.nodeByKey("global", String(p.src))) ?? null;
      const b = (await s.nodeByKey("global", String(p.dst))) ?? null;
      if (a && b)
        await s.addEdge("global", a.id, b.id, LIT(p.type), (p.props ?? {}) as Params);
      return { linked: !!(a && b) };
    },
  },

  upsertNode: {
    desc: "Write: generic upsert of any labeled node by key",
    cypher: (p) => ({
      text: `MERGE (n:${LIT(p.label)} {key: $key}) SET n += $props, n.key = $key RETURN properties(n) AS row`,
      params: { key: String(p.key), props: { ...((p.props ?? {}) as Params) } },
    }),
    embedded: async (p, s) => {
      return s.upsertNode(
        "global",
        LIT(p.label),
        String(p.key),
        (p.props ?? {}) as Params,
      );
    },
  },

  allCompanies: {
    desc: "Every company (ticker + name) — used by mention scanners",
    cypher: () => ({
      text: "MATCH (c:Company) RETURN {ticker: c.ticker, name: c.name} AS row",
      params: {},
    }),
    embedded: async (_p, s) => {
      const nodes = await s.allNodes("global", "Company");
      return nodes.map((n) => ({ ticker: n.props.ticker, name: n.props.name }));
    },
  },

  allByLabel: {
    desc: "Keys + core props for every node of a label (composite pipelines)",
    cypher: (p) => ({
      text: `MATCH (n:${LIT(p.label)}) RETURN {key: n.key, name: coalesce(n.name, n.title), props: properties(n)} AS row`,
      params: {},
    }),
    embedded: async (p, s) => {
      const nodes = await s.allNodes(null, LIT(p.label));
      return nodes.map((n) => ({
        key: n.key,
        name: n.props.name ?? n.props.title,
        props: n.props,
      }));
    },
  },
};

export type OpName = keyof typeof CATALOG;
