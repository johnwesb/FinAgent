#!/usr/bin/env node
/**
 * FINQ//DESK CLI — the graph finance desk from your terminal.
 * Zero dependencies. Node 18+.
 *
 *   finq status                              desk, graph, market, llm status
 *   finq ask "<question>" [--tenant desk-1]  run the multi-agent desk, print the answer
 *   finq quote AAPL [MSFT …]                 real-time quotes (+graph persistence)
 *   finq quote "Adani Power"                 company names resolve to real symbols too
 *   finq history AAPL [--days 60]            close history sparkline
 *   finq news NVDA                           headlines for a ticker
 *   finq position [add N Q C | list | risk]  your book: set, mark, stress
 *   finq brain                               org + decisions + documents
 *   finq ingest "<title>" "<body>"           write a document into the graph
 *   finq decide "<title>" "<rationale>" [--by "Mira Chen"] [--sources "Memo A, Memo B"]
 *   finq memory [--kind semantic|procedural] [--tenant desk-1]
 *   finq remember "<text>" [--kind …]        store a memory node
 *   finq tools                               MCP tool manifest
 *   finq mcp-call <tool> '<json-args>'       call an MCP tool directly
 *
 * Env: FINQ_API (default http://localhost:3000)
 */

const API = process.env.FINQ_API || process.env.AGENTCO_API || "http://localhost:3000";

const isTTY = process.stdout.isTTY;
const ESC = "";
const c = (code) => (s) => (isTTY ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));
const bold = c("1");
const dim = c("2");
const acid = c("38;5;148");
const cyan = c("36");
const violet = c("38;5;141");
const CUR_SYM = { USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥", HKD: "HK$", CNY: "CN¥", KRW: "₩", AUD: "A$", CAD: "C$", SGD: "S$", TWD: "NT$" };
const money = (n, cur) => `${CUR_SYM[String(cur || "USD").toUpperCase()] ?? String(cur || "USD") + " "}${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const amber = c("38;5;214");
const red = c("31");
const grey = c("90");

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
    else flags[k] = true;
  } else positional.push(a);
}
const cmd = positional[0];

function fail(msg, code = 1) {
  console.error(`${red("err")} ${msg}`);
  process.exit(code);
}

async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
  } catch {
    fail(`cannot reach FINQ//DESK at ${API} — is the platform running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) fail(data.error || `HTTP ${res.status}`);
  return data;
}

const banner = () =>
  console.log(acid(bold("FINQ//DESK")) + grey(" · graph finance os") + grey(` :: ${API}`));

const spark = (pts) => {
  const ticks = "▁▂▃▄▅▆▇█";
  const vals = pts.map((p) => p.close);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return vals.map((v) => ticks[Math.min(7, Math.floor(((v - min) / span) * 8))]).join("");
};

