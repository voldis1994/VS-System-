import { describe, expect, it } from "vitest";
import {
  formatCapitalConfirmRejection,
  isCapitalConfirmAccepted,
  isCapitalConfirmTerminal,
  parseCapitalConfirm,
} from "./capital-confirm";

describe("capital-confirm", () => {
  it("parses dealId from affectedDeals when top-level missing", () => {
    const c = parseCapitalConfirm({
      dealStatus: "ACCEPTED",
      status: "OPEN",
      level: 29400.5,
      affectedDeals: [{ dealId: "deal-abc", status: "OPENED" }],
    });
    expect(c.dealId).toBe("deal-abc");
    expect(isCapitalConfirmTerminal(c)).toBe(true);
    expect(isCapitalConfirmAccepted(c)).toBe(true);
  });

  it("treats REJECTED as terminal not accepted", () => {
    const c = parseCapitalConfirm({
      dealStatus: "REJECTED",
      reason: "error.conflict.min-stop",
    });
    expect(isCapitalConfirmTerminal(c)).toBe(true);
    expect(isCapitalConfirmAccepted(c)).toBe(false);
    expect(formatCapitalConfirmRejection(c)).toContain("min-stop");
  });

  it("formats REJECTED without reason using raw hint", () => {
    const c = parseCapitalConfirm({
      dealStatus: "REJECTED",
      epic: "GOLD",
      size: 0.01,
    });
    expect(c.reason).toBeUndefined();
    expect(c.rawHint).toBeTruthy();
    expect(formatCapitalConfirmRejection(c)).toMatch(/broker payload|sub-account/i);
  });

  it("parses reason from nested error / affectedDeals", () => {
    const c = parseCapitalConfirm({
      dealStatus: "REJECTED",
      error: { errorCode: "error.market.closed" },
      affectedDeals: [{ dealId: "x", reason: "MARKET_CLOSED" }],
    });
    expect(c.reason).toMatch(/market|MARKET/i);
  });
});
