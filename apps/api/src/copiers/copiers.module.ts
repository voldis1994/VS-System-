import { Module } from "@nestjs/common";
import { CopiersService } from "./copiers.service";
import { CopiersController } from "./copiers.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  providers: [CopiersService],
  controllers: [CopiersController],
  exports: [CopiersService],
})
export class CopiersModule {}
