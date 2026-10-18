import { db } from "@/db";
import { settings } from "@/db/schema";
import { forceRecheck, getFalkorUrl, graphStatus } from "@/lib/graph";
import { getOllamaBase } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function GET() {
  const falkor = await getFalkorUrl();
  const status = await graphStatus();
  return Response.json({
    falkordb_url: falkor,
    falkor_status: status,
    ollama_base_url: await getOllamaBase(),
    env: {
      FALKORDB_URL: process.env.FALKORDB_URL ?? null,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? null,
    },
  });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { falkordb_url?: string };
  const url = String(body.falkordb_url ?? "").trim();
  if (!url.startsWith("redis://") && !url.startsWith("rediss://") && !url.startsWith("falkor://")) {
    return Response.json(
      { error: "must be a redis:// (or rediss://) FalkorDB endpoint" },
      { status: 400 },
    );
  }
  await db
    .insert(settings)
    .values({ key: "falkordb_url", value: url })
    .onConflictDoUpdate({ target: settings.key, set: { value: url } });
  // re-run the boot ladder against the saved endpoint
  await forceRecheck(url);
  return Response.json({ ok: true, falkordb_url: url });
}
