-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'TRADER', 'RISK_MANAGER', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'PENDING');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'LOCKED', 'DISCONNECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'CONNECTING', 'ERROR');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('PAPER', 'DEMO', 'LIVE', 'PROP');

-- CreateEnum
CREATE TYPE "PermissionMode" AS ENUM ('FULL', 'READ_ONLY', 'CLOSE_ONLY');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "OrderDirection" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'VALIDATING', 'REJECTED', 'QUEUED', 'SENT', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'MODIFY_REQUESTED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('MANUAL', 'STRATEGY', 'COPIER', 'AUTOMATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSING', 'PARTIALLY_CLOSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "StrategyMode" AS ENUM ('TREND', 'RANGE', 'BREAKOUT', 'SCALPING', 'MOMENTUM', 'MEAN_REVERSION', 'PULLBACK', 'REVERSAL', 'GRID', 'DCA', 'NEWS', 'SESSION', 'ARBITRAGE_SIM', 'MARKET_MAKING_SIM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "StrategyStatus" AS ENUM ('DRAFT', 'VALIDATING', 'VALID', 'INVALID', 'DEPLOYING', 'RUNNING', 'PAUSED', 'STOPPING', 'STOPPED', 'ERROR', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('PAPER', 'MT4', 'MT5', 'CTRADER', 'BINANCE', 'BYBIT');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecretEncrypted" TEXT,
    "tradingPinHash" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "permissionsJson" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "Provider" NOT NULL DEFAULT 'PAPER',
    "platform" TEXT NOT NULL DEFAULT 'PAPER',
    "accountType" "AccountType" NOT NULL DEFAULT 'PAPER',
    "externalAccountId" TEXT,
    "serverName" TEXT,
    "baseCurrency" TEXT NOT NULL DEFAULT 'USD',
    "balance" DECIMAL(24,8) NOT NULL,
    "equity" DECIMAL(24,8) NOT NULL,
    "freeMargin" DECIMAL(24,8) NOT NULL,
    "usedMargin" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "marginLevel" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "leverage" INTEGER NOT NULL DEFAULT 100,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "permissionMode" "PermissionMode" NOT NULL DEFAULT 'FULL',
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "liveTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dayStartEquity" DECIMAL(24,8) NOT NULL,
    "realizedPnlToday" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "peakEquity" DECIMAL(24,8) NOT NULL,
    "groupId" TEXT,
    "riskProfileId" TEXT,
    "brokerStateJson" JSONB,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerCredential" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastValidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "balance" DECIMAL(24,8) NOT NULL,
    "equity" DECIMAL(24,8) NOT NULL,
    "margin" DECIMAL(24,8) NOT NULL,
    "freeMargin" DECIMAL(24,8) NOT NULL,
    "floatingPnl" DECIMAL(24,8) NOT NULL,
    "drawdown" DECIMAL(24,8) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#7C3AED',
    "filtersJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Symbol" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL DEFAULT 'PAPER',
    "canonicalSymbol" TEXT NOT NULL,
    "brokerSymbol" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL,
    "baseAsset" TEXT NOT NULL,
    "quoteAsset" TEXT NOT NULL,
    "pricePrecision" INTEGER NOT NULL,
    "volumePrecision" INTEGER NOT NULL,
    "minVolume" DECIMAL(24,8) NOT NULL,
    "maxVolume" DECIMAL(24,8) NOT NULL,
    "volumeStep" DECIMAL(24,8) NOT NULL,
    "tickSize" DECIMAL(24,8) NOT NULL,
    "tickValue" DECIMAL(24,8) NOT NULL,
    "contractSize" DECIMAL(24,8) NOT NULL,
    "minStopDistance" DECIMAL(24,8) NOT NULL,
    "tradingHoursJson" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Symbol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "brokerOrderId" TEXT,
    "clientRequestId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "type" "OrderType" NOT NULL,
    "direction" "OrderDirection" NOT NULL,
    "requestedVolume" DECIMAL(24,8) NOT NULL,
    "filledVolume" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "requestedPrice" DECIMAL(24,8),
    "averageFillPrice" DECIMAL(24,8),
    "stopLoss" DECIMAL(24,8),
    "takeProfit" DECIMAL(24,8),
    "takeProfitsJson" JSONB,
    "trailingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "trailingDistance" DECIMAL(24,8),
    "breakEvenEnabled" BOOLEAN NOT NULL DEFAULT false,
    "breakEvenActivation" DECIMAL(24,8),
    "breakEvenOffset" DECIMAL(24,8),
    "status" "OrderStatus" NOT NULL,
    "source" "OrderSource" NOT NULL DEFAULT 'MANUAL',
    "strategyId" TEXT,
    "copierParentId" TEXT,
    "automationId" TEXT,
    "batchId" TEXT,
    "rejectionCode" TEXT,
    "rejectionMessage" TEXT,
    "comment" TEXT,
    "tagsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT,
    "brokerPositionId" TEXT,
    "symbol" TEXT NOT NULL,
    "direction" "OrderDirection" NOT NULL,
    "volume" DECIMAL(24,8) NOT NULL,
    "averageEntry" DECIMAL(24,8) NOT NULL,
    "currentPrice" DECIMAL(24,8) NOT NULL,
    "stopLoss" DECIMAL(24,8),
    "takeProfit" DECIMAL(24,8),
    "unrealizedPnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "commission" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "swap" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "source" "OrderSource" NOT NULL DEFAULT 'MANUAL',
    "strategyId" TEXT,
    "trailingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "trailingDistance" DECIMAL(24,8),
    "breakEvenEnabled" BOOLEAN NOT NULL DEFAULT false,
    "breakEvenActivation" DECIMAL(24,8),
    "breakEvenOffset" DECIMAL(24,8),
    "breakEvenActivatedAt" TIMESTAMP(3),
    "trailingActivatedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "StrategyMode" NOT NULL,
    "status" "StrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "configurationJson" JSONB NOT NULL,
    "validationStateJson" JSONB,
    "deploymentStateJson" JSONB,
    "assignedAccountIds" JSONB NOT NULL DEFAULT '[]',
    "assignedSymbols" JSONB NOT NULL DEFAULT '[]',
    "scheduleJson" JSONB,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'ACCOUNT',
    "accountId" TEXT,
    "groupId" TEXT,
    "riskModel" TEXT NOT NULL DEFAULT 'EQUITY_PERCENT',
    "limitsJson" JSONB NOT NULL,
    "protectionRulesJson" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopierConfiguration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "masterAccountId" TEXT NOT NULL,
    "followersJson" JSONB NOT NULL,
    "mappingJson" JSONB NOT NULL DEFAULT '{}',
    "copyRulesJson" JSONB NOT NULL,
    "executionRulesJson" JSONB NOT NULL,
    "riskLimitsJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopierConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "triggerJson" JSONB NOT NULL,
    "conditionTreeJson" JSONB NOT NULL,
    "actionListJson" JSONB NOT NULL,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "scheduleJson" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "retryPolicyJson" JSONB,
    "failurePolicy" TEXT NOT NULL DEFAULT 'NOTIFY',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "nextEligibleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" TEXT NOT NULL,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 300,
    "channelsJson" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "sourceIp" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEventRecord" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "payloadJson" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainEventRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "readAt" TIMESTAMP(3),
    "metaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT,
    "setup" TEXT,
    "thesis" TEXT,
    "emotion" TEXT,
    "executionScore" INTEGER,
    "mistake" TEXT,
    "lesson" TEXT,
    "tagsJson" JSONB,
    "rating" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customFieldsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "paramsJson" JSONB NOT NULL,
    "resultPath" TEXT,
    "errorMessage" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketTick" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "bid" DECIMAL(24,8) NOT NULL,
    "ask" DECIMAL(24,8) NOT NULL,
    "mid" DECIMAL(24,8) NOT NULL,
    "spread" DECIMAL(24,8) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketTick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "open" DECIMAL(24,8) NOT NULL,
    "high" DECIMAL(24,8) NOT NULL,
    "low" DECIMAL(24,8) NOT NULL,
    "close" DECIMAL(24,8) NOT NULL,
    "volume" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "openTime" TIMESTAMP(3) NOT NULL,
    "closeTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_organizationId_idx" ON "Session"("organizationId");

-- CreateIndex
CREATE INDEX "TradingAccount_organizationId_idx" ON "TradingAccount"("organizationId");

-- CreateIndex
CREATE INDEX "TradingAccount_status_idx" ON "TradingAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerCredential_accountId_key" ON "BrokerCredential"("accountId");

-- CreateIndex
CREATE INDEX "AccountSnapshot_accountId_timestamp_idx" ON "AccountSnapshot"("accountId", "timestamp");

-- CreateIndex
CREATE INDEX "Symbol_organizationId_canonicalSymbol_idx" ON "Symbol"("organizationId", "canonicalSymbol");

-- CreateIndex
CREATE UNIQUE INDEX "Symbol_organizationId_provider_brokerSymbol_key" ON "Symbol"("organizationId", "provider", "brokerSymbol");

-- CreateIndex
CREATE INDEX "Order_organizationId_status_idx" ON "Order"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Order_accountId_idx" ON "Order"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_organizationId_clientRequestId_accountId_key" ON "Order"("organizationId", "clientRequestId", "accountId");

-- CreateIndex
CREATE INDEX "Position_organizationId_status_idx" ON "Position"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Position_accountId_status_idx" ON "Position"("accountId", "status");

-- CreateIndex
CREATE INDEX "Strategy_organizationId_status_idx" ON "Strategy"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RiskProfile_organizationId_idx" ON "RiskProfile"("organizationId");

-- CreateIndex
CREATE INDEX "CopierConfiguration_organizationId_idx" ON "CopierConfiguration"("organizationId");

-- CreateIndex
CREATE INDEX "Automation_organizationId_enabled_idx" ON "Automation"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "Alert_organizationId_enabled_idx" ON "Alert"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEventRecord_eventId_key" ON "DomainEventRecord"("eventId");

-- CreateIndex
CREATE INDEX "DomainEventRecord_organizationId_eventType_timestamp_idx" ON "DomainEventRecord"("organizationId", "eventType", "timestamp");

-- CreateIndex
CREATE INDEX "DomainEventRecord_aggregateId_idx" ON "DomainEventRecord"("aggregateId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_userId_createdAt_idx" ON "Notification"("organizationId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_organizationId_userId_idx" ON "JournalEntry"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "ReportJob_organizationId_status_idx" ON "ReportJob"("organizationId", "status");

-- CreateIndex
CREATE INDEX "MarketTick_symbol_timestamp_idx" ON "MarketTick"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "Candle_symbol_timeframe_openTime_idx" ON "Candle"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_symbol_timeframe_openTime_key" ON "Candle"("symbol", "timeframe", "openTime");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccountGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_riskProfileId_fkey" FOREIGN KEY ("riskProfileId") REFERENCES "RiskProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerCredential" ADD CONSTRAINT "BrokerCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSnapshot" ADD CONSTRAINT "AccountSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Symbol" ADD CONSTRAINT "Symbol_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskProfile" ADD CONSTRAINT "RiskProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopierConfiguration" ADD CONSTRAINT "CopierConfiguration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEventRecord" ADD CONSTRAINT "DomainEventRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportJob" ADD CONSTRAINT "ReportJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
