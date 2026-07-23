import { Module } from "@nestjs/common";
import { PositionsService } from "./positions.service";
import { PositionsController } from "./positions.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [PositionsService],
  controllers: [PositionsController],
  exports: [PositionsService],
})
export class PositionsModule {}
