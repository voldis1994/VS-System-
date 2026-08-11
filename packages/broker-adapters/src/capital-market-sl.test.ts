import { describe, expect, it } from "vitest";

/**
 * Documents Capital MARKET open SL contract (force-sl-never-naked):
 * 1. Prefer stopLevel on POST /positions
 * 2. On stop reject → bare open + sync modify until visible
 * 3. Never treat fill as done while chart stopLoss is empty
 */
function isCapitalStopReject(reason: string | undefined): boolean {
  const r = String(reason ?? "").toUpperCase();
  return (
    r.includes("STOP") ||
    r.includes("ATTACHED") ||
    r.includes("MINIMUM") ||
    r.includes("MIN_DISTANCE") ||
    r.includes("LEVEL") ||
    r.includes("DISTANCE") ||
    r.includes("GUARANTEED")
  );
}

function marketCreateBody(input: {
  epic: string;
  direction: string;
  size: number;
  withStops: boolean;
  stopLevel?: number;
  profitLevel?: number;
  trailingStop?: boolean;
  stopDistance?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    epic: input.epic,
    direction: input.direction,
    size: input.size,
  };
  if (input.trailingStop && input.stopDistance != null) {
    body.trailingStop = true;
    body.stopDistance = input.stopDistance;
    return body;
  }
  if (input.withStops && input.stopLevel != null) {
    body.stopLevel = input.stopLevel;
    if (input.profitLevel != null) body.profitLevel = input.profitLevel;
  }
  return body;
}

describe("Capital MARKET SL-on-open contract", () => {
  it("prefers stopLevel on create body when protective SL requested", () => {
    const body = marketCreateBody({
      epic: "GOLD",
      direction: "SELL",
      size: 0.01,
      withStops: true,
      stopLevel: 2650.5,
    });
    expect(body).toEqual({
      epic: "GOLD",
      direction: "SELL",
      size: 0.01,
      stopLevel: 2650.5,
    });
  });

  it("opens bare when withStops=false (fallback after stop reject)", () => {
    const body = marketCreateBody({
      epic: "GOLD",
      direction: "BUY",
      size: 0.02,
      withStops: false,
      stopLevel: 2600,
    });
    expect(body).toEqual({
      epic: "GOLD",
      direction: "BUY",
      size: 0.02,
    });
    expect(body.stopLevel).toBeUndefined();
  });

  it("detects Capital stop/min-distance reject reasons", () => {
    expect(isCapitalStopReject("MINIMUM_STOP_DISTANCE")).toBe(true);
    expect(isCapitalStopReject("ATTACHED_ORDER_LEVEL_ERROR")).toBe(true);
    expect(isCapitalStopReject("RISK_CHECK")).toBe(false);
  });
});
