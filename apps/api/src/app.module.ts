import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { EventBusModule } from "./events/event-bus.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { AccountsModule } from "./accounts/accounts.module";
import { OrdersModule } from "./orders/orders.module";
import { PositionsModule } from "./positions/positions.module";
import { MarketDataModule } from "./market-data/market-data.module";
import { RiskModule } from "./risk/risk.module";
import { StrategiesModule } from "./strategies/strategies.module";
import { CopiersModule } from "./copiers/copiers.module";
import { AutomationsModule } from "./automations/automations.module";
import { AlertsModule } from "./alerts/alerts.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { HealthModule } from "./health/health.module";
import { WsModule } from "./ws/ws.module";
import { BrokerRuntimeModule } from "./broker-runtime/broker-runtime.module";

@Module({
  imports: [
    PrismaModule,
    EventBusModule,
    AuditModule,
    AuthModule,
    OrganizationsModule,
    AccountsModule,
    BrokerRuntimeModule,
    OrdersModule,
    PositionsModule,
    MarketDataModule,
    RiskModule,
    StrategiesModule,
    CopiersModule,
    AutomationsModule,
    AlertsModule,
    AnalyticsModule,
    NotificationsModule,
    HealthModule,
    WsModule,
  ],
})
export class AppModule {}
