import { Module, forwardRef } from "@nestjs/common";
import { StrategiesService } from "./strategies.service";
import { StrategiesController } from "./strategies.controller";
import { StrategyRuntimeService } from "./strategy-runtime.service";
import { AuthModule } from "../auth/auth.module";
import { OrdersModule } from "../orders/orders.module";
import { PositionsModule } from "../positions/positions.module";
import { MarketDataModule } from "../market-data/market-data.module";

@Module({
  imports: [
    AuthModule,
    forwardRef(() => OrdersModule),
    forwardRef(() => PositionsModule),
    MarketDataModule,
  ],
  providers: [StrategiesService, StrategyRuntimeService],
  controllers: [StrategiesController],
  exports: [StrategiesService, StrategyRuntimeService],
})
export class StrategiesModule {}
