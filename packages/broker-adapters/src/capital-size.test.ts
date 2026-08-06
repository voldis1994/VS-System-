import { describe, expect, it } from "vitest";
import {
  capitalDealRulesFallback,
  capitalSizeErrorHint,
  isCapitalSizeError,
  normalizeCapitalDealSize,
  parseCapitalDealRules,
} from "./capital-size";

describe("capital-size", () => {
  it("US100 min is 0.1 not 0.01", () => {
    const r = capitalDealRulesFallback("US100");
    expect(r.minSize).toBe(0.1);
    expect(r.step).toBe(0.1);
  });

  it("normalizes 0.001 up to US100 min", () => {
    const r = capitalDealRulesFallback("US100");
    const n = normalizeCapitalDealSize(0.001, r);
    expect(n.size).toBe(0.1);
    expect(n.adjusted).toBe(true);
  });

  it("detects Capital size error code", () => {
    expect(
      isCapitalSizeError(
        'Capital.com HTTP 400: {"errorCode":"error.positive.createpositionrequest.size"}',
      ),
    ).toBe(true);
    expect(capitalSizeErrorHint("US100", "0.001")).toContain("0.1");
  });

  it("rounds 0.15 up to US100 step 0.1 → 0.2", () => {
    const r = capitalDealRulesFallback("US100");
    const n = normalizeCapitalDealSize(0.15, r);
    expect(n.size).toBe(0.2);
  });

  it("parses Capital dealingRules payload", () => {
    const parsed = parseCapitalDealRules({
      dealingRules: {
        minDealSize: { value: 0.1 },
        maxDealSize: { value: 100 },
        dealSizeStep: { value: 0.1 },
      },
    });
    expect(parsed?.minSize).toBe(0.1);
    expect(parsed?.step).toBe(0.1);
  });
});
