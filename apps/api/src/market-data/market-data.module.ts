import { Module } from "@nestjs/common";
import { MarketDataService } from "./market-data.service";
import { MarketDataController } from "./market-data.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [MarketDataService],
  controllers: [MarketDataController],
  exports: [MarketDataService],
})
export class MarketDataModule {}
