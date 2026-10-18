"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Database,
  Plus,
  SendHorizonal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, fmtClock, useLocalState, usePoll, type EventDTO, type MessageDTO, type SessionDTO, type StatsDTO } from "@/lib/client";
import { Empty, Panel } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { AGENT_ICONS, EVENT_KIND_COLORS } from "@/lib/meta";

const SUGGESTED = [
  "What is NVDA trading at? Give me the 60-session trend too.",
  "If TSMC blows up, who gets hurt? Map the contagion.",
  "Walk me through Apple's supply chain.",
  "Why did we decide to overweight NVDA?",
  "Who owns the AI Capex Tracker?",
  "Compare MSFT vs GOOGL — quotes and rivalry context.",
  "Which companies are most connected on the graph?",
  "Remember that our Nvidia stop-loss is 8% below cost basis.",
];

/** poll returns a fresh array each tick — keep the old reference when
 *  nothing actually changed so dependent effects don't re-fire. */
function sameMessages(a: MessageDTO[], b: MessageDTO[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (m, i) => m.id === b[i].id && m.role === b[i].role && m.content === b[i].content,
  );
}

export default function ConsolePage() {
  const [tenant, setTenant] = useLocalState("finq-tenant", "desk-1");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<{ runId: string; events: EventDTO[] } | null>(null);
  const afterRef = useRef(0);
  const streamRef = useRef<HTMLDivElement>(null);
  /** auto-follow only while the user is parked near the bottom */
  const stickRef = useRef(true);
  const [error, setError] = useState<string | null>(null);

  const setTenantPersist = (t: string) => {
    setTenant(t);
    setSessionId(null);
    setMessages([]);
  };

  const sessions = usePoll<{ sessions: SessionDTO[] }>(
    () => api(`/api/chat?tenant=${encodeURIComponent(tenant)}`),
    4000,
    [tenant],
  );
  const stats = usePoll<StatsDTO>(() => api("/api/stats"), 8000);

  // load messages for session
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const load = async () => {
      try {
        const d = await api<{ messages: MessageDTO[] }>(`/api/chat/${sessionId}`);
        if (alive) setMessages((prev) => (sameMessages(prev, d.messages) ? prev : d.messages));
      } catch {
        /* transient */
      }
    };
    load();
    const t = setInterval(load, pending ? 1400 : 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId, pending]);

  // stream engine telemetry
  useEffect(() => {
    if (!pending || !sessionId) return;
    let alive = true;
    afterRef.current = 0;
    const load = async () => {
      try {
        const d = await api<{ events: EventDTO[] }>(
          `/api/chat/${sessionId}/events?runId=${pending.runId}&after=${afterRef.current}`,
        );
        if (!alive || d.events.length === 0) {
          if (pending.events.length === 0) setPending((p) => (p ? { ...p } : p));
          return;
        }
        afterRef.current = d.events[d.events.length - 1].id;
        setPending((p) =>
          p ? { ...p, events: [...p.events, ...d.events] } : p,
        );
        const done = d.events.some((e) => e.kind === "answer" || e.kind === "error");
        if (done) {
          setTimeout(() => {
            setPending(null);
            sessions.refresh();
          }, 600);
        }
      } catch {
        /* transient */
      }
    };
    load();
    const t = setInterval(load, 850);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.runId, sessionId]);

  // track stick-to-bottom: scrolling up pauses auto-follow so history
  // stays readable; scrolling back to the tail resumes it. A new session
  // always starts pinned to the latest message.
  useEffect(() => {
    stickRef.current = true;
    const el = streamRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [sessionId]);

  // autoscroll — only while the user is parked at the bottom
  useEffect(() => {
    const el = streamRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending?.events?.length]);

  async function send(text?: string) {
    const question = (text ?? input).trim();
    if (!question || pending) return;
    stickRef.current = true; // sending always jumps to the live tail
    setError(null);
    setInput("");
    try {
      const r = await api<{ runId: string; sessionId: number }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ question, tenant, sessionId: sessionId ?? undefined }),
      });
      if (!sessionId) setSessionId(r.sessionId);
      setMessages((m) => [
        ...m,
        {
          id: -Date.now(),
          role: "user",
          content: question,
          runId: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      setPending({ runId: r.runId, events: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
    }
  }

  const thread = messages;
  const showHero = thread.length === 0 && !pending;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 px-4 lg:px-6 py-4 h-[calc(100vh-36px)]">
      {/* ---------- sessions rail ---------- */}
      <div className="hidden xl:flex xl:col-span-2 flex-col min-h-0">
        <Panel pad={false} className="flex flex-col h-full min-h-0">
          <div className="p-3 border-b" style={{ borderColor: "var(--line)" }}>
            <div className="eyebrow mb-2">Tenant</div>
            <input
              className="input mono text-[11px] py-2"
              value={tenant}
              onChange={(e) => setTenantPersist(e.target.value || "desk-1")}
            />
            <button
              className="btn btn-acid w-full justify-center mt-2"
              style={{ padding: "8px 10px" }}
              onClick={() => {
                setSessionId(null);
                setMessages([]);
              }}
            >
              <Plus size={11} /> New thread
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {(sessions.data?.sessions ?? []).map((s) => (
              <button
                key={s.id}
                onClick={() => setSessionId(s.id)}
                className="w-full text-left px-3 py-2.5 border-b bg-transparent border-0 cursor-pointer hover:bg-white/[0.03]"
                style={{
                  borderColor: "rgba(255,255,255,0.05)",
                  borderLeft: sessionId === s.id ? "2px solid var(--acid)" : "2px solid transparent",
                }}
              >
                <div className="text-[12px] truncate" style={{ color: sessionId === s.id ? "var(--txt)" : "var(--dim)" }}>
                  {s.title}
                </div>
                <div className="mono text-[9px] mt-1 uppercase tracking-[0.1em]" style={{ color: "var(--faint)" }}>
                  #{s.id}
                </div>
              </button>
            ))}
            {(sessions.data?.sessions ?? []).length === 0 && (
              <Empty>No threads yet</Empty>
            )}
          </div>
        </Panel>
      </div>

      {/* ---------- chat stream ---------- */}
      <div className="xl:col-span-7 flex flex-col min-h-0">
        <Panel pad={false} corners className="flex flex-col flex-1 min-h-0">
          <div ref={streamRef} className="flex-1 overflow-y-auto p-5">
            {showHero && (
              <div className="pt-6">
                <div className="eyebrow mb-4 flex items-center gap-2">
                  <Sparkles size={11} color="var(--acid)" />
                  LangGraph desk · MCP tools · FalkorDB memory plane
                </div>
                <h1 className="bigtype" style={{ fontSize: "clamp(36px, 4.6vw, 64px)" }}>
                  <span className="clip-ghost block">Ask the</span>
                  <span className="clip-acid glow-acid block">Whole Desk</span>
                </h1>
                <p className="mono text-[10.5px] uppercase tracking-[0.14em] leading-relaxed mt-4 max-w-[560px]" style={{ color: "var(--dim)" }}>
                  Real-time quotes, multi-hop graph traversals, decision provenance
                  and cross-session memory — one question, six agents, every
                  claim sourced.
                </p>
                <div className="flex flex-wrap gap-2 mt-6">
                  {SUGGESTED.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="chip cursor-pointer hover:border-[var(--acid)] hover:text-[var(--acid)] transition-colors"
                      style={{ background: "none", padding: "7px 11px", fontSize: 10 }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {thread.map((m) => (
              <div key={m.id} className={`mb-5 ${m.role === "user" ? "flex justify-end" : ""}`}>
                {m.role === "user" ? (
                  <div
                    className="max-w-[80%] px-4 py-3 text-[13.5px] leading-relaxed"
                    style={{
                      background: "rgba(198,255,74,0.08)",
                      border: "1px solid rgba(198,255,74,0.25)",
                      color: "var(--txt)",
                    }}
                  >
                    {m.content}
                  </div>
                ) : (
                  <div className="max-w-[92%]">
                    <div className="eyebrow mb-2 flex items-center gap-2">
                      <span className="sdot ok" style={{ width: 5, height: 5 }} />
                      DESK ANSWER
                    </div>
                    <div className="panel-inset p-4">
                      <Markdown text={m.content} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* live engine trace */}
            {pending && (
              <div className="max-w-[92%]">
                <div className="eyebrow mb-2 flex items-center gap-2">
                  <span className="spinner" style={{ width: 9, height: 9 }} />
                  DESK WORKING — LIVE TRACE
                </div>
                <div className="terminal p-3" style={{ maxHeight: 240 }}>
                  {pending.events.length === 0 && (
                    <span className="mono text-[10.5px]" style={{ color: "var(--faint)" }}>
                      waking the desk…
                    </span>
                  )}
                  {pending.events.map((e) => (
                    <div key={e.id} className="logline flex gap-3 py-[1px]">
                      <span className="flex-none" style={{ color: "var(--faint)" }}>
                        {fmtClock(e.createdAt)}
                      </span>
                      <span
                        className="flex-none w-[104px] truncate mono text-[10px]"
                        style={{ color: AGENT_ICONS[e.agent] ?? "#8b939e" }}
                      >
                        {e.agent}
                      </span>
                      <span
                        className="flex-none w-[52px] uppercase mono text-[9px] pt-[2px]"
                        style={{ color: EVENT_KIND_COLORS[e.kind] ?? "#8b939e" }}
                      >
                        {e.kind}
                      </span>
                      <span className="flex-1 mono text-[10.5px]" style={{ color: "#aeb6bf" }}>
                        {e.content}
                      </span>
                    </div>
                  ))}
                  <span className="cursorbar ml-1" />
                </div>
              </div>
            )}
          </div>

          {/* composer */}
          <div className="border-t p-4" style={{ borderColor: "var(--line)" }}>
            {error && (
              <div className="mono text-[10px] mb-2" style={{ color: "var(--red)" }}>
                {error}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                className="textarea flex-1"
                rows={2}
                placeholder='Ask for quotes, supply chains, contagion maps, decisions, ownership… or "remember that …"'
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button
                className="btn btn-acid"
                onClick={() => send()}
                disabled={!!pending || input.trim().length < 2}
              >
                {pending ? <span className="spinner" /> : <SendHorizonal size={12} strokeWidth={2} />}
                Ask
              </button>
            </div>
          </div>
        </Panel>
      </div>

      {/* ---------- inspector ---------- */}
      <div className="hidden xl:flex xl:col-span-3 flex-col gap-4 min-h-0 overflow-y-auto">
        <Panel corners>
          <div className="eyebrow mb-3 flex items-center gap-2">
            <Database size={11} color="var(--acid)" /> Desk status
          </div>
          <div className="flex flex-col gap-2 mono text-[10.5px]">
              {(
                [
                  [
                    "Graph mind",
                    stats.data?.graph.mode === "falkordb"
                      ? "FALKORDB LIVE"
                      : stats.data?.graph.mode === "falkordb-lite"
                        ? "FALKORDB LITE"
                        : "DEGRADED",
                    stats.data?.graph.mode === "embedded" ? "var(--red)" : "var(--acid)",
                  ],
                ["Graph size", stats.data ? `${stats.data.graph.nodes} nodes · ${stats.data.graph.edges} edges` : "…", "var(--txt)"],
                ["Market feed", stats.data?.market.live ? (stats.data?.market.source === "yahoo-delayed" ? "yahoo delayed" : "stooq delayed") : "simulated", stats.data?.market.live ? "var(--cyan)" : "var(--amber)"],
                ["LLM router", stats.data?.ollama.up ? `online · ${stats.data.ollama.models} models` : "offline · policy router", stats.data?.ollama.up ? "var(--acid)" : "var(--dim)"],
                ["Threads", String(stats.data?.sessions ?? "—"), "var(--txt)"],
                ["Messages", String(stats.data?.messages ?? "—"), "var(--txt)"],
              ] as const
            ).map(([k, v, c]) => (
              <div key={k} className="flex justify-between gap-2">
                <span style={{ color: "var(--faint)" }}>{k}</span>
                <span style={{ color: c }}>{v}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <div className="eyebrow mb-3">Agents on shift</div>
          <AgentStrip />
        </Panel>

        <Panel className="flex-1">
          <div className="eyebrow mb-3">Tracks covered</div>
          <div className="flex flex-col gap-3 mono text-[10px] leading-relaxed" style={{ color: "var(--dim)" }}>
            <div>
              <span className="chip chip-acid mb-1">T1 · Connected action</span>
              <p>Multi-hop contagion, supply webs, centrality — agents act on what the graph shows, with readable chains.</p>
            </div>
            <div>
              <span className="chip chip-cyan mb-1">T2 · Memory</span>
              <p>Episodic turns, semantic facts, procedures. Per-tenant, recalled before every answer.</p>
            </div>
            <div>
              <span className="chip chip-amber mb-1">T3 · Company brain</span>
              <p>People, teams, projects, docs, decisions — every answer with sources and provenance.</p>
            </div>
          </div>
          <Link href="/brain" className="btn mt-4 w-full justify-center" style={{ padding: "8px" }}>
            Open the brain <ArrowUpRight size={11} />
          </Link>
        </Panel>
      </div>
    </div>
  );
}

function AgentStrip() {
  const agents = usePoll<{ agents: { name: string; callsign: string; color: string; runs: number }[] }>(
    () => api("/api/agents"),
    10000,
  );
  return (
    <div className="grid grid-cols-3 gap-2">
      {(agents.data?.agents ?? []).map((a) => (
        <div
          key={a.name}
          className="panel-inset p-2 text-center"
          title={`${a.name} · ${a.runs} runs`}
        >
          <div
            className="mono text-[9px] font-bold mx-auto w-[26px] h-[26px] flex items-center justify-center border mb-1"
            style={{ color: a.color, borderColor: a.color, background: `${a.color}10` }}
          >
            {a.callsign}
          </div>
          <div className="mono text-[8px] uppercase tracking-[0.1em]" style={{ color: "var(--faint)" }}>
            {a.runs} runs
          </div>
        </div>
      ))}
    </div>
  );
}
