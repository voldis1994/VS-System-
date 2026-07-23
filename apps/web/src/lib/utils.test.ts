import { describe, expect, it } from "vitest";
import { cn, formatPnl, pnlClass, uuid } from "./utils";

describe("utils", () => {
  it("merges class names", () => {
    expect(cn("a", false && "b", "c")).toContain("a");
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("formats pnl with sign", () => {
    expect(formatPnl(12.5)).toBe("+12.50");
    expect(formatPnl(-3)).toBe("-3.00");
  });

  it("maps pnl color classes", () => {
    expect(pnlClass(1)).toBe("text-profit");
    expect(pnlClass(-1)).toBe("text-loss");
    expect(pnlClass(0)).toBe("text-white/70");
  });

  it("generates uuid-like ids", () => {
    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
