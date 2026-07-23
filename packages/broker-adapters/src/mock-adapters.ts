import { PaperBrokerAdapter } from "./paper-adapter";
import { CapitalComAdapter } from "./capital-com-adapter";
import type { BrokerAdapter, BrokerConnectionConfig, ConnectionResult } from "./types";

/** Mock adapters reuse paper engine with a different provider label for local development. */
export class MockMt4Adapter extends PaperBrokerAdapter {
  override async connect(config: BrokerConnectionConfig): Promise<ConnectionResult> {
    const result = await super.connect(config);
    return { ...result, message: "Mock MT4 connected", externalAccountId: `MT4-${config.accountId.slice(0, 8)}` };
  }
}

export class MockMt5Adapter extends PaperBrokerAdapter {
  override async connect(config: BrokerConnectionConfig): Promise<ConnectionResult> {
    const result = await super.connect(config);
    return { ...result, message: "Mock MT5 connected", externalAccountId: `MT5-${config.accountId.slice(0, 8)}` };
  }
}

export class MockCTraderAdapter extends PaperBrokerAdapter {
  override async connect(config: BrokerConnectionConfig): Promise<ConnectionResult> {
    const result = await super.connect(config);
    return { ...result, message: "Mock cTrader connected", externalAccountId: `CT-${config.accountId.slice(0, 8)}` };
  }
}

export class MockBinanceAdapter extends PaperBrokerAdapter {
  override async connect(config: BrokerConnectionConfig): Promise<ConnectionResult> {
    const result = await super.connect(config);
    return { ...result, message: "Mock Binance connected", externalAccountId: `BN-${config.accountId.slice(0, 8)}` };
  }
}

export class MockBybitAdapter extends PaperBrokerAdapter {
  override async connect(config: BrokerConnectionConfig): Promise<ConnectionResult> {
    const result = await super.connect(config);
    return { ...result, message: "Mock Bybit connected", externalAccountId: `BB-${config.accountId.slice(0, 8)}` };
  }
}

export function createBrokerAdapter(provider: string): BrokerAdapter {
  switch (provider) {
    case "MT4":
      return new MockMt4Adapter();
    case "MT5":
      return new MockMt5Adapter();
    case "CTRADER":
      return new MockCTraderAdapter();
    case "BINANCE":
      return new MockBinanceAdapter();
    case "BYBIT":
      return new MockBybitAdapter();
    case "CAPITAL":
      return new CapitalComAdapter();
    case "PAPER":
    default:
      return new PaperBrokerAdapter();
  }
}
