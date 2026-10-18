import { db } from "@/db";
import { chatMessages, chatSessions, events } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { ensureSeed } from "@/lib/seed";
import { runEngine, saveAssistant } from "@/lib/engine";
import { graphRun } from "@/lib/graph";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureSeed();
  const tenant = new URL(req.url).searchParams.get("tenant") || "desk-1";
  const sessions = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.tenant, tenant))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(40);
  return Response.json({ sessions });
}

export async function POST(req: Request) {
  await ensureSeed();
  const body = (await req.json().catch(() => ({}))) as {
    question?: string;
    tenant?: string;
    sessionId?: number;
  };
  const question = String(body.question ?? "").trim();
  const tenant = String(body.tenant ?? "desk-1");
  if (question.length < 2) {
    return Response.json({ error: "ask something real" }, { status: 400 });
  }

  let sessionId = Number(body.sessionId) || 0;
  if (!sessionId) {
    const [s] = await db
      .insert(chatSessions)
      .values({
        tenant,
        title: question.replace(/\s+/g, " ").slice(0, 60),
      })
      .returning();
    sessionId = s.id;
  } else {
    await db
      .update(chatSessions)
      .set({ updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));
  }

  await db.insert(chatMessages).values({ sessionId, role: "user", content: question });

  const runId = crypto.randomUUID();
  // Track 2: persist the user turn as an episodic graph node
  await graphRun("putEpisode", {
    key: `Episode:${runId}:u`,
    tenant,
    sessionId,
    role: "user",
    content: question.slice(0, 1500),
    ts: Date.now(),
  });

  // fire-and-forget; UI streams telemetry via /api/chat/[id]/events?runId=
  void (async () => {
    try {
      const { answer } = await runEngine({ question, tenant, sessionId, runId });
      await saveAssistant(sessionId, runId, answer, []);
    } catch (e) {
      await db.insert(events).values({
        runId,
        sessionId,
        agent: "ORCHESTRA",
        kind: "error",
        content: `engine fault: ${e instanceof Error ? e.message : "unknown"}`,
      });
      await saveAssistant(
        sessionId,
        runId,
        `### Engine fault\n${e instanceof Error ? e.message : "unknown error"} — the desk hit a snag. Try again.`,
        [],
      );
    }
  })();

  return Response.json({ runId, sessionId }, { status: 202 });
}
