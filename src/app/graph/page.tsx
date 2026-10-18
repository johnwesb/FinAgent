"use client";

import React, { useEffect, useState } from "react";
import { GitFork, Search } from "lucide-react";
import { api, usePoll, type OverviewDTO } from "@/lib/client";
import { Chip, Empty, Panel, SectionHead } from "@/components/ui";
import { GraphViz } from "@/components/graph-viz";
import { LABEL_COLORS } from "@/lib/meta";

interface Neighborhood {
  node: { key: string; label: string; props: Record<string, unknown> };
  edges: {
    type: string;
    dir: string;
    other: { key: string; label: string; props: Record<string, unknown> };
  }[];
}

export default function GraphPage() {
  const overview = usePoll<OverviewDTO>(() => api("/api/graph/overview"), 10000);
  const [selected, setSelected] = useState<string | null>(null);
  const [hood, setHood] = useState<Neighborhood | null>(null);
  const [filter, setFilter] = useState("");

  const data = overview.data;
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    api<{ result: Neighborhood }>(`/api/graph/explore?key=${encodeURIComponent(selected)}`)
      .then((r) => {
        if (alive) setHood(r.result);
      })
      .catch(() => {
        if (alive) setHood(null);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  // Clear the inspector in the event handler (not an effect) when picking a node.
  const select = (key: string) => {
    if (key === selected) return;
    setSelected(key);
    setHood(null);
  };

  const nodes = (data?.viz.nodes ?? []).filter(
    (n) =>
      !filter ||
      n.name.toLowerCase().includes(filter.toLowerCase()) ||
      n.label.toLowerCase().includes(filter.toLowerCase()),
  );
  const keep = new Set(nodes.map((n) => n.key));
  const edges = (data?.viz.edges ?? []).filter(
    (e) => keep.has(data!.viz.nodes[e.from]?.key) && keep.has(data!.viz.nodes[e.to]?.key),
  );
  const remap = new Map(data?.viz.nodes.map((n, i) => [n.key, i]) ?? []);
  const edgeIdx = edges
    .map((e) => ({
      from: nodes.findIndex((n) => n.key === data!.viz.nodes[e.from].key),
      to: nodes.findIndex((n) => n.key === data!.viz.nodes[e.to].key),
      type: e.type,
    }))
    .filter((e) => e.from >= 0 && e.to >= 0);
  void remap;

  return (
    <div className="px-5 lg:px-8 py-7 max-w-[1500px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-3">Knowledge graph · Cypher catalog</div>
          <h1 className="bigtype" style={{ fontSize: "clamp(34px, 4.5vw, 60px)" }}>
            The <span className="clip-acid">Graph</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Search size={13} style={{ color: "var(--faint)" }} />
          <input
            className="input"
            style={{ width: 240 }}
            placeholder="filter nodes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Chip
            tone={
              data?.status.mode === "falkordb" || data?.status.mode === "falkordb-lite"
                ? "acid"
                : "red"
            }
          >
            {data?.status.mode === "falkordb"
              ? "FALKORDB LIVE"
              : data?.status.mode === "falkordb-lite"
                ? "FALKORDB LITE · embedded engine"
                : "DEGRADED · falkordb required"}
          </Chip>
        </div>
      </div>

      {/* label stats */}
      <div className="flex flex-wrap gap-2 mt-5">
        {Object.entries(data?.overview.byLabel ?? {}).map(([label, n]) => (
          <button
            key={label}
            className="chip cursor-pointer"
            style={{ color: LABEL_COLORS[label], borderColor: `${LABEL_COLORS[label]}55`, background: "none" }}
            onClick={() => setFilter(filter === label ? "" : label)}
          >
            {label} · {n}
          </button>
        ))}
        <span className="chip">{data?.overview.edgeTotal ?? 0} edges</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 mt-4 pb-10">
        <div className="xl:col-span-8">
          <Panel corners>
            <SectionHead k="Constellation" title="Entities & relationships" right={<GitFork size={13} color="var(--acid)" />} />
            {nodes.length ? (
              <GraphViz nodes={nodes} edges={edgeIdx} selected={selected} onSelect={select} height={520} />
            ) : (
              <Empty>No nodes match</Empty>
            )}
          </Panel>
        </div>
        <div className="xl:col-span-4">
          <Panel pad={false} className="h-full">
            <div className="p-5 pb-0">
              <SectionHead k="Inspector" title={hood ? hood.node.props.name ? String(hood.node.props.name) : hood.node.key : "Pick a node"} />
            </div>
            {!hood ? (
              <Empty>Click any node to inspect its neighborhood</Empty>
            ) : (
              <div className="px-5 pb-5">
                <div className="flex items-center gap-2 mb-3">
                  <span
                    className="chip"
                    style={{ color: LABEL_COLORS[hood.node.label], borderColor: `${LABEL_COLORS[hood.node.label]}55` }}
                  >
                    {hood.node.label}
                  </span>
                  <span className="mono text-[9px]" style={{ color: "var(--faint)" }}>{hood.node.key}</span>
                </div>
                <div className="panel-inset p-3 mb-4">
                  {Object.entries(hood.node.props)
                    .filter(([, v]) => typeof v !== "object")
                    .slice(0, 8)
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 mono text-[10px] py-[2px]">
                        <span style={{ color: "var(--faint)" }}>{k}</span>
                        <span style={{ color: "var(--txt)" }} className="text-right truncate max-w-[60%]">
                          {String(v)}
                        </span>
                      </div>
                    ))}
                </div>
                <div className="eyebrow mb-2">Neighborhood · {hood.edges.length}</div>
                <div className="terminal p-2" style={{ maxHeight: 320 }}>
                  {hood.edges.map((e, i) => (
                    <button
                      key={i}
                      className="w-full text-left flex gap-2 items-center px-2 py-[4px] bg-transparent border-0 cursor-pointer hover:bg-white/[0.03]"
                      onClick={() => select(e.other.key)}
                    >
                      <span className="mono text-[9px] w-[92px] truncate flex-none" style={{ color: "var(--violet)" }}>
                        {e.dir === "out" ? "→" : "←"} {e.type}
                      </span>
                      <span className="mono text-[10px] truncate" style={{ color: LABEL_COLORS[e.other.label] ?? "var(--dim)" }}>
                        {String(e.other.props.name ?? e.other.props.ticker ?? e.other.props.title ?? e.other.key)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
