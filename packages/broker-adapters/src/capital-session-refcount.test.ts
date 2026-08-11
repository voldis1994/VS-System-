import { describe, expect, it } from "vitest";

/**
 * Mirrors CapitalComAdapter shared-login refcount: disconnect must not DELETE
 * CST while sibling VS adapters still hold the login (multi-account isolation).
 */
describe("Capital shared session refcount", () => {
  type Shared = {
    tokens: { cst: string } | null;
    refs: Map<string, string>;
  };

  function disconnect(shared: Shared, vsAccountId: string): {
    remaining: number;
    deletedSession: boolean;
  } {
    shared.refs.delete(vsAccountId);
    const remaining = shared.refs.size;
    let deletedSession = false;
    if (remaining === 0) {
      shared.tokens = null;
      deletedSession = true;
    }
    return { remaining, deletedSession };
  }

  it("keeps CST when a sibling adapter is still registered", () => {
    const shared: Shared = {
      tokens: { cst: "live" },
      refs: new Map([
        ["acc-A", "CFD-1"],
        ["acc-B", "CFD-2"],
      ]),
    };
    const r = disconnect(shared, "acc-A");
    expect(r.remaining).toBe(1);
    expect(r.deletedSession).toBe(false);
    expect(shared.tokens?.cst).toBe("live");
  });

  it("deletes CST only when last adapter disconnects", () => {
    const shared: Shared = {
      tokens: { cst: "live" },
      refs: new Map([["acc-B", "CFD-2"]]),
    };
    const r = disconnect(shared, "acc-B");
    expect(r.remaining).toBe(0);
    expect(r.deletedSession).toBe(true);
    expect(shared.tokens).toBeNull();
  });

  it("sibling pin set excludes own account", () => {
    const refs = new Map([
      ["acc-A", "CFD-1"],
      ["acc-B", "CFD-2"],
      ["acc-C", ""],
    ]);
    const self = "acc-A";
    const taken = new Set<string>();
    for (const [vsId, pin] of refs) {
      if (vsId === self) continue;
      if (pin) taken.add(pin);
    }
    expect([...taken]).toEqual(["CFD-2"]);
  });
});
