import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { createBrokerAdapter, type BrokerAdapter } from "@nexus/broker-adapters";
import { loadEnv } from "@nexus/config";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { decryptSecret } from "../common/crypto/crypto.util";

@Injectable()
export class BrokerRuntimeService implements OnModuleInit {
  private readonly log = new Logger(BrokerRuntimeService.name);
  private readonly adapters = new Map<string, BrokerAdapter>();
  private readonly env = (() => {
    try {
      return loadEnv(process.env);
    } catch {
      return { ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "" };
    }
  })();

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
    accountType?: string;
    leverage: number;
    balance: Prisma.Decimal | string;
    baseCurrency: string;
    brokerStateJson?: Prisma.JsonValue | null;
  }): Promise<BrokerAdapter> {
    const existing = this.adapters.get(account.id);
    if (existing) {
      // For Capital.com, refresh session by reconnecting if needed
      if (account.provider === "CAPITAL") {
        try {
          const health = await existing.healthCheck();
          if (health.healthy) return existing;
        } catch {
          this.adapters.delete(account.id);
        }
      } else {
        return existing;
      }
    }

    const credentials = await this.loadCredentials(account.id);
    // Account type is source of truth for Capital LIVE vs DEMO API host
    const resolvedCredentials =
      account.provider === "CAPITAL" && credentials
        ? {
            ...credentials,
            demo: account.accountType === "LIVE" ? "false" : "true",
          }
        : credentials;
    const adapter = createBrokerAdapter(account.provider);
    await adapter.connect({
      accountId: account.id,
      leverage: account.leverage,
      startingBalance: String(account.balance),
      baseCurrency: account.baseCurrency,
      credentials: resolvedCredentials,
    });

    if (
      account.provider === "PAPER" &&
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
    this.log.log(`Broker adapter connected for account ${account.id} (${account.provider})`);
    return adapter;
  }

  async persistState(accountId: string): Promise<void> {
    const adapter = this.adapters.get(accountId);
    if (!adapter) return;

    const state = await adapter.getAccountState();
    const data: Prisma.TradingAccountUpdateInput = {
      balance: state.balance,
      equity: state.equity,
      freeMargin: state.freeMargin,
      usedMargin: state.usedMargin,
      marginLevel: state.marginLevel,
      connectionStatus: "CONNECTED",
    };

    if ("snapshot" in adapter && typeof adapter.snapshot === "function") {
      data.brokerStateJson = adapter.snapshot() as Prisma.InputJsonValue;
    }

    await this.prisma.tradingAccount.update({
      where: { id: accountId },
      data,
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
        // Skip auto-restore of live Capital without explicit connect in this phase if preferred —
        // still attempt so server restart recovers DEMO sessions when credentials exist.
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
      try {
        await this.persistState(accountId);
      } catch {
        // ignore
      }
      await adapter.disconnect();
      this.adapters.delete(accountId);
    }
  }

  private async loadCredentials(
    accountId: string,
  ): Promise<Record<string, string> | undefined> {
    const cred = await this.prisma.brokerCredential.findUnique({
      where: { accountId },
    });
    if (!cred) return undefined;
    try {
      const plain = decryptSecret(cred.encryptedPayload, this.env.ENCRYPTION_KEY);
      return JSON.parse(plain) as Record<string, string>;
    } catch (err) {
      this.log.error(`Failed to decrypt credentials for ${accountId}`, err as Error);
      throw new Error(
        "Could not decrypt stored broker credentials (check ENCRYPTION_KEY). Update API credentials and reconnect.",
      );
    }
  }

  /** Drop in-memory adapter so next connect uses fresh credentials/session. */
  forget(accountId: string): void {
    this.adapters.delete(accountId);
  }
}
