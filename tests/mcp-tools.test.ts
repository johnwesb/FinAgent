import { describe, expect, it } from "vitest";
import { callTool, listTools, TOOLS } from "@/lib/mcp/tools";
import { fmtMoney, fmtMoneyCompact } from "@/lib/money";
import { synthDeterministic } from "@/lib/engine";

const CTX = { tenant: "desk-1", runId: "test-run" };

describe("money formatting", () => {
  it("renders currency symbols, not hardcoded dollars", () => {
    expect(fmtMoney(195.85, "INR")).toBe("₹195.85");
    expect(fmtMoney(343.46, "USD")).toBe("$343.46");
    expect(fmtMoney(12, "EUR")).toBe("€12");
    expect(fmtMoney(1, undefined)).toBe("$1");
    expect(fmtMoney(1, "XXX")).toBe("XXX 1");
  });

  it("compacts market caps", () => {
    expect(fmtMoneyCompact(3.78e12, "INR")).toBe("₹3.78T");
    expect(fmtMoneyCompact(145e9, "USD")).toBe("$145.00B");
  });
});

describe("MCP tool contracts", () => {
  it("exposes a stable manifest", () => {
    const names = listTools().map((t) => t.name);
    for (const required of [
      "get_quote", "get_fundamentals", "get_news", "get_facts",
      "position_set", "position_list", "portfolio_risk", "company_profile",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("throws a readable error for unknown tools", async () => {
    await expect(callTool("nope", {}, CTX)).rejects.toThrow(/unknown tool/);
  });

  it("rejects malformed args before anything runs (strict validation)", async () => {
    await expect(
      callTool("get_quote", { tickers: "AAPL" } as never, CTX),
    ).rejects.toThrow(/invalid arguments for get_quote/);
    await expect(
      callTool("position_set", { ticker: "NVDA", qty: "lots" } as never, CTX),
    ).rejects.toThrow(/invalid arguments for position_set/);
  });

  it("every tool schema parses its own zero-arg shape where allowed", () => {
    const zero = TOOLS.filter((t) => t.name === "position_list" || t.name === "portfolio_risk");
    for (const t of zero) expect(t.schema.safeParse({}).success).toBe(true);
  });
});

describe("deterministic render", () => {
  const art = (tool: string, data: unknown, summary = "s") => ({
    agent: "market",
    tool,
    args: {},
    summary,
    data,
    sources: [{ id: "S1", label: `${tool} · test` }],
  });

  it("renders INR quotes with ₹ and never a bare $", () => {
    const out = synthDeterministic({
      question: "q",
      recalled: [],
      actions: [],
      llm: false,
      routeReason: "policy router (keyword + entity extraction)",
      artifacts: [
        art("get_quote", [
          { ticker: "ADANIPOWER.NS", price: 195.85, changePct: -0.33, currency: "INR", source: "yahoo-delayed" },
        ]),
      ],
    } as never);
    expect(out.answer).toContain("₹195.85");
    expect(out.answer).not.toContain("$195");
    expect(out.sources[0].label).toContain("get_quote");
  });

  it("guards empty company profiles (no undefined, no fake zeros)", () => {
    const out = synthDeterministic({
      question: "q",
      recalled: [],
      actions: [],
      llm: false,
      routeReason: "policy router (keyword + entity extraction)",
      artifacts: [
        art("company_profile", {
          name: "ADANI POWER LTD",
          ticker: "ADANIPOWER.NS",
          description: "",
          sector: "—",
          industry: "—",
          employees: 0,
          founded: 0,
          marketCapB: 0,
        }),
      ],
    } as never);
    expect(out.answer).not.toContain("undefined");
    expect(out.answer).not.toContain("~$0");
    expect(out.answer).toContain("| Market cap | — |");
    expect(out.answer).toContain("| Employees | — |");
  });

  it("renders position rows with P&L", () => {
    const out = synthDeterministic({
      question: "q",
      recalled: [],
      actions: [],
      llm: false,
      routeReason: "policy router (keyword + entity extraction)",
      artifacts: [
        art("position_list", [
          { ticker: "NVDA", qty: 100, avgCost: 120, price: 214.13, currency: "USD", value: 21413, pnl: 9413, pnlPct: 78.4 },
        ]),
      ],
    } as never);
    expect(out.answer).toContain("### Your book");
    expect(out.answer).toContain("$214.13");
    expect(out.answer).toContain("78.4%");
  });

  it("renders news headlines", () => {
    const out = synthDeterministic({
      question: "q",
      recalled: [],
      actions: [],
      llm: false,
      routeReason: "policy router (keyword + entity extraction)",
      artifacts: [
        art("get_news", [
          { title: "NVIDIA beats estimates", publisher: "Wire", ts: Date.UTC(2026, 9, 17) },
        ]),
      ],
    } as never);
    expect(out.answer).toContain("### Headlines");
    expect(out.answer).toContain("NVIDIA beats estimates");
  });

  it("renders SEC facts", () => {
    const out = synthDeterministic({
      question: "q",
      recalled: [],
      actions: [],
      llm: false,
      routeReason: "policy router (keyword + entity extraction)",
      artifacts: [
        art("get_facts", {
          cik: "0001045810",
          name: "NVIDIA Corp",
          facts: [{ metric: "revenue", value: 130.5e9, form: "10-K", filed: "2026-02-26", unit: "USD" }],
        }),
      ],
    } as never);
    expect(out.answer).toContain("### SEC filings");
    expect(out.answer).toContain("10-K filed 2026-02-26");
    expect(out.answer).toContain("$130.50B");
  });
});
