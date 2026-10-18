import { describe, expect, it } from "vitest";
import { extractMentions, extractTickers, heuristicRoute } from "@/lib/engine";

describe("extractTickers", () => {
  it("finds uppercase symbols", () => {
    expect(extractTickers("What is NVDA trading at?")).toContain("NVDA");
    expect(extractTickers("compare MSFT vs GOOGL")).toEqual(
      expect.arrayContaining(["MSFT", "GOOGL"]),
    );
  });

  it("does not fire finance shorthand as tickers (P/E bug class)", () => {
    expect(extractTickers("What is the P/E ratio of NVIDIA?")).not.toContain("P");
    expect(extractTickers("ROE and EPS look fine")).toEqual([]);
  });

  it("accepts cashtags for single letters, rejects bare ones", () => {
    expect(extractTickers("$T is up 3%")).toContain("T");
    expect(extractTickers("give me T data")).not.toContain("T");
  });

  it("maps aliases", () => {
    expect(extractTickers("TSMC supply chain")).toContain("TSM");
    expect(extractTickers("GOOG today")).toContain("GOOGL");
    expect(extractTickers("FB results")).toContain("META");
  });

  it("maps company names", () => {
    expect(extractTickers("how is nvidia doing")).toContain("NVDA");
    expect(extractTickers("taiwan semiconductor exposure")).toContain("TSM");
  });

  it("respects the blacklist", () => {
    expect(extractTickers("our AUM is 4B")).toEqual([]);
    expect(extractTickers("YTD returns")).toEqual([]);
  });
});

describe("extractMentions", () => {
  it("extracts capitalized company phrases", () => {
    expect(extractMentions("How is Adani Power doing?")).toContain("Adani Power");
    expect(extractMentions("How is Tata company doing?")).toContain("Tata");
  });

  it("drops sentence-starters and generic nouns", () => {
    expect(extractMentions("Tell me about the Company")).toEqual([]);
    expect(extractMentions("What is the price")).toEqual([]);
    expect(extractMentions("Give me Apple's revenue")).toContain("Apple");
  });

  it("ignores all-caps tickers (extractTickers' job)", () => {
    expect(extractMentions("Compare MSFT and NVDA")).toEqual([]);
  });
});

describe("heuristicRoute", () => {
  it("plans get_quote whenever entities are present", () => {
    const p = heuristicRoute("What is NVDA trading at?", ["NVDA"]);
    expect(p.actions.some((a) => a.tool === "get_quote")).toBe(true);
  });

  it("plans graph traversal for supply-chain questions", () => {
    const p = heuristicRoute("supply chain of TSM", ["TSM"]);
    const a = p.actions.find((x) => x.tool === "graph_supply_chain");
    expect(a?.args.ticker).toBe("TSM");
  });

  it("plans get_fundamentals for valuation questions", () => {
    const p = heuristicRoute("NVDA P/E valuation?", ["NVDA"]);
    expect(p.actions.some((a) => a.tool === "get_fundamentals")).toBe(true);
  });

  it("plans get_news for headline questions", () => {
    const p = heuristicRoute("any NVDA headlines today?", ["NVDA"]);
    expect(p.actions.some((a) => a.tool === "get_news")).toBe(true);
  });

  it("plans get_facts for filings questions", () => {
    const p = heuristicRoute("NVDA 10-K filings", ["NVDA"]);
    expect(p.actions.some((a) => a.tool === "get_facts")).toBe(true);
  });

  it("plans position_list for book questions", () => {
    const p = heuristicRoute("show my portfolio", []);
    expect(p.actions.some((a) => a.tool === "position_list")).toBe(true);
  });

  it("plans portfolio_risk for portfolio risk questions", () => {
    const p = heuristicRoute("stress my book against supply risk", []);
    expect(p.actions.some((a) => a.tool === "portfolio_risk")).toBe(true);
  });

  it("falls back to memory+brain with no signal", () => {
    const p = heuristicRoute("hello there", []);
    expect(p.plan).toContain("memory");
    expect(p.plan).toContain("synthesize");
    expect(p.actions.some((a) => a.tool === "memory_recall")).toBe(true);
  });
});
