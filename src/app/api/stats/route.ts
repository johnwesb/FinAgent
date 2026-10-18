import { db } from "@/db";
import { agents, chatMessages, chatSessions } from "@/db/schema";
import { sql } from "drizzle-orm";
import { ensureSeed } from "@/lib/seed";
import { graphRun, graphStatus } from "@/lib/graph";
import { ollamaUp, getOllamaBase } from "@/lib/llm";
import { marketStatus } from "@/lib/market";

export const dynamic = "force-dynamic";

const g = globalThis as typeof globalThis & {
  __marketCache?: { at: number; live: boolean; source?: string };
};

export async function GET() {
  await ensureSeed();
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(agents);
  const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(chatSessions);
  const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(chatMessages);
  const overview = await graphRun<{
    byLabel: Record<string, number>;
    total: number;
    edgeTotal: number;
  }>("graphOverview");
  const graph = await graphStatus();
  const ollama = await ollamaUp();
  const base = await getOllamaBase();
  if (!g.__marketCache || Date.now() - g.__marketCache.at > 20_000) {
    const ms = await marketStatus();
    g.__marketCache = { at: Date.now(), live: ms.live, source: ms.source };
  }
  return Response.json({
    agents: a?.n ?? 0,
    sessions: s?.n ?? 0,
    messages: m?.n ?? 0,
    graph: {
      mode: graph.mode,
      url: graph.url,
      error: graph.error,
      nodes: overview.data.total,
      edges: overview.data.edgeTotal,
      byLabel: overview.data.byLabel,
    },
    ollama: { up: ollama.up, models: ollama.models.length, base },
    market: { live: g.__marketCache.live, source: g.__marketCache.source },
  });
}
