import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { createBrokerAdapter, type BrokerAdapter } from "@nexus/broker-adapters";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class BrokerRuntimeService implements OnModuleInit {
  private readonly log = new Logger(BrokerRuntimeService.name);
  private readonly adapters = new Map<string, BrokerAdapter>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.restoreAll();
  }

  get(accountId: string): BrokerAdapter | undefined {
    return this.adapters.get(accountId);
  }

  async connectAccount(account: {
    id: string;
    provider: string;
    leverage: number;
    balance: Prisma.Decimal | string;
    baseCurrency: string;
    brokerStateJson?: Prisma.JsonValue | null;
  }): Promise<BrokerAdapter> {
    const existing = this.adapters.get(account.id);
    if (existing) return existing;

    const adapter = createBrokerAdapter(account.provider);
    await adapter.connect({
      accountId: account.id,
      leverage: account.leverage,
      startingBalance: String(account.balance),
      baseCurrency: account.baseCurrency,
    });

    if (
      account.brokerStateJson &&
      typeof account.brokerStateJson === "object" &&
      "hydrate" in adapter &&
      typeof adapter.hydrate === "function"
    ) {
      const state = account.brokerStateJson as {
        balance: string;
        leverage: number;
        currency: string;
        orders: unknown[];
        positions: unknown[];
      };
      adapter.hydrate(state as never);
    }

    this.adapters.set(account.id, adapter);
    this.log.log(`Broker adapter connected for account ${account.id}`);
    return adapter;
  }

  async persistState(accountId: string): Promise<void> {
    const adapter = this.adapters.get(accountId);
    if (!adapter || !("snapshot" in adapter) || typeof adapter.snapshot !== "function") {
      return;
    }
    const snapshot = adapter.snapshot();
    const state = await adapter.getAccountState();
    await this.prisma.tradingAccount.update({
      where: { id: accountId },
      data: {
        balance: state.balance,
        equity: state.equity,
        freeMargin: state.freeMargin,
        usedMargin: state.usedMargin,
        marginLevel: state.marginLevel,
        brokerStateJson: snapshot as Prisma.InputJsonValue,
        connectionStatus: "CONNECTED",
      },
    });
  }

  async restoreAll(): Promise<void> {
    const accounts = await this.prisma.tradingAccount.findMany({
      where: {
        status: { in: ["ACTIVE", "LOCKED"] },
        connectionStatus: { in: ["CONNECTED", "CONNECTING"] },
        archivedAt: null,
      },
    });
    for (const account of accounts) {
      try {
        await this.connectAccount(account);
        await this.persistState(account.id);
      } catch (err) {
        this.log.error(`Failed to restore account ${account.id}`, err as Error);
        await this.prisma.tradingAccount.update({
          where: { id: account.id },
          data: { connectionStatus: "ERROR" },
        });
      }
    }
  }

  async disconnect(accountId: string): Promise<void> {
    const adapter = this.adapters.get(accountId);
    if (adapter) {
      await this.persistState(accountId);
      await adapter.disconnect();
      this.adapters.delete(accountId);
    }
  }
}
