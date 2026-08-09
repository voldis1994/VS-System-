import { describe, expect, it } from "vitest";
import {
  capitalDealRulesFallback,
  capitalRiskCheckHint,
  capitalSizeErrorHint,
  dealSizeRetryLadder,
  isCapitalRiskCheckError,
  isCapitalSizeError,
  normalizeCapitalDealSize,
  parseCapitalDealRules,
  pickBestCapitalSubAccount,
  sanitizeCapitalDealRules,
  volumePrecisionForStep,
} from "./capital-size";

describe("capital-size", () => {
  it("US100 allows 0.001 (Capital retail)", () => {
    const r = capitalDealRulesFallback("US100");
    expect(r.minSize).toBe(0.001);
    expect(r.step).toBe(0.001);
    expect(volumePrecisionForStep(r.step)).toBe(3);
  });

  it("UST100 alias uses index micro-lot rules", () => {
    const r = capitalDealRulesFallback("UST100");
    expect(r.minSize).toBe(0.001);
    expect(r.step).toBe(0.001);
  });

  it("GOLD fallback min is 0.01", () => {
    const r = capitalDealRulesFallback("GOLD");
    expect(r.minSize).toBe(0.01);
    expect(r.step).toBe(0.01);
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

  it("detects RISK_CHECK and builds ladder toward min", () => {
    expect(isCapitalRiskCheckError("RISK_CHECK")).toBe(true);
    expect(isCapitalRiskCheckError("Capital rejected: RISK_CHECK")).toBe(true);
    const r = capitalDealRulesFallback("GOLD");
    const ladder = dealSizeRetryLadder(0.1, r);
    expect(ladder[0]).toBe(0.1);
    expect(ladder[ladder.length - 1]).toBe(0.01);
    expect(ladder.length).toBeGreaterThan(1);
    expect(capitalRiskCheckHint("GOLD", "0.12")).toMatch(/sent lot 0\.12/);
    expect(capitalRiskCheckHint("GOLD", "0.12")).toMatch(/Bind|Connect/i);
  });

  it("does not treat instrument.lotSize=1 as GOLD step (contract size)", () => {
    // Capital often returns lotSize=1 (ounces/contract) with minDealSize=0.01
    // and NO dealSizeStep — old code used step=1 → 0.12 became 1 → RISK_CHECK.
    const parsed = parseCapitalDealRules(
      {
        dealingRules: {
          minDealSize: { value: 0.01 },
          maxDealSize: { value: 100 },
        },
        instrument: { lotSize: 1 },
      },
      "GOLD",
    );
    expect(parsed?.step).toBe(0.01);
    expect(parsed?.minSize).toBe(0.01);
    const n = normalizeCapitalDealSize(0.12, parsed!);
    expect(n.size).toBe(0.12);
    expect(n.adjusted).toBe(false);
  });

  it("sanitizes absurd GOLD step/min from bad broker payload", () => {
    const cleaned = sanitizeCapitalDealRules("GOLD", {
      minSize: 1,
      maxSize: 100,
      step: 1,
    });
    expect(cleaned.minSize).toBe(0.01);
    expect(cleaned.step).toBe(0.01);
  });

  it("picks richest CFD sub-account, not preferred micro", () => {
    const best = pickBestCapitalSubAccount([
      {
        accountId: "tiny",
        preferred: true,
        balance: { balance: 21, available: 21 },
      },
      {
        accountId: "big",
        preferred: false,
        balance: { balance: 500, available: 480 },
      },
    ]);
    expect(best?.accountId).toBe("big");
    expect(
      pickBestCapitalSubAccount(
        [
          { accountId: "tiny", available: 21 },
          { accountId: "big", available: 480 },
        ],
        "tiny",
      )?.accountId,
    ).toBe("tiny");
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
