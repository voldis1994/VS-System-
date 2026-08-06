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

  it("formats UNKNOWN timeout clearly", () => {
    expect(
      formatCapitalConfirmRejection({
        dealStatus: "UNKNOWN",
        reason: "Confirm timeout",
      }),
    ).toContain("confirm timeout");
  });
});
