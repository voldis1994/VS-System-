import { Module } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { AuthModule } from "../auth/auth.module";
import { RiskModule } from "../risk/risk.module";
import { MarketDataModule } from "../market-data/market-data.module";

@Module({
  imports: [AuthModule, RiskModule, MarketDataModule],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
