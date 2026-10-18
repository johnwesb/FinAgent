/**
 * GRAPH DRIVER — FalkorDB is the mind of the desk.
 *
 * Boot ladder (evaluated at startup, re-evaluated when degraded):
 *
 *   1. FALKORDB (remote) .. configured server / docker / cloud
 *   2. FALKORDB LITE ...... embedded REAL FalkorDB engine auto-booted
 *                            via falkordblite (bundled redis-server +
 *                            FalkorDB module), persisted to .data/falkordb
 *   3. DEGRADED ........... Postgres compatibility store — emergency
 *                            mode only, labeled loudly. Same catalog,
 *                            but the platform asks for a real engine.
 *
 * The knowledge graph holds ALL agentic state: companies, relationships,
 * quotes, episodic/semantic/procedural memory, and the entire company
 * brain. SQL keeps only plumbing (roster, telemetry, chat threads).
 * Every write flows through this driver.
 */

import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { embeddedStore } from "./embedded";
import { CATALOG, computeMentions, type Params } from "./queries";

export type GraphMode = "falkordb" | "falkordb-lite" | "embedded";

interface DriverState {
  mode: GraphMode;
  url: string;
  error?: string;
  checkedAt: number;
   
  client: any | null;
   
  graph: any | null;
   
  lite: any | null;
  booting: boolean;
}

const g = globalThis as typeof globalThis & {
  __finGraphDriver?: DriverState;
};

const state: DriverState = (g.__finGraphDriver ??= {
  mode: "embedded",
  url: "",
  checkedAt: 0,
  client: null,
  graph: null,
  lite: null,
  booting: false,
});

const GRAPH_NAME = "finq";
const RECHECK_MS = 25_000;

export async function getFalkorUrl(): Promise<string> {
  try {
    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "falkordb_url"));
    if (rows[0]?.value) return rows[0].value;
  } catch {
    /* settings table may not exist yet on first boot */
  }
  return process.env.FALKORDB_URL || "redis://localhost:6379";
}

/* --------------------------- boot ladder --------------------------- */

async function tryRemote(): Promise<boolean> {
  const url = await getFalkorUrl();
  try {
    const { FalkorDB } = await import("falkordb");
    const connect = FalkorDB.connect({ url });
    const client = (await Promise.race([
      connect,
      new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout")), 2000)),
       
    ])) as any;
    const graph = client.selectGraph(GRAPH_NAME);
    await Promise.race([
      graph.query("RETURN 1"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ping timeout")), 2000)),
    ]);
    state.client = client;
    state.graph = graph;
    state.mode = "falkordb";
    state.url = url;
    state.error = undefined;
    return true;
  } catch (e) {
    state.error = e instanceof Error ? e.message : "remote unreachable";
    return false;
  }
}

/** Auto-provision a REAL FalkorDB engine in-process (bundled server binary). */
async function tryLite(): Promise<boolean> {
  try {
    // Reattach to an engine we already booted. demote() clears client/graph
    // but leaves lite running; reopening here used to spawn a fresh redis
    // process on every demote→boot cycle and orphan the previous one.
    if (state.lite?.isRunning) {
      state.client = state.lite;
      state.graph = state.lite.selectGraph(GRAPH_NAME);
      state.mode = "falkordb-lite";
      state.url = `unix://${state.lite.socketPath}`;
      state.error = undefined;
      return true;
    }
    const mod = await import("falkordblite");
    const dir = `${process.cwd()}/.data/falkordb`;
    // Prefer the vendored portable Redis 8 (scripts/bootstrap-falkordb.sh);
    // fall back to any redis-server on PATH for machines that provide one.
    const { existsSync } = await import("fs");
    const vendored = `${process.cwd()}/.data/bin/r8/usr/bin/redis-server`;
    const opts: Record<string, unknown> = {
      path: dir,
      logLevel: "warning",
      timeout: 60_000,
    };
    if (existsSync(vendored)) opts.redisServerPath = vendored;
    const lite = await Promise.race([
      mod.FalkorDB.open(opts),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("lite boot timeout")), 65_000),
      ),
       
    ]) as any;
    // The engine is an EventEmitter: if its redis dies (OOM, manual kill,
    // machine sleep) an 'error' with no listener takes the whole server down.
    // Log it instead — ensureChecked() sees isRunning === false and re-boots.
    if (typeof lite.on === "function") {
      lite.on("error", (e: unknown) => {
        console.error("[falkordb-lite] engine error:", e instanceof Error ? e.message : e);
      });
    }
    state.lite = lite;
    state.client = lite;
    state.graph = lite.selectGraph(GRAPH_NAME);
    state.mode = "falkordb-lite";
    state.url = `unix://${lite.socketPath}`;
    state.error = undefined;
    return true;
  } catch (e) {
    state.error = `lite engine failed: ${e instanceof Error ? e.message : "unknown"}`;
    return false;
  }
}

