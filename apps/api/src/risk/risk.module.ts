import { Module } from "@nestjs/common";
import { RiskService } from "./risk.service";
import { RiskController } from "./risk.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [RiskService],
  controllers: [RiskController],
  exports: [RiskService],
})
export class RiskModule {}
