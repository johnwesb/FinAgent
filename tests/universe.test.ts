import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/graph", () => ({ graphRun: vi.fn() }));
vi.mock("@/lib/market", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, searchSymbol: vi.fn(), verifySymbol: vi.fn() };
});

import { graphRun } from "@/lib/graph";
import { searchSymbol, verifySymbol } from "@/lib/market";
import { resolveToSymbol, TICKER_ALIASES } from "@/lib/universe";

const graphRunMock = vi.mocked(graphRun);
const searchMock = vi.mocked(searchSymbol);
const verifyMock = vi.mocked(verifySymbol);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveToSymbol", () => {
  it("graph fast-path wins and never calls the network", async () => {
    graphRunMock.mockResolvedValue({
      data: [{ ticker: "NVDA", name: "NVIDIA Corp" }],
    } as never);
    const r = await resolveToSymbol("nvidia");
    expect(r).toMatchObject({ symbol: "NVDA", name: "NVIDIA Corp" });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("resolves a new company name via search and ingests it", async () => {
    graphRunMock.mockImplementation((async (op: string) => {
      if (op === "searchCompanies") return { data: [] };
      if (op === "upsertCompany") return { data: null };
      return { data: null };
    }) as never);
    searchMock.mockResolvedValue({
      symbol: "ADANIPOWER.NS",
      name: "ADANI POWER LTD",
      exchange: "NSI",
    });
    const r = await resolveToSymbol("Adani Power");
    expect(r).toMatchObject({ symbol: "ADANIPOWER.NS", ingested: true });
    expect(graphRunMock).toHaveBeenCalledWith(
      "upsertCompany",
      expect.objectContaining({ ticker: "ADANIPOWER.NS" }),
    );
  });

  it("returns null when nothing credible matches (never fabricates)", async () => {
    graphRunMock.mockResolvedValue({ data: [] } as never);
    searchMock.mockResolvedValue(null);
    expect(await resolveToSymbol("Zzzz Qqqqq")).toBeNull();
  });

  it("rejects a symbol-shaped ticker the feed says doesn't exist", async () => {
    graphRunMock.mockResolvedValue({ data: [] } as never);
    verifyMock.mockResolvedValue(false);
    expect(await resolveToSymbol("NOTREAL")).toBeNull();
  });

  it("trusts a symbol-shaped ticker when the feed is unreachable (offline mode)", async () => {
    graphRunMock.mockResolvedValue({ data: [] } as never);
    verifyMock.mockResolvedValue("unknown");
    expect(await resolveToSymbol("SMCI")).toMatchObject({ symbol: "SMCI" });
  });

  it("applies ticker aliases (TSMC → TSM)", () => {
    expect(TICKER_ALIASES.TSMC).toBe("TSM");
  });
});