async function boot(): Promise<void> {
  if (state.booting) return;
  state.booting = true;
  try {
    // already-healthy lite engine? verify it is still alive
    if (state.mode === "falkordb-lite" && state.lite?.isRunning) {
      state.checkedAt = Date.now();
      state.booting = false;
      return;
    }
    if (await tryRemote()) return;
    if (await tryLite()) return;
    state.mode = "embedded";
    state.client = null;
    state.graph = null;
    state.error ||= "no FalkorDB engine available — running on degraded compat store";
  } finally {
    state.checkedAt = Date.now();
    state.booting = false;
  }
}

async function ensureChecked(): Promise<void> {
  const stale = Date.now() - state.checkedAt > RECHECK_MS;
  if (!stale) return;
  if (state.mode === "embedded") await boot(); // degraded → retry the ladder
  else if (state.mode === "falkordb" && !(await remoteAliveQuick())) await boot();
  else if (state.mode === "falkordb-lite" && !state.lite?.isRunning) await boot();
  else state.checkedAt = Date.now();
}

async function remoteAliveQuick(): Promise<boolean> {
  try {
    await Promise.race([
      state.graph.query("RETURN 1"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 1500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function graphStatus(): Promise<{
  mode: GraphMode;
  url: string;
  graph: string;
  error?: string;
  label: string;
}> {
  await ensureChecked();
  const label =
    state.mode === "falkordb"
      ? "FALKORDB LIVE"
      : state.mode === "falkordb-lite"
        ? "FALKORDB LITE"
        : "DEGRADED";
  return { mode: state.mode, url: state.url, graph: GRAPH_NAME, error: state.error, label };
}

/* ----------------------------- queries ----------------------------- */

 
function normalize(res: any): unknown[] {
  const data = res?.data ?? [];
  if (!Array.isArray(data)) return [];
  return data.map((row: unknown) => {
    // positional single-column row
    if (Array.isArray(row) && row.length === 1) return row[0];
    // object row keyed by a single 'row' alias (client-dependent shape)
    if (
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      "row" in (row as Record<string, unknown>) &&
      Object.keys(row as Record<string, unknown>).length === 1
    )
      return (row as Record<string, unknown>).row;
    return row;
  });
}

/** Raw cypher against the live engine (internal use + composites). */
async function cypher(text: string, params: Params): Promise<unknown[]> {
  const res = await state.graph.query(text, { params: sanitizeParams(params) });
  return normalize(res);
}

/** The falkordb client throws on `undefined` param values (its stringifier
 *  has no undefined case), which used to demote the whole driver mid-call —
 *  drop undefined keys (and coerce undefined inside arrays/objects) first. */
function cleanParam(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v === undefined ? undefined : v;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : cleanParam(x)));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue;
    const c = cleanParam(val);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

function sanitizeParams(p: Params): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    const c = cleanParam(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const hasLiveEngine = () => state.mode !== "embedded" && !!state.graph;

function demote() {
  state.mode = "embedded";
  state.client = null;
  state.graph = null;
  state.checkedAt = 0; // re-attempt ladder promptly
}

/** Run a catalog op — FalkorDB first, degraded compat store as last resort. */
export async function graphRun<T = unknown>(
  op: string,
  params: Params = {},
): Promise<{ mode: GraphMode; data: T }> {
  const entry = CATALOG[op];
  if (!entry) throw new Error(`unknown graph op: ${op}`);
  await ensureChecked();

  if (hasLiveEngine()) {
    try {
      if (op === "ingestDocument") return { mode: state.mode, data: (await compositeIngest(params)) as T };
      if (op === "recordDecision") return { mode: state.mode, data: (await compositeDecision(params)) as T };
      if (op === "graphOverview") return { mode: state.mode, data: (await liveOverview()) as T };
      const { text, params: cyp } = entry.cypher(params);
      const rows = await cypher(text, cyp);
      // Ops whose embedded contract is a single object (or null for a miss),
      // not a row array — without this unwrap consumers read `.name` off an
      // array and render "undefined", and explore crashes the graph page.
      const data = SINGLE_ROW_OPS.has(op) ? (((rows[0] ?? null) as T)) : (rows as T);
      return { mode: state.mode, data };
    } catch (e) {
      state.error = `live engine error: ${e instanceof Error ? e.message : "unknown"} — degraded`;
      demote();
      // fall through to degraded store for this call
    }
  }
  const data = (await entry.embedded(params, embeddedStore)) as T;
  return { mode: "embedded", data };
}

/** CATALOG ops whose embedded impl returns one object, not an array. */
const SINGLE_ROW_OPS = new Set([
  "companyProfile",
  "putMemory",
  "putEpisode",
  "exploreNeighborhood",
]);

/* ---------- composite write ops (multi-statement on real engines) ---------- */

async function compositeIngest(p: Params): Promise<unknown> {
  await graphRun("upsertNode", {
    label: "Document",
    key: String(p.key),
    props: p,
  });
  const cos = (await graphRun<{ ticker?: unknown; name?: unknown }[]>(
    "allCompanies",
    {},
  )).data;
  const mentioned = computeMentions(`${p.title ?? ""} ${p.body ?? ""}`, cos);
  for (const ticker of mentioned) {
    await graphRun("link", {
      src: String(p.key),
      dst: `Company:${ticker}`,
      type: "MENTIONS",
    });
  }
  return { nodeKey: String(p.key), mentioned };
}

async function compositeDecision(p: Params): Promise<unknown> {
  const key = String(p.key);
  await graphRun("upsertNode", {
    label: "Decision",
    key,
    props: {
      title: p.title,
      rationale: p.rationale ?? "",
      date: p.date ?? new Date().toISOString().slice(0, 10),
      status: p.status ?? "active",
    },
  });
  const linked: string[] = [];
  if (p.title || p.rationale) {
    const cos = (await graphRun<{ ticker?: unknown; name?: unknown }[]>(
      "allCompanies",
      {},
    )).data;
    const mentions = computeMentions(`${p.title} ${p.rationale ?? ""}`, cos);
    for (const ticker of mentions) {
      await graphRun("link", { src: key, dst: `Company:${ticker}`, type: "MENTIONS" });
      linked.push(ticker);
    }
  }
  // provenance via primitives only — no raw cypher inside composites.
  // accept an array or a comma-separated string of document titles.
  const rawSources = p.sources;
  const sources = Array.isArray(rawSources)
    ? rawSources.map(String)
    : rawSources
      ? String(rawSources)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
  if (sources.length) {
    const docs = (await graphRun<{ key: string; name: string }[]>(
      "allByLabel",
      { label: "Document" },
    )).data;
    for (const s of sources) {
      const needle = String(s).toLowerCase();
      for (const d of docs) {
        if (String(d.name ?? "").toLowerCase().includes(needle)) {
          await graphRun("link", { src: key, dst: d.key, type: "DERIVED_FROM" });
        }
      }
    }
  }
  if (p.decidedBy) {
    const people = (await graphRun<{ key: string; name: string }[]>(
      "allByLabel",
      { label: "Person" },
    )).data;
    const needle = String(p.decidedBy).toLowerCase();
    const hit = people.find((per) => String(per.name ?? "").toLowerCase().includes(needle));
    if (hit) {
      await graphRun("link", { src: hit.key, dst: key, type: "DECIDED" });
    }
  }
  return { nodeKey: key, mentioned: linked };
}

/** graphOverview folded to the same shape the embedded store returns. */
async function liveOverview(): Promise<unknown> {
  // column-form returns only — map literals with aggregates are engine-fragile
  const labelRows = (await cypher(
    "MATCH (n) RETURN head(labels(n)) AS lab, count(n) AS cnt",
    {},
  )) as unknown[];
  const typeRows = (await cypher(
    "MATCH ()-[r]->() RETURN type(r) AS t, count(r) AS c",
    {},
  )) as unknown[];
  // rows may be objects keyed by alias OR positional arrays, engine-dependent
  const cell = (row: unknown, key: string, idx: number): unknown =>
    Array.isArray(row)
      ? row[idx]
      : (row as Record<string, unknown>)?.[key];
  const byLabel: Record<string, number> = {};
  let total = 0;
  for (const row of labelRows) {
    const c = Number(cell(row, "cnt", 1) ?? 0);
    byLabel[String(cell(row, "lab", 0))] = c;
    total += c;
  }
  const byType: Record<string, number> = {};
  let edgeTotal = 0;
  for (const row of typeRows) {
    const c = Number(cell(row, "c", 1) ?? 0);
    byType[String(cell(row, "t", 0))] = c;
    edgeTotal += c;
  }
  return { byLabel, byType, total, edgeTotal };
}

export function driverMode(): GraphMode {
  return state.mode;
}

/**
 * Force the boot ladder to re-run — called when the endpoint changes in
 * Settings. Without this a healthy (or merely reachable) engine keeps its
 * old connection forever and a newly saved URL is never dialed.
 */
export async function forceRecheck(nextUrl?: string): Promise<void> {
  const changed = nextUrl !== undefined && nextUrl !== state.url;
  if (!changed) {
    state.checkedAt = 0;
    return;
  }
  try {
    await state.lite?.close?.();
  } catch {
    /* best-effort teardown */
  }
  try {
    await state.client?.close?.();
  } catch {
    /* best-effort teardown */
  }
  state.client = null;
  state.graph = null;
  state.lite = null;
  state.mode = "embedded";
  state.checkedAt = 0;
  await boot();
}

/** Wipe the knowledge graph everywhere — live engine AND compat store. */
export async function graphWipe(): Promise<void> {
  const { graphEdges, graphNodes } = await import("@/db/schema");
  await db.delete(graphEdges);
  await db.delete(graphNodes);
  await ensureChecked();
  if (hasLiveEngine()) {
    try {
      await cypher("MATCH (n) DETACH DELETE n", {});
    } catch (e) {
      demote();
      state.error = e instanceof Error ? e.message : "wipe failed";
    }
  }
}
