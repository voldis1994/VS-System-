import { Module } from "@nestjs/common";
import { NexusGateway } from "./nexus.gateway";
import { AuthModule } from "../auth/auth.module";
import { MarketDataModule } from "../market-data/market-data.module";

@Module({
  imports: [AuthModule, MarketDataModule],
  providers: [NexusGateway],
})
export class WsModule {}
