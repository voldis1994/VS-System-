import { describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Mirrors CapitalComAdapter.withLoginLock semantics (audit C1):
 * reentrancy only via AsyncLocalStorage — sibling callers must queue.
 */
describe("Capital login lock semantics", () => {
  const owner = new AsyncLocalStorage<true>();

  async function withLoginLock(
    state: { tail: Promise<unknown>; log: string[] },
    label: string,
    fn: () => Promise<void>,
  ) {
    if (owner.getStore()) {
      state.log.push(`${label}:reenter`);
      await fn();
      return;
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = state.tail;
    state.tail = prev.then(
      () => gate,
      () => gate,
    );
    await prev.catch(() => undefined);
    try {
      state.log.push(`${label}:enter`);
      await owner.run(true, fn);
      state.log.push(`${label}:exit`);
    } finally {
      release();
    }
  }

  it("queues sibling callers instead of barging in", async () => {
    const state = { tail: Promise.resolve() as Promise<unknown>, log: [] as string[] };
    const order: string[] = [];

    const a = withLoginLock(state, "A", async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("A-end");
    });
    const b = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      await withLoginLock(state, "B", async () => {
        order.push("B-start");
        order.push("B-end");
      });
    })();

    await Promise.all([a, b]);
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
    expect(state.log.filter((x) => x.includes("reenter"))).toHaveLength(0);
  });

  it("allows nested reentry in the same async context", async () => {
    const state = { tail: Promise.resolve() as Promise<unknown>, log: [] as string[] };
    const order: string[] = [];

    await withLoginLock(state, "outer", async () => {
      order.push("outer");
      await withLoginLock(state, "inner", async () => {
        order.push("inner");
      });
    });

    expect(order).toEqual(["outer", "inner"]);
    expect(state.log).toContain("inner:reenter");
  });
});
