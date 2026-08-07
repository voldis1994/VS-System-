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

  it("detects Capital margin rejects", () => {
    expect(isMarginOrFundsError("insufficient free margin")).toBe(true);
    expect(isMarginOrFundsError("error.rejected.balance")).toBe(true);
  });
});
