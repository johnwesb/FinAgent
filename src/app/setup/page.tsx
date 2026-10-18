"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Check,
  CircleDashed,
  Copy,
  Map,
  BookOpen,
} from "lucide-react";
import { api, usePoll, type StatsDTO } from "@/lib/client";
import { Chip, Panel, SectionHead } from "@/components/ui";

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn flex-none"
      style={{ padding: "5px 9px" }}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      title="Copy"
    >
      {done ? <Check size={11} color="var(--acid)" /> : <Copy size={11} />}
    </button>
  );
}

function Code({ children, copy }: { children: string; copy?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 panel-inset px-3 py-2 my-1.5">
      <pre className="mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all m-0" style={{ color: "#b9e99a" }}>
        {children}
      </pre>
      <CopyBtn text={copy ?? children} />
    </div>
  );
}

function Step({
  n,
  title,
  optional,
  children,
}: {
  n: string;
  title: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Panel className="relative">
      <div className="flex items-center gap-3 mb-3">
        <span
          className="mono text-[11px] font-bold w-[34px] h-[34px] flex items-center justify-center border flex-none"
          style={{ color: "var(--acid)", borderColor: "rgba(198,255,74,0.4)", background: "rgba(198,255,74,0.06)" }}
        >
          {n}
        </span>
        <h3 className="font-bold text-[15px] uppercase tracking-tight">{title}</h3>
        {optional && <Chip tone="amber">optional · live mode</Chip>}
      </div>
      <div className="text-[13px] leading-relaxed" style={{ color: "var(--dim)" }}>
        {children}
      </div>
    </Panel>
  );
}

function Checklist() {
  const stats = usePoll<StatsDTO>(() => api("/api/stats"), 6000);
  const items: { label: string; ok: boolean | null; detail: string }[] = stats.data
    ? [
        { label: "App server + database", ok: true, detail: "responding" },
        {
          label: "Desk seeded",
          ok: stats.data.agents >= 6 && stats.data.graph.nodes > 0,
          detail: `${stats.data.agents} agents · ${stats.data.graph.nodes} nodes · ${stats.data.graph.edges} edges`,
        },
        {
          label: "FalkorDB live mode",
          ok: stats.data.graph.mode === "falkordb" ? true : null,
          detail:
            stats.data.graph.mode === "falkordb"
              ? `cypher on server @ ${stats.data.graph.url}`
              : `embedded compat · start the container to upgrade`,
        },
        {
          label: "LLM router (Ollama)",
          ok: stats.data.ollama.up ? true : null,
          detail: stats.data.ollama.up
            ? `${stats.data.ollama.models} models — routing + prose are model-generated`
            : "policy router engaged — install Ollama to upgrade",
        },
        {
          label: "Real-time market feed",
          ok: stats.data.market.live ? true : null,
          detail: stats.data.market.live
            ? `${stats.data.market.source === "yahoo-delayed" ? "yahoo finance" : "stooq"} delayed quotes`
            : "simulated feed (network blocked)",
        },
      ]
    : [{ label: "Probing…", ok: null, detail: "" }];

  return (
    <Panel corners>
      <SectionHead k="Live verification" title="System checklist" />
      <div className="flex flex-col gap-2">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-3 panel-inset px-3 py-2.5">
            {it.ok === true ? (
              <Check size={13} color="var(--acid)" className="flex-none" />
            ) : (
              <CircleDashed size={13} color="var(--amber)" className="flex-none" />
            )}
            <span className="text-[13px] font-semibold flex-none" style={{ color: it.ok ? "var(--txt)" : "var(--dim)" }}>
              {it.label}
            </span>
            <span className="mono text-[10px] ml-auto text-right" style={{ color: "var(--faint)" }}>
              {it.detail}
            </span>
          </div>
        ))}
      </div>
      <p className="mono text-[9.5px] mt-3" style={{ color: "var(--faint)" }}>
        Green = verified · amber = running in a labeled fallback. Fallbacks are production-grade;
        upgrades are one command each below.
      </p>
    </Panel>
  );
}

