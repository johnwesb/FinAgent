import { graphRun } from "@/lib/graph";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenant = url.searchParams.get("tenant") || "desk-1";
  const kind = url.searchParams.get("kind") || undefined;
  const memory = await graphRun("listMemory", { tenant, kind });
  const episodic = await graphRun("recallEpisodes", { tenant, q: "" });
  return Response.json({ memory: memory.data, episodic: episodic.data });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    tenant?: string;
    kind?: string;
    text?: string;
    topic?: string;
  };
  const tenant = body.tenant || "desk-1";
  const text = String(body.text ?? "").trim();
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  const kind = body.kind === "procedural" ? "procedural" : "semantic";
  const key = `Memory:${tenant}:${Buffer.from(text).toString("base64url").slice(0, 40)}`;
  const r = await graphRun("putMemory", {
    key,
    tenant,
    kind,
    text,
    topic: body.topic ?? "",
    ts: Date.now(),
  });
  return Response.json({ ok: true, result: r.data }, { status: 201 });
}
