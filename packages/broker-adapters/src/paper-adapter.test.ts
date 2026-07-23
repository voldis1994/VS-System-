import { describe, expect, it } from "vitest";
import { OrderDirection, OrderType } from "@nexus/domain";
import { PaperBrokerAdapter } from "./paper-adapter";
import { newId } from "@nexus/shared";

describe("PaperBrokerAdapter", () => {
  it("fills market order and opens position", async () => {
    const adapter = new PaperBrokerAdapter();
    await adapter.connect({
      accountId: newId(),
      startingBalance: "100000",
      leverage: 100,
    });

    const result = await adapter.placeOrder({
      clientRequestId: newId(),
      symbol: "EURUSD",
      type: OrderType.MARKET,
      direction: OrderDirection.BUY,
      volume: "0.10",
      stopLoss: "1.08000",
      takeProfit: "1.09500",
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe("FILLED");
    expect(result.positionId).toBeTruthy();

    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.volume).toBe("0.10");
  });

  it("rejects duplicate clientRequestId without opening second position", async () => {
    const adapter = new PaperBrokerAdapter();
    await adapter.connect({ accountId: newId(), startingBalance: "100000" });
    const clientRequestId = newId();

    const first = await adapter.placeOrder({
      clientRequestId,
      symbol: "EURUSD",
      type: OrderType.MARKET,
      direction: OrderDirection.BUY,
      volume: "0.01",
    });
    const second = await adapter.placeOrder({
      clientRequestId,
      symbol: "EURUSD",
      type: OrderType.MARKET,
      direction: OrderDirection.BUY,
      volume: "0.01",
    });

    expect(second.brokerOrderId).toBe(first.brokerOrderId);
    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
  });

  it("partially closes and fully closes position", async () => {
    const adapter = new PaperBrokerAdapter();
    await adapter.connect({ accountId: newId(), startingBalance: "100000" });
    const placed = await adapter.placeOrder({
      clientRequestId: newId(),
      symbol: "EURUSD",
      type: OrderType.MARKET,
      direction: OrderDirection.BUY,
      volume: "1.00",
    });
    const positionId = placed.positionId!;
    const partial = await adapter.partialClosePosition({
      brokerPositionId: positionId,
      volume: "0.40",
      clientRequestId: newId(),
    });
    expect(partial.positionClosed).toBe(false);
    expect(partial.remainingVolume).toBe("0.60");

    const closed = await adapter.closePosition({
      brokerPositionId: positionId,
      clientRequestId: newId(),
    });
    expect(closed.positionClosed).toBe(true);
    expect((await adapter.getOpenPositions()).length).toBe(0);
  });

  it("triggers stop loss on price update", async () => {
    const adapter = new PaperBrokerAdapter();
    await adapter.connect({ accountId: newId(), startingBalance: "100000" });
    const placed = await adapter.placeOrder({
      clientRequestId: newId(),
      symbol: "EURUSD",
      type: OrderType.MARKET,
      direction: OrderDirection.BUY,
      volume: "0.10",
      stopLoss: "1.08000",
    });
    expect(placed.accepted).toBe(true);
    adapter.updateMarketPrices!({
      EURUSD: { bid: "1.07950", ask: "1.07970" },
    });
    expect((await adapter.getOpenPositions()).length).toBe(0);
  });

  it("restores state after hydrate (restart)", async () => {
    const adapter = new PaperBrokerAdapter();
    await adapter.connect({ accountId: newId(), startingBalance: "50000" });
    await adapter.placeOrder({
      clientRequestId: newId(),
      symbol: "EURUSD",
      type: OrderType.MARKET,
      direction: OrderDirection.BUY,
      volume: "0.20",
    });
    const snap = adapter.snapshot();
    const restored = new PaperBrokerAdapter();
    restored.hydrate(snap);
    const positions = await restored.getOpenPositions();
    expect(positions).toHaveLength(1);
    const state = await restored.getAccountState();
    expect(Number(state.balance)).toBeLessThan(50000);
  });
});
