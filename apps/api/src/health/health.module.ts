import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { ReportsController } from "./reports.controller";
import { JournalController } from "./journal.controller";
import { AuthModule } from "../auth/auth.module";
import { AnalyticsModule } from "../analytics/analytics.module";

@Module({
  imports: [AuthModule, AnalyticsModule],
  controllers: [HealthController, ReportsController, JournalController],
})
export class HealthModule {}
