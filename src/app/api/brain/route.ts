import { graphRun } from "@/lib/graph";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const org = await graphRun<unknown[]>("orgOverview", {});
  const decisions = await graphRun<unknown[]>("decisionsAbout", { q: "" });
  // Read through the graph driver — the compat tables are empty on live engines.
  const docs = await graphRun<{ props: Record<string, unknown> }[]>("allByLabel", {
    label: "Document",
  });
  const people = await graphRun<{ props: Record<string, unknown> }[]>("allByLabel", {
    label: "Person",
  });
  return Response.json({
    org: org.data,
    decisions: decisions.data,
    documents: docs.data.map((d) => d.props),
    people: people.data.map((p) => p.props),
  });
}

export async function POST(req: Request) {
  await ensureSeed();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = String(body.type ?? "");
  if (type === "document") {
    const title = String(body.title ?? "").trim();
    const bodyText = String(body.body ?? "");
    if (!title) return Response.json({ error: "title required" }, { status: 400 });
    const key = `Document:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
    const r = await graphRun("ingestDocument", {
      key,
      title,
      body: bodyText,
      date: new Date().toISOString().slice(0, 10),
    });
    return Response.json({ ok: true, result: r.data }, { status: 201 });
  }
  if (type === "decision") {
    const title = String(body.title ?? "").trim();
    if (!title) return Response.json({ error: "title required" }, { status: 400 });
    const key = `Decision:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
    // accept an array or a comma-separated string; never a raw string
    const raw = body.sources;
    const sources = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === "string" && raw.trim()
        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    const r = await graphRun("recordDecision", { key, ...body, sources });
    return Response.json({ ok: true, result: r.data }, { status: 201 });
  }
  if (type === "person") {
    const name = String(body.name ?? "").trim();
    const team = String(body.team ?? "");
    if (!name) return Response.json({ error: "name required" }, { status: 400 });
    await graphRun("upsertNode", {
      label: "Person",
      key: `Person:${name}`,
      props: { name, role: String(body.role ?? "Analyst") },
    });
    if (team) {
      await graphRun("link", {
        src: `Person:${name}`,
        dst: `Team:${team}`,
        type: "MEMBER_OF",
      });
    }
    return Response.json({ ok: true }, { status: 201 });
  }
  return Response.json({ error: "unknown type" }, { status: 400 });
}
