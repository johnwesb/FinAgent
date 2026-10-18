"use client";

import React, { useState } from "react";
import { Check, Copy, Database, RefreshCw, TerminalSquare } from "lucide-react";
import { api, usePoll } from "@/lib/client";
import { Chip, Panel, SectionHead } from "@/components/ui";

interface SettingsDTO {
  falkordb_url: string;
  falkor_status: { mode: string; url: string; graph: string; error?: string };
  ollama_base_url: string;
  env: { FALKORDB_URL: string | null; OLLAMA_BASE_URL: string | null };
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn"
      style={{ padding: "5px 9px" }}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check size={11} color="var(--acid)" /> : <Copy size={11} />}
    </button>
  );
}

function CodeLine({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-between gap-3 panel-inset px-3 py-2">
      <code className="mono text-[11px] break-all" style={{ color: "var(--acid)" }}>
        {children}
      </code>
      <CopyBtn text={children} />
    </div>
  );
}

export default function SettingsPage() {
  const settings = usePoll<SettingsDTO>(() => api("/api/settings"), 15000);
  const mcp = usePoll<{ tools: { name: string; description: string }[] }>(
    () => api("/api/mcp"),
    30000,
  );
  // null until the user edits — until then the saved endpoint renders.
  const [url, setUrl] = useState<string | null>(null);
  const endpoint = url ?? settings.data?.falkordb_url ?? "";
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  async function save() {
    setErr(null);
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ falkordb_url: endpoint }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      settings.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    }
  }

  async function admin(mode: "reseed" | "wipe") {
    if (!window.confirm(mode === "reseed" ? "Rebuild the whole desk (agents + graph + brain)?" : "Purge everything?")) return;
    await api("/api/admin", { method: "POST", body: JSON.stringify({ mode }) });
    setAdminMsg(mode === "reseed" ? "Desk re-seeded." : "Everything purged.");
    setTimeout(() => window.location.reload(), 700);
  }

  const status = settings.data?.falkor_status;

  return (
    <div className="px-5 lg:px-8 py-7 max-w-[1050px] mx-auto">
      <div className="eyebrow mb-3">Infrastructure</div>
      <h1 className="bigtype" style={{ fontSize: "clamp(34px, 4.5vw, 60px)" }}>
        System <span className="clip-acid">Plane</span>
      </h1>

      {/* falkordb */}
      <Panel corners className="mt-7">
        <SectionHead
          k="The mind of the desk"
          title="FalkorDB graph runtime"
          right={
            <Chip
              tone={
                status?.mode === "falkordb" || status?.mode === "falkordb-lite"
                  ? "acid"
                  : "red"
              }
            >
              {status?.mode === "falkordb"
                ? "LIVE · cypher on server"
                : status?.mode === "falkordb-lite"
                  ? "LITE · embedded engine"
                  : "DEGRADED · needs attention"}
            </Chip>
          }
        />
        <p className="text-[13px] leading-relaxed mb-4" style={{ color: "var(--dim)" }}>
          FalkorDB is not optional here — it is the mind. Every company,
          relationship, quote, memory and decision executes as Cypher on a real
          FalkorDB engine. Boot ladder: <b>configured server</b> (below) →{" "}
          <b>auto-booted embedded FalkorDB engine</b> (FalkorDBLite, persisted
          to <code className="mono" style={{ color: "var(--acid)" }}>.data/falkordb</code>) →
          degraded Postgres compat store with loud labels. For a shared or
          production desk, point it at a server:
        </p>
        <div className="flex flex-col gap-2 mb-4">
          <CodeLine>docker run -p 6379:6379 -it --rm falkordb/falkordb:latest</CodeLine>
          <CodeLine>redis://localhost:6379</CodeLine>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            className="input"
            style={{ flex: "1 1 300px" }}
            value={endpoint}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="redis://localhost:6379"
          />
          <button className="btn btn-acid" onClick={save}>
            {saved ? <Check size={12} /> : <Database size={12} />} {saved ? "Saved" : "Save endpoint"}
          </button>
          <button className="btn" onClick={() => settings.refresh()}>
            <RefreshCw size={12} /> Re-probe
          </button>
        </div>
        {err && <div className="mono text-[10px] mt-2" style={{ color: "var(--red)" }}>{err}</div>}
        <div className="mono text-[10px] mt-3" style={{ color: "var(--faint)" }}>
          graph name: {status?.graph ?? "finq"} · engine endpoint: {status?.url ?? "…"}
          {status?.error ? ` · ${status.error}` : ""}
          {settings.data?.env.FALKORDB_URL ? " · env override present" : ""}
        </div>
      </Panel>

      {/* mcp */}
      <Panel className="mt-4">
        <SectionHead
          k="Tool plane"
          title="MCP endpoint"
          right={<Chip tone="violet">{mcp.data?.tools.length ?? 0} tools</Chip>}
        />
        <p className="text-[13px] leading-relaxed mb-4" style={{ color: "var(--dim)" }}>
          Agents select tools through the Model Context Protocol. External MCP
          clients can attach to the same endpoint (JSON-RPC over HTTP,
          per-tenant via the <code className="mono" style={{ color: "var(--acid)" }}>x-tenant</code> header):
        </p>
        <div className="flex flex-col gap-2 mb-4">
          <CodeLine>{`${typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"}/api/mcp`}</CodeLine>
          <CodeLine>{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"graph_risk_paths","arguments":{"ticker":"TSM"}}}`}</CodeLine>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {(mcp.data?.tools ?? []).map((t) => (
            <div key={t.name} className="panel-inset px-3 py-2">
              <div className="mono text-[11px] font-bold" style={{ color: "var(--acid)" }}>{t.name}</div>
              <div className="text-[11.5px] mt-1 leading-snug" style={{ color: "var(--dim)" }}>{t.description}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* cli */}
      <Panel className="mt-4">
        <SectionHead
          k="Terminal"
          title="finq CLI"
          right={<span className="eyebrow flex items-center gap-2"><TerminalSquare size={11} /> zero deps</span>}
        />
        <div className="flex flex-col gap-2">
          <CodeLine>node cli/finq.js status</CodeLine>
          <CodeLine>{`node cli/finq.js ask "If TSMC blows up, who gets hurt?"`}</CodeLine>
          <CodeLine>node cli/finq.js quote AAPL NVDA TSM</CodeLine>
          <CodeLine>node cli/finq.js memory --kind procedural</CodeLine>
          <CodeLine>{`node cli/finq.js mcp-call graph_peers '{"ticker":"AAPL"}'`}</CodeLine>
        </div>
      </Panel>

      {/* danger */}
      <Panel className="mt-4 mb-10" corners>
        <SectionHead k="Danger zone" title="Desk reset" />
        <div className="flex flex-wrap gap-3 items-center">
          <button className="btn btn-danger" onClick={() => admin("reseed")}>Burn & reseed desk</button>
          <button className="btn btn-danger" onClick={() => admin("wipe")}>Purge everything</button>
          {adminMsg && <span className="mono text-[10px] uppercase tracking-[0.15em]" style={{ color: "var(--acid)" }}>{adminMsg}</span>}
        </div>
      </Panel>
    </div>
  );
}
