"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface AgentDTO {
  id: number;
  key: string;
  name: string;
  role: string;
  callsign: string;
  model: string;
  temperature: number;
  directive: string;
  color: string;
  tools: string;
  runs: number;
}

export interface SessionDTO {
  id: number;
  tenant: string;
  title: string;
  updatedAt: string;
}

export interface MessageDTO {
  id: number;
  role: "user" | "assistant";
  content: string;
  runId: string | null;
  createdAt: string;
}

export interface EventDTO {
  id: number;
  runId: string;
  agent: string;
  kind: string;
  content: string;
  createdAt: string;
}

export interface StatsDTO {
  agents: number;
  sessions: number;
  messages: number;
  graph: {
    mode: "falkordb" | "falkordb-lite" | "embedded";
    url: string;
    nodes: number;
    edges: number;
    byLabel: Record<string, number>;
  };
  ollama: { up: boolean; models: number; base: string };
  market: { live: boolean; source?: "stooq-delayed" | "yahoo-delayed" | "simulated" };
}

export interface QuoteDTO {
  ticker: string;
  price: number;
  changePct: number;
  ts: number;
  currency?: string;
  name?: string;
  source: "stooq-delayed" | "yahoo-delayed" | "simulated";
}

export interface VizNode {
  key: string;
  label: string;
  name: string;
  props: Record<string, unknown>;
}
export interface VizEdge {
  from: number;
  to: number;
  type: string;
}

export interface OverviewDTO {
  status: { mode: string; url: string; graph: string };
  overview: {
    byLabel: Record<string, number>;
    byType: Record<string, number>;
    total: number;
    edgeTotal: number;
  };
  viz: { nodes: VizNode[]; edges: VizEdge[] };
}

export interface BrainDTO {
  org: {
    team: string;
    focus: string;
    members: string[];
    projects: { name: string; status: string; lead: string | null }[];
  }[];
  decisions: {
    title: string;
    date: string;
    status: string;
    rationale: string;
    sources: string[];
    deciders: string[];
    tickers: string[];
  }[];
  documents: Record<string, unknown>[];
  people: { name: string; role: string }[];
}

export interface MemoryDTO {
  memory: { kind: string; text: string; topic: string; confidence: number; ts: number }[];
  episodic: { role: string; content: string; ts: number; sessionId: number }[];
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const LOCAL_EVENT = "finq:local-storage";

/**
 * localStorage-backed state that is safe under SSR/hydration
 * (server snapshot falls back to the default value).
 */
export function useLocalState(
  key: string,
  initial: string,
): [string, (v: string) => void] {
  const subscribe = (onChange: () => void) => {
    const onLocal = () => onChange();
    window.addEventListener(LOCAL_EVENT, onLocal);
    window.addEventListener("storage", onLocal);
    return () => {
      window.removeEventListener(LOCAL_EVENT, onLocal);
      window.removeEventListener("storage", onLocal);
    };
  };
  const read = () => {
    try {
      return window.localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  };
  const value = useSyncExternalStore(subscribe, read, () => initial);
  const write = (v: string) => {
    try {
      window.localStorage.setItem(key, v);
    } catch {
      /* private mode / quota */
    }
    window.dispatchEvent(new Event(LOCAL_EVENT));
  };
  return [value, write];
}

export function usePoll<T>(
  loader: () => Promise<T>,
  ms: number,
  deps: unknown[] = [],
): { data: T | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const d = await loaderRef.current();
        if (alive) setData(d);
      } catch {
        /* transient */
      }
    };
    run();
    const t = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick, ...deps]);
  return { data, refresh: () => setTick((x) => x + 1) };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "--:--:--";
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}
