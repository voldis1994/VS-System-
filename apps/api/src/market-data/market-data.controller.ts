import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { MarketDataService } from "./market-data.service";
import { NewsCalendarService } from "./news-calendar.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthUser,
} from "../common/guards/permissions.guard";

@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MarketDataController {
  constructor(
    private readonly market: MarketDataService,
    private readonly news: NewsCalendarService,
  ) {}

  @Get("symbols")
  @RequirePermissions("accounts:read")
  symbols(@Req() req: Request & { user: AuthUser }) {
    return this.market.listSymbols(req.user.organizationId);
  }

  @Get("market-data/ticks")
  @RequirePermissions("accounts:read")
  ticks() {
    return this.market.listTicks();
  }

  @Get("market-data/feed")
  @RequirePermissions("accounts:read")
  feed() {
    return this.market.getFeedStatus();
  }

  @Get("market-data/news")
  @RequirePermissions("accounts:read")
  async newsCalendar(
    @Query("symbol") symbol?: string,
    @Query("hours") hours = "48",
  ) {
    const events = await this.news.upcoming(symbol, Number(hours) || 48);
    return {
      source: "forexfactory",
      count: events.length,
      events,
    };
  }

  @Get("market-data/news/block")
  @RequirePermissions("accounts:read")
  async newsBlock(
    @Query("symbol") symbol = "EURUSD",
    @Query("before") before = "30",
    @Query("after") after = "15",
    @Query("minImpact") minImpact: "Medium" | "High" = "High",
  ) {
    return this.news.isBlocked({
      symbol,
      minutesBefore: Number(before) || 30,
      minutesAfter: Number(after) || 15,
      minImpact,
      enabled: true,
    });
  }

  @Get("market-data/:symbol/candles")
  @RequirePermissions("accounts:read")
  candles(
    @Param("symbol") symbol: string,
    @Query("timeframe") timeframe = "1h",
    @Query("limit") limit = "200",
  ) {
    return this.market.getCandles(symbol, timeframe, Number(limit));
  }

  @Get("capital/markets")
  @RequirePermissions("accounts:read")
  capitalMarkets(
    @Req() req: Request & { user: AuthUser },
    @Query("q") q?: string,
  ) {
    return this.market.listCapitalMarkets(req.user.organizationId, q);
  }

  @Post("capital/markets/sync")
  @RequirePermissions("accounts:manage")
  syncCapital(@Req() req: Request & { user: AuthUser }) {
    return this.market.syncCapitalMarkets(req.user.organizationId);
  }
}
