import { Injectable, HttpStatus } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import {
  ErrorCodes,
  LoginSchema,
  RegisterSchema,
  Verify2FASchema,
  VerifyTradingPinSchema,
  permissionsForRole,
  Role,
} from "@nexus/domain";
import { newId } from "@nexus/shared";
import { loadEnv } from "@nexus/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AppError } from "../common/errors/app-error";
import { decryptSecret, encryptSecret, hashToken } from "../common/crypto/crypto.util";
import { Prisma } from "@prisma/client";

@Injectable()
export class AuthService {
  private readonly env = loadEnv(process.env);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async register(raw: unknown, meta: { ip?: string; ua?: string; correlationId: string }) {
    const input = RegisterSchema.parse(raw);
    const existingUser = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (existingUser) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, "Email already registered");
    }
    const existingOrg = await this.prisma.organization.findUnique({
      where: { slug: input.organizationSlug },
    });
    if (existingOrg) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, "Organization slug taken");
    }

    const passwordHash = await argon2.hash(input.password);
    const tradingPinHash = await argon2.hash(input.tradingPin);

    const result = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.organizationName,
          slug: input.organizationSlug,
          timezone: input.timezone,
          defaultCurrency: input.defaultCurrency,
        },
      });
      const user = await tx.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          tradingPinHash,
        },
      });
      await tx.membership.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          role: Role.OWNER,
          permissionsJson: permissionsForRole(Role.OWNER),
        },
      });
      await this.seedDefaultSymbols(tx, org.id);
      await this.seedDefaultRiskProfile(tx, org.id);
      return { org, user };
    });

    await this.audit.record({
      organizationId: result.org.id,
      actorId: result.user.id,
      action: "AUTH_REGISTER",
      resourceType: "Organization",
      resourceId: result.org.id,
      after: { slug: result.org.slug, email: result.user.email },
      sourceIp: meta.ip,
      userAgent: meta.ua,
      correlationId: meta.correlationId,
    });

    const tokens = await this.issueTokens({
      userId: result.user.id,
      email: result.user.email,
      organizationId: result.org.id,
      role: Role.OWNER,
      tradingPinVerified: false,
      ip: meta.ip,
      ua: meta.ua,
    });

    return {
      user: this.publicUser(result.user),
      organization: result.org,
      ...tokens,
      requires2FA: false,
    };
  }

  async login(raw: unknown, meta: { ip?: string; ua?: string; correlationId: string }) {
    const input = LoginSchema.parse(raw);
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
      include: { memberships: { include: { organization: true } } },
    });
    if (!user) {
      throw new AppError(
        ErrorCodes.AUTH_INVALID_CREDENTIALS,
        "Invalid credentials",
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(
        ErrorCodes.AUTH_BRUTE_FORCE_LOCKED,
        "Account temporarily locked",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const valid = await argon2.verify(user.passwordHash, input.password);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
        },
      });
      throw new AppError(
        ErrorCodes.AUTH_INVALID_CREDENTIALS,
        "Invalid credentials",
        HttpStatus.UNAUTHORIZED,
      );
    }

    let membership = user.memberships[0];
    if (input.organizationSlug) {
      membership =
        user.memberships.find((m) => m.organization.slug === input.organizationSlug) ??
        membership;
    }
    if (!membership) {
      throw new AppError(ErrorCodes.PERMISSION_DENIED, "No organization membership");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    if (user.twoFactorEnabled) {
      const challengeToken = this.jwt.sign(
        {
          sub: user.id,
          organizationId: membership.organizationId,
          role: membership.role,
          email: user.email,
          purpose: "2fa",
        },
        { expiresIn: "5m" },
      );
      await this.audit.record({
        organizationId: membership.organizationId,
        actorId: user.id,
        action: "AUTH_LOGIN_2FA_CHALLENGE",
        resourceType: "User",
        resourceId: user.id,
        sourceIp: meta.ip,
        userAgent: meta.ua,
        correlationId: meta.correlationId,
      });
      return {
        requires2FA: true,
        challengeToken,
        user: this.publicUser(user),
        organization: membership.organization,
      };
    }

    const tokens = await this.issueTokens({
      userId: user.id,
      email: user.email,
      organizationId: membership.organizationId,
      role: membership.role as Role,
      tradingPinVerified: false,
      ip: meta.ip,
      ua: meta.ua,
    });

    await this.audit.record({
      organizationId: membership.organizationId,
      actorId: user.id,
      action: "AUTH_LOGIN",
      resourceType: "User",
      resourceId: user.id,
      sourceIp: meta.ip,
      userAgent: meta.ua,
      correlationId: meta.correlationId,
    });

    return {
      requires2FA: false,
      user: this.publicUser(user),
      organization: membership.organization,
      role: membership.role,
      ...tokens,
    };
  }

  async verify2FA(raw: unknown, meta: { ip?: string; ua?: string; correlationId: string }) {
    const input = Verify2FASchema.parse(raw);
    let payload: {
      sub: string;
      organizationId: string;
      role: Role;
      email: string;
      purpose?: string;
    };
    try {
      payload = this.jwt.verify(input.challengeToken);
    } catch {
      throw new AppError(ErrorCodes.AUTH_2FA_INVALID, "Invalid challenge", HttpStatus.UNAUTHORIZED);
    }
    if (payload.purpose !== "2fa") {
      throw new AppError(ErrorCodes.AUTH_2FA_INVALID, "Invalid challenge purpose");
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.twoFactorSecretEncrypted) {
      throw new AppError(ErrorCodes.AUTH_2FA_INVALID, "2FA not configured");
    }
    const secret = decryptSecret(user.twoFactorSecretEncrypted, this.env.ENCRYPTION_KEY);
    const ok = authenticator.check(input.code, secret);
    if (!ok) {
      throw new AppError(ErrorCodes.AUTH_2FA_INVALID, "Invalid 2FA code", HttpStatus.UNAUTHORIZED);
    }
    const tokens = await this.issueTokens({
      userId: user.id,
      email: user.email,
      organizationId: payload.organizationId,
      role: payload.role,
      tradingPinVerified: false,
      ip: meta.ip,
      ua: meta.ua,
    });
    await this.audit.record({
      organizationId: payload.organizationId,
      actorId: user.id,
      action: "AUTH_2FA_VERIFIED",
      resourceType: "User",
      resourceId: user.id,
      sourceIp: meta.ip,
      userAgent: meta.ua,
      correlationId: meta.correlationId,
    });
    return { ...tokens, requires2FA: false, user: this.publicUser(user) };
  }

  async verifyTradingPin(
    userId: string,
    organizationId: string,
    role: Role,
    email: string,
    raw: unknown,
    meta: { correlationId: string; ip?: string; ua?: string },
  ) {
    const input = VerifyTradingPinSchema.parse(raw);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, "User not found");
    }
    const ok = await argon2.verify(user.tradingPinHash, input.pin);
    if (!ok) {
      throw new AppError(
        ErrorCodes.AUTH_TRADING_PIN_INVALID,
        "Invalid trading PIN",
        HttpStatus.UNAUTHORIZED,
      );
    }
    const tokens = await this.issueTokens({
      userId,
      email,
      organizationId,
      role,
      tradingPinVerified: true,
      ip: meta.ip,
      ua: meta.ua,
    });
    await this.audit.record({
      organizationId,
      actorId: userId,
      action: "AUTH_TRADING_PIN_VERIFIED",
      resourceType: "User",
      resourceId: userId,
      sourceIp: meta.ip,
      userAgent: meta.ua,
      correlationId: meta.correlationId,
    });
    return tokens;
  }

  async enable2FA(userId: string, organizationId: string, correlationId: string) {
    const secret = authenticator.generateSecret();
    const encrypted = encryptSecret(secret, this.env.ENCRYPTION_KEY);
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecretEncrypted: encrypted, twoFactorEnabled: true },
    });
    await this.audit.record({
      organizationId,
      actorId: userId,
      action: "AUTH_2FA_ENABLED",
      resourceType: "User",
      resourceId: userId,
      correlationId,
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, "VS System", secret),
    };
  }

  async logout(userId: string, organizationId: string, correlationId: string) {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      organizationId,
      actorId: userId,
      action: "AUTH_LOGOUT",
      resourceType: "User",
      resourceId: userId,
      correlationId,
    });
    return { ok: true };
  }

  async me(userId: string, organizationId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const membership = await this.prisma.membership.findUniqueOrThrow({
      where: {
        organizationId_userId: { organizationId, userId },
      },
      include: { organization: true },
    });
    return {
      user: this.publicUser(user),
      organization: membership.organization,
      role: membership.role,
      permissions: permissionsForRole(membership.role as Role),
    };
  }

  private async issueTokens(input: {
    userId: string;
    email: string;
    organizationId: string;
    role: Role;
    tradingPinVerified: boolean;
    ip?: string;
    ua?: string;
  }) {
    const accessToken = this.jwt.sign({
      sub: input.userId,
      email: input.email,
      organizationId: input.organizationId,
      role: input.role,
      tradingPinVerified: input.tradingPinVerified,
    });
    const refreshToken = newId() + newId();
    await this.prisma.session.create({
      data: {
        userId: input.userId,
        organizationId: input.organizationId,
        refreshTokenHash: hashToken(refreshToken),
        ipAddress: input.ip,
        userAgent: input.ua,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      },
    });
    return { accessToken, refreshToken };
  }

  private publicUser(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    twoFactorEnabled: boolean;
    lastLoginAt: Date | null;
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      twoFactorEnabled: user.twoFactorEnabled,
      lastLoginAt: user.lastLoginAt,
    };
  }

  private async seedDefaultSymbols(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ) {
    const defaults = [
      {
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
      },
      {
        canonicalSymbol: "XAUUSD",
        brokerSymbol: "XAUUSD",
        assetClass: "METALS",
        baseAsset: "XAU",
        quoteAsset: "USD",
        pricePrecision: 2,
        volumePrecision: 2,
        minVolume: "0.01",
        maxVolume: "50",
        volumeStep: "0.01",
        tickSize: "0.01",
        tickValue: "1",
        contractSize: "100",
        minStopDistance: "0.50",
      },
      {
        canonicalSymbol: "BTCUSD",
        brokerSymbol: "BTCUSD",
        assetClass: "CRYPTO",
        baseAsset: "BTC",
        quoteAsset: "USD",
        pricePrecision: 2,
        volumePrecision: 3,
        minVolume: "0.001",
        maxVolume: "10",
        volumeStep: "0.001",
        tickSize: "0.01",
        tickValue: "1",
        contractSize: "1",
        minStopDistance: "50",
      },
      {
        canonicalSymbol: "NASDAQ100",
        brokerSymbol: "NAS100",
        assetClass: "INDICES",
        baseAsset: "NAS100",
        quoteAsset: "USD",
        pricePrecision: 2,
        volumePrecision: 2,
        minVolume: "0.1",
        maxVolume: "50",
        volumeStep: "0.1",
        tickSize: "0.25",
        tickValue: "1",
        contractSize: "1",
        minStopDistance: "2",
      },
      {
        canonicalSymbol: "US30",
        brokerSymbol: "US30",
        assetClass: "INDICES",
        baseAsset: "US30",
        quoteAsset: "USD",
        pricePrecision: 2,
        volumePrecision: 2,
        minVolume: "0.1",
        maxVolume: "50",
        volumeStep: "0.1",
        tickSize: "1",
        tickValue: "1",
        contractSize: "1",
        minStopDistance: "5",
      },
    ];
    for (const s of defaults) {
      await tx.symbol.create({
        data: {
          organizationId,
          provider: "PAPER",
          tradingHoursJson: { alwaysOpen: true },
          ...s,
        },
      });
    }
  }

  private async seedDefaultRiskProfile(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ) {
    await tx.riskProfile.create({
      data: {
        organizationId,
        name: "Default Organization Limits",
        scope: "ORGANIZATION",
        riskModel: "EQUITY_PERCENT",
        priority: 1,
        limitsJson: {
          maxDailyRiskPercent: 5,
          maxTotalRiskPercent: 15,
          riskPerTradePercent: 1.5,
          maxDrawdownPercent: 20,
          maxOpenTrades: 50,
          maxCorrelation: 70,
        },
        protectionRulesJson: {
          equityProtection: true,
          newsFilter: false,
          spreadFilter: true,
          autoStopTrading: true,
          autoReduceRisk: true,
        },
      },
    });
  }
}
