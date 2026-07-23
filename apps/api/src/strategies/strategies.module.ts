import { Module } from "@nestjs/common";
import { StrategiesService } from "./strategies.service";
import { StrategiesController } from "./strategies.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [StrategiesService],
  controllers: [StrategiesController],
  exports: [StrategiesService],
})
export class StrategiesModule {}
