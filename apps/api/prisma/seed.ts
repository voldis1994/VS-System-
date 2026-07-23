import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";
import { permissionsForRole, Role } from "@nexus/domain";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_OWNER_EMAIL ?? "owner@nexus.pro";
  const password = process.env.SEED_OWNER_PASSWORD ?? "NexusOwner123!";
  const pin = process.env.SEED_TRADING_PIN ?? "123456";

  let org = await prisma.organization.findUnique({ where: { slug: "nexus-demo" } });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: "NEXUS Demo",
        slug: "nexus-demo",
        defaultCurrency: "USD",
        timezone: "UTC",
      },
    });
  }

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password),
        firstName: "Trader",
        lastName: "X",
        tradingPinHash: await argon2.hash(pin),
      },
    });
  }

  await prisma.membership.upsert({
    where: {
      organizationId_userId: { organizationId: org.id, userId: user.id },
    },
    create: {
      organizationId: org.id,
      userId: user.id,
      role: Role.OWNER,
      permissionsJson: permissionsForRole(Role.OWNER),
    },
    update: { role: Role.OWNER },
  });

  const symbolCount = await prisma.symbol.count({ where: { organizationId: org.id } });
  if (symbolCount === 0) {
    await prisma.symbol.create({
      data: {
        organizationId: org.id,
        provider: "PAPER",
        canonicalSymbol: "EURUSD",
        brokerSymbol: "EURUSD",
        assetClass: "FOREX",
        baseAsset: "EUR",
        quoteAsset: "USD",
        pricePrecision: 5,
        volumePrecision: 2,
        minVolume: "0.01",
        maxVolume: "100",
        volumeStep: "0.01",
        tickSize: "0.00001",
        tickValue: "1",
        contractSize: "100000",
        minStopDistance: "0.00010",
        tradingHoursJson: { alwaysOpen: true },
      },
    });
  }

  const riskCount = await prisma.riskProfile.count({ where: { organizationId: org.id } });
  if (riskCount === 0) {
    await prisma.riskProfile.create({
      data: {
        organizationId: org.id,
        name: "Default",
        scope: "ORGANIZATION",
        priority: 1,
        limitsJson: {
          maxDailyRiskPercent: 5,
          maxTotalRiskPercent: 15,
          riskPerTradePercent: 1.5,
          maxDrawdownPercent: 20,
          maxOpenTrades: 50,
        },
        protectionRulesJson: { equityProtection: true },
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded owner ${email} / org ${org.slug}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