async function main() {
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      console.log(bannerText());
      break;

    case "status": {
      banner();
      const s = await req("/api/stats");
      const modeLabel =
        s.graph.mode === "falkordb"
          ? acid("FALKORDB LIVE")
          : s.graph.mode === "falkordb-lite"
            ? cyan("FALKORDB LITE · embedded engine")
            : red("DEGRADED · falkordb required");
      console.log(
        `  graph     ${modeLabel} @ ${s.graph.url}` +
          (s.graph.error ? dim(` · ${s.graph.error}`) : ""),
      );
      console.log(`  graph size ${acid(`${s.graph.nodes} nodes · ${s.graph.edges} edges`)} ${dim(Object.entries(s.graph.byLabel).map(([k, v]) => `${k}:${v}`).join(" "))}`);
      const feed = s.market.source || (s.market.live ? "stooq-delayed" : "simulated");
      console.log(`  market    ${feed === "simulated" ? amber("simulated feed") : cyan(feed.replace(/-/g, " ") + " feed")}`);
      console.log(`  llm       ${s.ollama.up ? acid(`online · ${s.ollama.models} models`) : grey("offline — policy router engaged")}`);
      console.log(`  desk      ${s.agents} agents · ${s.sessions} threads · ${s.messages} messages`);
      break;
    }

    case "ask": {
      const question = positional.slice(1).join(" ").trim();
      if (question.length < 2) fail('usage: finq ask "<question>" [--tenant desk-1]');
      const tenant = flags.tenant || "desk-1";
      const { sessionId } = await req("/api/chat", {
        method: "POST",
        body: JSON.stringify({ question, tenant }),
      });
      // poll for the assistant answer
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 900));
        const d = await req(`/api/chat/${sessionId}`);
        const last = d.messages[d.messages.length - 1];
        if (last && last.role === "assistant") {
          console.log();
          console.log(last.content);
          break;
        }
        if (Date.now() - t0 > 120_000) fail("timed out waiting for the desk");
        if (isTTY) process.stdout.write(dim("."));
      }
      break;
    }

    case "quote": {
      const rest = positional.slice(1);
      if (!rest.length) fail('usage: finq quote AAPL [MSFT …] or finq quote "Adani Power"');
      // ALL-CAPS args are tickers; anything else is treated as a company name
      const inputs = rest.every((t) => t === t.toUpperCase()) ? rest : [rest.join(" ")];
      const r = await mcp("get_quote", { tickers: inputs });
      const quotes = r.data || [];
      for (const q of quotes) {
        const dir = q.changePct >= 0 ? acid("▲") : red("▼");
        console.log(
          `  ${bold(q.ticker.padEnd(6))} ${money(q.price, q.currency).padEnd(10)} ${dir} ${Math.abs(q.changePct).toFixed(2)}%  ${grey(q.source)}`,
        );
      }
      console.log(dim(`  persisted to graph as Quote nodes (${r.summary})`));
      break;
    }

    case "history": {
      const t = positional.slice(1).join(" ").trim();
      if (!t) fail('usage: finq history AAPL [--days 60] or finq history "Adani Power"');
      const r = await mcp("get_history", { ticker: t, days: Number(flags.days || 60) });
      const sym = r.data.ticker || t.toUpperCase();
      console.log(`  ${bold(sym)} ${grey(r.data.source)}`);
      console.log(`  ${acid(spark(r.data.points))}`);
      const pts = r.data.points;
      console.log(
        dim(
          `  ${pts[0].date}: ${money(pts[0].close, r.data.currency)} → ${pts[pts.length - 1].date}: ${money(pts[pts.length - 1].close, r.data.currency)}`,
        ),
      );
      break;
    }

    case "news": {
      const t = positional.slice(1).join(" ").trim();
      if (!t) fail("usage: finq news NVDA");
      const r = await mcp("get_news", { ticker: t, limit: 8 });
      const items = r.data || [];
      if (!items.length) {
        console.log(dim(`  no headlines (${r.summary})`));
        break;
      }
      for (const n of items) {
        console.log(`  ${cyan(new Date(Number(n.ts)).toISOString().slice(0, 10))} ${bold(String(n.title).slice(0, 90))}`);
        console.log(dim(`    ${n.publisher} · ${n.url}`));
      }
      break;
    }

    case "position": {
      const sub = positional[1];
      if (sub === "add") {
        const [ticker, qty, avgCost] = positional.slice(2);
        if (!ticker || qty === undefined || avgCost === undefined)
          fail("usage: finq position add NVDA 100 120.50 [--note \"core\"]");
        const r = await mcp("position_set", { ticker, qty: Number(qty), avgCost: Number(avgCost), note: flags.note });
        console.log(`  ${acid(String(r.summary))}`);
      } else if (sub === "risk") {
        const r = await mcp("portfolio_risk", {});
        console.log(`  ${acid(String(r.summary))}`);
        for (const x of r.data?.positions ?? [])
          console.log(`  ${bold(String(x.ticker).padEnd(10))} ${money(x.value, x.currency).padEnd(12)} P&L ${money(x.pnl, x.currency)}`);
        for (const w of r.data?.risk ?? [])
          if (w.count > 0) console.log(dim(`    ${w.ticker}: ${w.count} dependent(s) within 3 hops in the supply web`));
      } else {
        const r = await mcp("position_list", {});
        console.log(`  ${acid(String(r.summary))}`);
        for (const x of r.data ?? []) {
          const dir = x.pnl >= 0 ? acid("▲") : red("▼");
          console.log(
            `  ${bold(String(x.ticker).padEnd(10))} ${String(x.qty).padStart(8)} @ ${money(x.avgCost, x.currency).padEnd(10)} → ${money(x.price, x.currency).padEnd(10)} ${dir} ${money(x.pnl, x.currency)} (${Number(x.pnlPct).toFixed(1)}%)`,
          );
        }
      }
      break;
    }

    case "brain": {
      banner();
      const b = await req("/api/brain");
      console.log(bold("  ORG"));
      for (const t of b.org) {
        console.log(`  ${cyan(t.team)} ${grey(`— ${t.focus}`)}`);
        console.log(`    members: ${t.members.join(", ") || "—"}`);
        for (const p of t.projects)
          console.log(`    project: ${p.name} ${grey(`(${p.status}${p.lead ? ` · ${p.lead}` : ""})`)}`);
      }
      console.log(bold("  DECISIONS"));
      for (const d of b.decisions) {
        console.log(`  ${amber(d.title)} ${grey(d.date)}`);
        console.log(`    by ${d.deciders.join(", ") || "—"} · from ${d.sources.map((s) => `“${s}”`).join(", ") || "—"}`);
      }
      console.log(bold("  DOCUMENTS"));
      for (const d of b.documents) console.log(`  ${d.title}`);
      break;
    }

    case "ingest": {
      const title = positional[1];
      const body = positional[2] ?? "";
      if (!title) fail('usage: finq ingest "<title>" "<body>"');
      const r = await mcp("brain_ingest_document", { title, body });
      console.log(`${acid("ingested")} ${r.summary}`);
      break;
    }

    case "decide": {
      const title = positional[1];
      const rationale = positional[2] ?? "";
      if (!title) fail('usage: finq decide "<title>" "<rationale>" [--by X] [--sources "A, B"]');
      const r = await mcp("brain_record_decision", {
        title,
        rationale,
        decidedBy: flags.by,
        sources: flags.sources ? String(flags.sources).split(",").map((s) => s.trim()) : undefined,
      });
      console.log(`${acid("recorded")} ${r.summary}`);
      break;
    }

    case "memory": {
      const tenant = flags.tenant || "desk-1";
      const r = await req(`/api/memory?tenant=${encodeURIComponent(tenant)}${flags.kind ? `&kind=${flags.kind}` : ""}`);
      banner();
      console.log(bold(`  MEMORY (${flags.kind || "all"})`));
      for (const m of r.memory)
        console.log(`  ${m.kind === "procedural" ? violet(m.kind) : cyan(m.kind)} ×${m.confidence || 1}  ${m.text}`);
      console.log(dim(`  episodes: ${r.episodic.length} recalled`));
      break;
    }

    case "remember": {
      const text = positional.slice(1).join(" ").trim();
      if (!text) fail('usage: finq remember "<text>" [--kind semantic|procedural]');
      const r = await mcp("memory_store", {
        text,
        kind: flags.kind || "semantic",
      });
      console.log(`${acid("stored")} ${r.summary}`);
      break;
    }

    case "tools": {
      const m = await req("/api/mcp");
      banner();
      for (const t of m.tools) console.log(`  ${violet(t.name.padEnd(24))} ${dim(t.description)}`);
      break;
    }

    case "mcp-call": {
      const tool = positional[1];
      if (!tool) fail("usage: finq mcp-call <tool> '<json-args>'");
      let args = {};
      try {
        args = positional[2] ? JSON.parse(positional[2]) : {};
      } catch {
        fail("args must be valid JSON");
      }
      const r = await mcp(tool, args);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    default:
      fail(`unknown command "${cmd}" — run finq --help`);
  }
}

