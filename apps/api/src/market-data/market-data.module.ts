import { Module } from "@nestjs/common";
import { MarketDataService } from "./market-data.service";
import { MarketDataController } from "./market-data.controller";
import { NewsCalendarService } from "./news-calendar.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [MarketDataService, NewsCalendarService],
  controllers: [MarketDataController],
  exports: [MarketDataService, NewsCalendarService],
})
export class MarketDataModule {}
