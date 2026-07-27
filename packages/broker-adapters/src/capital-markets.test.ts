import { describe, expect, it } from "vitest";
import {
  formatMarketCode,
  pickPreferredEpic,
  prioritizeCapitalMarkets,
} from "./capital-markets";

describe("pickPreferredEpic", () => {
  it("skips numeric share epics when a desk favorite exists", () => {
    expect(
      pickPreferredEpic([
        { epic: "0001" },
        { epic: "0007" },
        { epic: "US100" },
        { epic: "AAPL" },
      ]),
    ).toBe("US100");
  });

  it("falls back to first non-numeric epic", () => {
    expect(
      pickPreferredEpic([{ epic: "0001" }, { epic: "NVDA" }, { epic: "0002" }]),
    ).toBe("NVDA");
  });

  it("defaults to GOLD when markets empty", () => {
    expect(pickPreferredEpic([])).toBe("GOLD");
  });
});

describe("prioritizeCapitalMarkets", () => {
  it("puts preferred CFDs before numeric share codes", () => {
    const sorted = prioritizeCapitalMarkets([
      { epic: "0001" },
      { epic: "EURUSD" },
      { epic: "0007" },
      { epic: "GOLD" },
    ]);
    expect(sorted.map((m) => m.epic)).toEqual([
      "GOLD",
      "EURUSD",
      "0001",
      "0007",
    ]);
  });
});

describe("formatMarketCode", () => {
  it("is a 4-digit list index, not an epic", () => {
    expect(formatMarketCode(0)).toBe("0001");
    expect(formatMarketCode(6)).toBe("0007");
  });
});
