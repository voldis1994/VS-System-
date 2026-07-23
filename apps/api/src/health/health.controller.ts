import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    let db = "up";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = "down";
    }
    return {
      status: db === "up" ? "ok" : "degraded",
      api: "up",
      db,
      redis: "optional",
      workers: "embedded",
      marketData: "up",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("system")
  async system() {
    const base = await this.check();
    return {
      ...base,
      queues: { order: "idle", report: "idle", notification: "idle" },
      brokerConnections: "runtime",
      lastBackup: null,
    };
  }
}
