import { Module } from "@nestjs/common";
import { ClientPortalController } from "./client-portal.controller";
import { AuthModule } from "../auth/auth.module";
import { AccountsModule } from "../accounts/accounts.module";
import { StrategiesModule } from "../strategies/strategies.module";
import { MarketDataModule } from "../market-data/market-data.module";

@Module({
  imports: [AuthModule, AccountsModule, StrategiesModule, MarketDataModule],
  controllers: [ClientPortalController],
})
export class ClientPortalModule {}
