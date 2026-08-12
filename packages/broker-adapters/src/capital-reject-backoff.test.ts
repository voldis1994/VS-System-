import { describe, expect, it } from "vitest";
import {
  capitalModifyRejectBackoffMs,
  isCapitalStopLevelReject,
} from "./capital-size";

describe("Capital modify reject backoff", () => {
  it("stop-level rejects get long backoff", () => {
    expect(isCapitalStopLevelReject("MINIMUM_STOP_DISTANCE")).toBe(true);
    expect(capitalModifyRejectBackoffMs("MINIMUM_STOP_DISTANCE")).toBe(120_000);
  });

  it("risk check gets longest backoff", () => {
    expect(capitalModifyRejectBackoffMs("RISK_CHECK")).toBe(300_000);
  });

  it("generic reject defaults to 90s", () => {
    expect(capitalModifyRejectBackoffMs("unknown")).toBe(90_000);
  });
});
