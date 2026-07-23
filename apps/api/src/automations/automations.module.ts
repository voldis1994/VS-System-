import { Module } from "@nestjs/common";
import { AutomationsService } from "./automations.service";
import { AutomationsController } from "./automations.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [AutomationsService],
  controllers: [AutomationsController],
  exports: [AutomationsService],
})
export class AutomationsModule {}
