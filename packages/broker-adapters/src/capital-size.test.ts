import { describe, expect, it } from "vitest";
import {
  capitalDealRulesFallback,
  capitalSizeErrorHint,
  isCapitalSizeError,
  normalizeCapitalDealSize,
  parseCapitalDealRules,
  volumePrecisionForStep,
} from "./capital-size";

describe("capital-size", () => {
  it("US100 allows 0.001 (Capital retail)", () => {
    const r = capitalDealRulesFallback("US100");
    expect(r.minSize).toBe(0.001);
    expect(r.step).toBe(0.001);
    expect(volumePrecisionForStep(r.step)).toBe(3);
  });

  it("keeps 0.001 without bumping to 0.1", () => {
    const r = capitalDealRulesFallback("US100");
    const n = normalizeCapitalDealSize(0.001, r);
    expect(n.size).toBe(0.001);
    expect(n.adjusted).toBe(false);
  });

  it("volumePrecision 2 would wipe 0.001 — we use 3", () => {
    expect((0.001).toFixed(2)).toBe("0.00");
    expect((0.001).toFixed(volumePrecisionForStep(0.001))).toBe("0.001");
  });

  it("detects Capital size error code", () => {
    expect(
      isCapitalSizeError(
        'Capital.com HTTP 400: {"errorCode":"error.positive.createpositionrequest.size"}',
      ),
    ).toBe(true);
    expect(capitalSizeErrorHint("US100", "0.00")).toContain("0.001");
  });

  it("rounds 0.0015 up to US100 step 0.001 → 0.002", () => {
    const r = capitalDealRulesFallback("US100");
    const n = normalizeCapitalDealSize(0.0015, r);
    expect(n.size).toBe(0.002);
  });

  it("parses Capital dealingRules payload", () => {
    const parsed = parseCapitalDealRules({
      dealingRules: {
        minDealSize: { value: 0.001 },
        maxDealSize: { value: 100 },
        dealSizeStep: { value: 0.001 },
      },
    });
    expect(parsed?.minSize).toBe(0.001);
    expect(parsed?.step).toBe(0.001);
  });
});
