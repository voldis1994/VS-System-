import { describe, expect, it } from "vitest";
import { d, floorToStep } from "./decimal";

describe("decimal helpers", () => {
  it("floors to step deterministically", () => {
    expect(floorToStep(d("1.239"), d("0.01")).toFixed(2)).toBe("1.23");
    expect(floorToStep(d("0.019"), d("0.01")).toFixed(2)).toBe("0.01");
  });
});
