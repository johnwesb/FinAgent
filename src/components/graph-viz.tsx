"use client";

import React, { useMemo } from "react";
import type { VizEdge, VizNode } from "@/lib/client";
import { LABEL_COLORS } from "@/lib/meta";

/** Deterministic constellation layout: label buckets on rings. */
export function GraphViz({
  nodes,
  edges,
  selected,
  onSelect,
  height = 460,
}: {
  nodes: VizNode[];
  edges: VizEdge[];
  selected?: string | null;
  onSelect?: (key: string) => void;
  height?: number;
}) {
  const W = 900;
  const H = height;
  const cx = W / 2;
  const cy = H / 2;

  const positioned = useMemo(() => {
    const buckets = new Map<string, VizNode[]>();
    for (const n of nodes) {
      const b = buckets.get(n.label) ?? [];
      b.push(n);
      buckets.set(n.label, b);
    }
    const order = [...buckets.keys()].sort(
      (a, b) => (buckets.get(b)!.length ?? 0) - (buckets.get(a)!.length ?? 0),
    );
    const pos = new Map<string, { x: number; y: number }>();
    order.forEach((label, bi) => {
      const bucket = buckets.get(label)!;
      const ring = bi === 0 ? 0 : Math.min(bi, 4);
      const radius = ring === 0 ? 0 : 92 + (ring - 1) * 108;
      const startAngle = (bi * 1.7) % (Math.PI * 2);
      bucket.forEach((n, i) => {
        if (radius === 0) {
          pos.set(n.key, { x: cx, y: cy });
        } else {
          const a = startAngle + (i / bucket.length) * Math.PI * 2;
          const jitter = ((i * 37) % 11) - 5;
          pos.set(n.key, {
            x: cx + (radius + jitter * 4) * Math.cos(a),
            y: cy + (radius * 0.72 + jitter * 3) * Math.sin(a),
          });
        }
      });
    });
    return pos;
  }, [nodes, cx, cy]);

  const color = (l: string) => LABEL_COLORS[l] ?? "#8b939e";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none">
      {edges.map((e, i) => {
        const a = positioned.get(nodes[e.from]?.key);
        const b = positioned.get(nodes[e.to]?.key);
        if (!a || !b) return null;
        const hot = selected && (nodes[e.from]?.key === selected || nodes[e.to]?.key === selected);
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={hot ? "rgba(198,255,74,0.6)" : "rgba(255,255,255,0.07)"}
            strokeWidth={hot ? 1.4 : 1}
          />
        );
      })}
      {nodes.map((n) => {
        // key-less nodes (legacy Quote rows) share a null key — skip them
        // instead of rendering duplicate React children.
        const p = n.key ? positioned.get(n.key) : undefined;
        if (!p) return null;
        const isSel = selected === n.key;
        const main = n.label === "Company";
        return (
          <g
            key={n.key}
            transform={`translate(${p.x},${p.y})`}
            className="cursor-pointer"
            onClick={() => onSelect?.(n.key)}
          >
            <circle
              r={isSel ? 9 : main ? 7 : 5}
              fill="#0a0c0e"
              stroke={color(n.label)}
              strokeWidth={isSel ? 2.2 : 1.4}
              style={isSel ? { filter: `drop-shadow(0 0 10px ${color(n.label)})` } : undefined}
            />
            <circle r={2} fill={color(n.label)} />
            {(main || isSel) && (
              <text
                y={-12}
                textAnchor="middle"
                fontFamily="var(--font-mono)"
                fontSize={9}
                letterSpacing={1}
                fill={isSel ? "#e8ecef" : "#8b939e"}
              >
                {n.name.slice(0, 16)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