async function mcp(name, args) {
  const res = await fetch(`${API}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tenant": flags.tenant || "desk-1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = await res.json();
  const result = data?.result;
  const payload = result?.content?.[0]?.text;
  if (!payload) fail(`MCP call failed: ${JSON.stringify(data).slice(0, 200)}`);
  if (result?.isError) fail(`MCP tool error: ${payload}`);
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function bannerText() {
  return [
    acid(bold("FINQ//DESK CLI")) + grey(" — graph finance control"),
    "",
    bold("commands"),
    "  status                            desk, graph, market, llm status",
    '  ask "<question>"                  run the multi-agent desk',
    "  quote AAPL [MSFT …]               real-time quotes (graph-persisted)",
    "  history AAPL [--days 60]          close history sparkline",
    "  brain                             org + decisions + documents",
    '  ingest "<title>" "<body>"         write a document into the graph',
    '  decide "<title>" "<rationale>"    record a decision with provenance',
    "  memory [--kind …]                 browse tenant memory",
    '  remember "<text>"                 store a memory node',
    "  tools                             MCP tool manifest",
    "  mcp-call <tool> '<json>'          call an MCP tool directly",
    "",
    grey(`env  FINQ_API (current: ${API})`),
  ].join("\n");
}

main().catch((e) => fail(e.message || String(e)));
