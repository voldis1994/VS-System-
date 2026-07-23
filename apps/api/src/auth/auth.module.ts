import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { PermissionsGuard } from "../common/guards/permissions.guard";
import { loadEnv } from "@nexus/config";

const env = (() => {
  try {
    return loadEnv(process.env);
  } catch {
    return {
      JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret-change-me-32chars-min!!",
      JWT_EXPIRES_IN: "8h",
    };
  }
})();

@Module({
  imports: [
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { expiresIn: env.JWT_EXPIRES_IN },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, PermissionsGuard],
  exports: [AuthService, JwtAuthGuard, PermissionsGuard, JwtModule],
})
export class AuthModule {}
