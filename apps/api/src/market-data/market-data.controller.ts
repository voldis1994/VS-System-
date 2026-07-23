import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { MarketDataService } from "./market-data.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../common/guards/permissions.guard";

@Controller()
@UseGuards(JwtAuthGuard)
export class MarketDataController {
  constructor(private readonly market: MarketDataService) {}

  @Get("symbols")
  symbols(@Req() req: Request & { user: AuthUser }) {
    return this.market.listSymbols(req.user.organizationId);
  }

  @Get("market-data/ticks")
  ticks() {
    return this.market.listTicks();
  }

  @Get("market-data/:symbol/candles")
  candles(
    @Param("symbol") symbol: string,
    @Query("timeframe") timeframe = "1h",
    @Query("limit") limit = "200",
  ) {
    return this.market.getCandles(symbol, timeframe, Number(limit));
  }
}
