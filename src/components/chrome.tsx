"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  BrainCircuit,
  LayoutDashboard,
  LineChart,
  MemoryStick,
  Share2,
  Settings,
  SquareTerminal,
  Users,
} from "lucide-react";
import { api, usePoll, type QuoteDTO, type StatsDTO } from "@/lib/client";
import { fmtMoney } from "@/lib/money";

const NAV = [
  { href: "/", label: "Console", icon: LayoutDashboard },
  { href: "/brain", label: "Brain", icon: BrainCircuit },
  { href: "/graph", label: "Graph", icon: Share2 },
  { href: "/memory", label: "Memory", icon: MemoryStick },
  { href: "/agents", label: "Agents", icon: Users },
  { href: "/setup", label: "Guide", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Clock() {
  const [now, setNow] = useState("--:--:--");
  useEffect(() => {
    const f = () =>
      setNow(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    f();
    const t = setInterval(f, 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="mono text-[11px] tracking-[0.15em]">{now}</span>;
}

function QuoteTicker() {
  // mirrors the graph universe: every Company node gets a tape entry, and
  // new ingests appear on the next poll (graph → tape stays in sync).
  const { data } = usePoll<{ quotes: QuoteDTO[] }>(
    () => api("/api/quotes?tickers=graph"),
    15_000,
  );
  const quotes = data?.quotes ?? [];
  if (quotes.length === 0) {
    return (
      <span className="mono text-[10px] tracking-[0.18em] uppercase" style={{ color: "var(--faint)" }}>
        FINQ//DESK — ask the desk anything; every answer traces to the graph
      </span>
    );
  }
  return (
    <div className="ticker flex-1 min-w-0">
      <span className="ticker-inner mono text-[10px] tracking-[0.08em]" style={{ color: "var(--dim)" }}>
        {quotes.map((q, i) => (
          <React.Fragment key={q.ticker}>
            {i > 0 && <span style={{ color: "var(--faint)" }}>{"   ///   "}</span>}
            <span title={`${q.name || q.ticker} · ${fmtMoney(q.price, q.currency)} · ${q.source}`}>
              {q.ticker} {fmtMoney(q.price, q.currency)} {q.changePct >= 0 ? "▲" : "▼"}
              {Math.abs(q.changePct).toFixed(2)}%
            </span>
          </React.Fragment>
        ))}
      </span>
    </div>
  );
}

function StatusBar() {
  const { data } = usePoll<StatsDTO>(() => api("/api/stats"), 6000);
  const g = data?.graph;
  return (
    <div
      className="flex items-center gap-4 h-9 px-4 border-b mono text-[9.5px] tracking-[0.16em] uppercase"
      style={{ borderColor: "var(--line)", color: "var(--dim)", background: "rgba(0,0,0,0.35)" }}
    >
      <span className="flex items-center gap-2 flex-none">
        <span
          className={`sdot ${
            g?.mode === "falkordb" || g?.mode === "falkordb-lite" ? "ok" : "bad"
          }`}
        />
        <span className="hidden sm:inline">FALKORDB</span>
        <span
          style={{
            color:
              g?.mode === "falkordb" || g?.mode === "falkordb-lite"
                ? "var(--acid)"
                : "var(--red)",
          }}
        >
          {g?.mode === "falkordb"
            ? "LIVE"
            : g?.mode === "falkordb-lite"
              ? "LITE"
              : "DEGRADED"}
        </span>
      </span>
      <span className="hidden md:flex items-center gap-2 flex-none">
        <LineChart size={11} strokeWidth={1.5} />
        GRAPH{" "}
        <span style={{ color: "var(--acid)" }}>
          {g ? `${g.nodes}N·${g.edges}E` : "…"}
        </span>
      </span>
      <span className="hidden lg:flex items-center gap-2 flex-none">
        <span className={`sdot ${data?.market.live ? "ok" : "warn"}`} />
        STX {data?.market.live ? "DELAYED" : "SIM"}
      </span>
      <span className="hidden lg:flex items-center gap-2 flex-none">
        <span className={`sdot ${data?.ollama.up ? "ok" : "bad"}`} />
        LLM {data?.ollama.up ? `${data.ollama.models}` : "OFF"}
      </span>
      <span className="hidden xl:flex items-center gap-2 flex-none" style={{ color: "var(--faint)" }}>
        <SquareTerminal size={11} strokeWidth={1.5} />
        MCP /api/mcp
      </span>
      <div className="flex-1 min-w-6 flex items-center min-w-0">
        <QuoteTicker />
      </div>
      <span className="flex-none" style={{ color: "var(--faint)" }}>
        <Clock />
      </span>
    </div>
  );
}

export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="relative z-[1] flex h-screen overflow-hidden">
      <aside
        className="flex-none w-[64px] lg:w-[218px] flex flex-col border-r"
        style={{ borderColor: "var(--line)", background: "rgba(5,6,8,0.85)" }}
      >
        <Link
          href="/"
          className="flex items-center gap-3 px-4 lg:px-5 h-[64px] border-b no-underline"
          style={{ borderColor: "var(--line)" }}
        >
          <span className="relative flex-none">
            <Share2 size={24} strokeWidth={1.4} color="var(--acid)" />
          </span>
          <span className="sidebar-label hidden lg:block">
            <span className="block font-extrabold tracking-[-0.02em] text-[15px] leading-none">
              FINQ<span style={{ color: "var(--acid)" }}>{"//"}</span>DESK
            </span>
            <span className="block mono text-[8px] tracking-[0.28em] mt-1" style={{ color: "var(--faint)" }}>
              GRAPH FINANCE OS
            </span>
          </span>
        </Link>

        <nav className="flex-1 py-4 flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} className={`navlink ${active ? "active" : ""}`}>
                <Icon size={15} strokeWidth={1.6} className="flex-none" />
                <span className="sidebar-label hidden lg:block">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t hidden lg:block" style={{ borderColor: "var(--line)" }}>
          <div className="eyebrow mb-2">Mandate</div>
          <p className="mono text-[10px] leading-relaxed" style={{ color: "var(--dim)" }}>
            Real-time data + connected memory in one graph. Answers with sources, decisions with provenance.
          </p>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <StatusBar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
