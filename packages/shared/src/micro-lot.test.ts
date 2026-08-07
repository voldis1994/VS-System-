import { describe, expect, it } from "vitest";
import {
  isMarginOrFundsError,
  lotLooksTooBigForEquity,
  suggestLotForEquity,
} from "./micro-lot";

describe("micro-lot", () => {
  it("forces 0.001 on tiny equity for US100", () => {
    expect(suggestLotForEquity(21.34, "US100")).toBe("0.001");
    expect(lotLooksTooBigForEquity("0.1", 21.34, "US100")).toBe(true);
    expect(lotLooksTooBigForEquity("0.001", 21.34, "US100")).toBe(false);
  });

  it("never suggests below 0.01 for GOLD", () => {
    expect(suggestLotForEquity(21.34, "GOLD")).toBe("0.01");
    expect(suggestLotForEquity(100, "XAUUSD")).toBe("0.01");
    expect(lotLooksTooBigForEquity("0.1", 50, "GOLD")).toBe(true);
  });

  it("detects Capital margin rejects including RISK_CHECK", () => {
    expect(isMarginOrFundsError("insufficient free margin")).toBe(true);
    expect(isMarginOrFundsError("error.rejected.balance")).toBe(true);
    expect(isMarginOrFundsError("Capital rejected RISK_CHECK")).toBe(true);
    expect(isMarginOrFundsError("Capital rejected: RISK_CHECK")).toBe(true);
  });
});