export default function SetupPage() {
  return (
    <div className="px-5 lg:px-8 py-7 max-w-[1100px] mx-auto pb-12">
      <div className="eyebrow mb-3 flex items-center gap-2">
        <BookOpen size={11} color="var(--acid)" /> Zero to verified desk · ~10 minutes
      </div>
      <h1 className="bigtype" style={{ fontSize: "clamp(34px, 4.5vw, 60px)" }}>
        Setup <span className="clip-acid">Guide</span>
      </h1>

      <div className="mt-6">
        <Checklist />
      </div>

      <div className="flex flex-col gap-4 mt-4">
        <Step n="01" title="Prerequisites">
          <p>Node.js ≥ 20.9 + npm. Docker is the easiest path for PostgreSQL and FalkorDB (native installs work too).</p>
          <Code>node -v && npm -v</Code>
        </Step>

        <Step n="02" title="Install dependencies">
          <Code>npm install</Code>
        </Step>

        <Step n="03" title="Provide PostgreSQL">
          <p>Any PostgreSQL ≥ 14. Quickest with Docker:</p>
          <Code>{`docker run -d --name finq-pg \\\n  -e POSTGRES_PASSWORD=postgres \\\n  -e POSTGRES_DB=app_db \\\n  -p 5432:5432 postgres:16`}</Code>
        </Step>

        <Step n="04" title="Configure .env">
          <p>Create <code className="mono" style={{ color: "var(--acid)" }}>.env</code> in the project root (these are also the built-in defaults):</p>
          <Code>{`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db\nFALKORDB_URL=redis://localhost:6379\nOLLAMA_BASE_URL=http://localhost:11434`}</Code>
        </Step>

        <Step n="05" title="Create the schema">
          <Code>npx drizzle-kit push</Code>
          <p className="mt-2">
            Re-installing over an older build? Drop legacy tables first, then push:
          </p>
          <Code>{`psql $DATABASE_URL -c "DROP TABLE IF EXISTS agents, events, settings, chat_sessions, chat_messages, graph_nodes, graph_edges CASCADE;"`}</Code>
        </Step>

        <Step n="06" title="Start the platform">
          <Code>{`# development\nnpm run dev\n\n# production\nnpm run build && npm start`}</Code>
          <p className="mt-2">Open <Link href="/" style={{ color: "var(--acid)" }}>http://localhost:3000</Link> — the desk seeds itself on first request: 6 agents, 20 companies, the supply web, the org brain, and desk procedures (51 nodes · 111 edges — the graph keeps growing from there: quotes, conversations, positions).</p>
        </Step>

        <Step n="07" title="FalkorDB is the mind — production server">
          <p>FalkorDB is the desk&apos;s mind, not an optional extra. At first boot the platform runs a boot ladder — configured server → <b>auto-booted embedded real FalkorDB engine</b> (FalkorDBLite — bundled server binary, persisted to <code className="mono" style={{ color: "var(--acid)" }}>.data/falkordb</code>) → clearly-labelled <b>DEGRADED</b> compat store — so you always know which graph runtime you are on. The embedded level needs a redis binary (<code className="mono">./scripts/bootstrap-falkordb.sh</code> on Linux x86_64, <code className="mono">brew install redis</code> on macOS); if it cannot start, the desk says so and keeps working. For a shared/production desk, run the full server and it takes priority automatically:</p>
          <Code>docker run -p 6379:6379 -it --rm falkordb/falkordb:latest</Code>
          <p className="mt-2">Save <code className="mono" style={{ color: "var(--acid)" }}>redis://localhost:6379</code> in <Link href="/settings" style={{ color: "var(--acid)" }}>Settings</Link> (persists + auto re-probes). Status bar flips to <Chip tone="acid">FALKORDB LIVE</Chip>. Verify raw:</p>
          <Code>{`redis-cli GRAPH.QUERY finq "MATCH (n) RETURN head(labels(n)), count(n)"`}</Code>
          <p className="mt-2">Graph name is <b>finq</b>. After connecting a production server, use Settings → <i>Burn &amp; reseed desk</i> to repopulate it. The <b>DEGRADED</b> Postgres compat store only engages if no real engine can run at all — and says so loudly.</p>
        </Step>

        <Step n="08" title="Local LLM plane" optional>
          <p>Routing and executive summaries become model-generated via LangChain ChatOllama:</p>
          <Code>{`# install from https://ollama.com\nollama serve\nollama pull llama3.1:8b`}</Code>
          <p className="mt-2">No restart needed — probed per question; the LLM indicator turns green.</p>
        </Step>

        <Step n="09" title="Verify the three tracks">
          <Code>{`export FINQ_API=http://localhost:3000\n\n# Track 1 — multi-hop action on connected data\nnode cli/finq.js ask "If TSMC blows up, who gets hurt?"\n\n# Track 2 — memory persists across sessions\nnode cli/finq.js remember "Our NVDA stop-loss is 8% below cost basis"\nnode cli/finq.js ask "What do you remember about our NVDA stop-loss?"\n\n# Track 3 — company brain provenance\nnode cli/finq.js ask "Why did we decide to overweight NVDA?"`}</Code>
          <p className="mt-2">Every answer ends with a reasoning trace and numbered sources.</p>
        </Step>

        <Step n="10" title="Attach MCP clients">
          <p>Stateless JSON-RPC endpoint — 22 tools (market, graph, positions, brain, memory), per-tenant via header:</p>
          <Code>{`curl -X POST http://localhost:3000/api/mcp \\\n  -H 'Content-Type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}</Code>
          <Code>{`curl -X POST http://localhost:3000/api/mcp \\\n  -H 'Content-Type: application/json' -H 'x-tenant: desk-1' \\\n  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_risk_paths","arguments":{"ticker":"TSM"}}}'`}</Code>
        </Step>

        <Step n="11" title="Tenancy">
          <p>One tenant per user, fund, or strategy — recall never crosses tenants.</p>
          <ul className="list-disc pl-5 mt-2 flex flex-col gap-1">
            <li>UI: tenant field in the Console left rail (persisted)</li>
            <li>CLI: <code className="mono" style={{ color: "var(--acid)" }}>--tenant my-desk</code></li>
            <li>MCP: <code className="mono" style={{ color: "var(--acid)" }}>x-tenant</code> header</li>
          </ul>
        </Step>

        <Step n="12" title="Reset & troubleshoot">
          <div className="flex flex-col gap-2">
            <div className="panel-inset px-3 py-2"><b>Reset:</b> Settings → <i>Burn &amp; reseed desk</i> / <i>Purge everything</i>, or <code className="mono" style={{ color: "var(--acid)" }}>{`POST /api/admin {"mode":"reseed"}`}</code></div>
            <div className="panel-inset px-3 py-2"><b>DEGRADED (red):</b> no graph engine could start — the inline error says why (missing redis binary / container down — step 07). Everything keeps working on the labelled compat store meanwhile.</div>
            <div className="panel-inset px-3 py-2"><b>LLM OFF:</b> Ollama not running — deterministic policy router carries the desk.</div>
            <div className="panel-inset px-3 py-2"><b>Quote sources:</b> chain is stooq → yahoo finance → simulated. Each quote is stamped with its actual origin — a simulated price is never labeled as live.</div>
            <div className="panel-inset px-3 py-2"><b>Health:</b> <code className="mono" style={{ color: "var(--acid)" }}>curl localhost:3000/api/health</code> → <code className="mono">{"{\"ok\":true}"}</code></div>
          </div>
        </Step>

        <Panel corners>
          <div className="flex items-center gap-3">
            <Map size={14} color="var(--acid)" />
            <div>
              <div className="font-bold text-[14px]">Full reference</div>
              <div className="mono text-[10px] mt-1" style={{ color: "var(--faint)" }}>
                SETUP.md · README.md in the repo root — same content, versioned with the code.
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
