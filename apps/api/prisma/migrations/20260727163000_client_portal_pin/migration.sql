-- AlterTable
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "clientPortalCode" TEXT;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "clientPortalPinHash" TEXT;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "clientPortalEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "clientPortalIssuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TradingAccount_clientPortalCode_key" ON "TradingAccount"("clientPortalCode");
CREATE INDEX IF NOT EXISTS "TradingAccount_clientPortalCode_idx" ON "TradingAccount"("clientPortalCode");
