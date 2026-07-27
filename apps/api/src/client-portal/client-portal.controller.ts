import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { ClientPortalStrategySchema, ErrorCodes } from "@nexus/domain";
import { HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";
import { AppError } from "../common/errors/app-error";
import { AccountsService } from "../accounts/accounts.service";
import { StrategiesService } from "../strategies/strategies.service";
import { MarketDataService } from "../market-data/market-data.service";
import { PrismaService } from "../prisma/prisma.service";

@Controller("client-portal")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ClientPortalController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly strategies: StrategiesService,
    private readonly market: MarketDataService,
    private readonly prisma: PrismaService,
  ) {}

  private requirePortalAccount(user: AuthUser): string {
    if (!user.clientPortal || !user.accountId) {
      throw new AppError(
        ErrorCodes.PERMISSION_DENIED,
        "Client portal session required",
        HttpStatus.FORBIDDEN,
      );
    }
    return user.accountId;
  }

  @Get("session")
  @RequirePermissions("accounts:read")
  async session(@Req() req: Request & { user: AuthUser }) {
    const accountId = this.requirePortalAccount(req.user);
    const account = await this.accounts.get(req.user.organizationId, accountId);
    const strategies = await this.strategies.list(req.user.organizationId);
    const strategy = strategies.find((s) =>
      ((s.assignedAccountIds as string[]) ?? []).includes(accountId),
    );
    const openPositions = await this.prisma.position.count({
      where: {
        organizationId: req.user.organizationId,
        accountId,
        status: { in: ["OPEN", "CLOSING", "PARTIALLY_CLOSED"] },
      },
    });
    return {
      account: this.accounts.sanitizeAccount(
        account as unknown as Record<string, unknown>,
      ),
      strategy: strategy
        ? {
            id: strategy.id,
            name: strategy.name,
            mode: strategy.mode,
            status: strategy.status,
            assignedSymbols: strategy.assignedSymbols,
            configuration: strategy.configurationJson,
          }
        : null,
      openPositions,
    };
  }

  @Get("markets")
  @RequirePermissions("accounts:read")
  markets(
    @Req() req: Request & { user: AuthUser },
    @Query("q") q?: string,
  ) {
    this.requirePortalAccount(req.user);
    return this.market.listCapitalMarkets(req.user.organizationId, q);
  }

  @Post("strategy")
  @RequirePermissions("strategies:run")
  strategy(
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
  ) {
    const accountId = this.requirePortalAccount(req.user);
    const input = ClientPortalStrategySchema.parse(body);
    return this.strategies.runForAccount(
      req.user.organizationId,
      req.user.userId,
      {
        accountId,
        mode: input.mode,
        configuration: input.configuration,
        assignedSymbols: input.assignedSymbols,
        action: input.action,
      },
      req.correlationId ?? "unknown",
    );
  }
}
