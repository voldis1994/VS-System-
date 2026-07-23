import { z } from "zod";
import {
  AccountType,
  ExecutionPolicy,
  OrderDirection,
  OrderType,
  Provider,
  Role,
  StrategyMode,
  VolumeMode,
} from "./enums";

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  organizationSlug: z.string().min(2).max(64).optional(),
});

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(10)
    .max(128)
    .regex(/[A-Z]/, "Must contain uppercase")
    .regex(/[a-z]/, "Must contain lowercase")
    .regex(/[0-9]/, "Must contain digit"),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  organizationName: z.string().min(2).max(120),
  organizationSlug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  timezone: z.string().default("UTC"),
  defaultCurrency: z.string().length(3).default("USD"),
  tradingPin: z.string().regex(/^\d{6}$/, "Trading PIN must be 6 digits"),
});

export const Verify2FASchema = z.object({
  challengeToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/),
});

export const VerifyTradingPinSchema = z.object({
  pin: z.string().regex(/^\d{6}$/),
});

export const CreateAccountSchema = z.object({
  name: z.string().min(2).max(120),
  provider: z.nativeEnum(Provider).default(Provider.PAPER),
  platform: z.string().min(2).max(40).default("PAPER"),
  accountType: z.nativeEnum(AccountType).default(AccountType.PAPER),
  baseCurrency: z.string().length(3).default("USD"),
  leverage: z.number().int().min(1).max(1000).default(100),
  startingBalance: z.string().regex(/^\d+(\.\d{1,8})?$/).default("100000"),
  externalAccountId: z.string().optional(),
  serverName: z.string().optional(),
  credentials: z
    .object({
      apiKey: z.string().min(8),
      identifier: z.string().min(3),
      password: z.string().min(4),
      demo: z.boolean().default(true),
    })
    .optional(),
});

export const UpdateAccountCredentialsSchema = z.object({
  apiKey: z.string().min(8),
  identifier: z.string().min(3),
  password: z.string().min(4),
  demo: z.boolean().optional(),
});

export const PlaceOrderSchema = z.object({
  clientRequestId: z.string().uuid(),
  accountIds: z.array(z.string().uuid()).min(1),
  symbol: z.string().min(2).max(32),
  type: z.nativeEnum(OrderType),
  direction: z.nativeEnum(OrderDirection),
  volumeMode: z.nativeEnum(VolumeMode).default(VolumeMode.FIXED_LOT),
  volume: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
  riskPercent: z.number().min(0.01).max(100).optional(),
  entryPrice: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
  stopLoss: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
  takeProfit: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
  takeProfits: z
    .array(
      z.object({
        price: z.string().regex(/^\d+(\.\d{1,8})?$/),
        closePercent: z.number().min(0.01).max(100),
      }),
    )
    .optional(),
  trailingEnabled: z.boolean().default(false),
  trailingDistance: z.string().optional(),
  breakEvenEnabled: z.boolean().default(false),
  breakEvenActivation: z.string().optional(),
  breakEvenOffset: z.string().optional(),
  comment: z.string().max(255).optional(),
  tags: z.array(z.string()).optional(),
  strategyId: z.string().uuid().optional(),
  executionPolicy: z.nativeEnum(ExecutionPolicy).default(ExecutionPolicy.BEST_EFFORT),
  confirmSoftWarnings: z.boolean().default(false),
});

export const ModifySlTpSchema = z.object({
  stopLoss: z.string().regex(/^\d+(\.\d{1,8})?$/).nullable().optional(),
  takeProfit: z.string().regex(/^\d+(\.\d{1,8})?$/).nullable().optional(),
});

export const PartialCloseSchema = z.object({
  volume: z.string().regex(/^\d+(\.\d{1,8})?$/),
  clientRequestId: z.string().uuid(),
});

export const ClosePositionSchema = z.object({
  clientRequestId: z.string().uuid(),
});

export const StrategyExitConfigSchema = z.object({
  takeProfitEnabled: z.boolean().default(true),
  atrTpMult: z.number().min(0.1).max(20).optional(),
  takeProfitPips: z.number().min(1).max(5000).optional(),
  atrStopMult: z.number().min(0.1).max(20).optional(),
  stopDistancePips: z.number().min(1).max(5000).optional(),
  breakEvenEnabled: z.boolean().default(false),
  breakEvenActivationPips: z.number().min(1).max(2000).default(10),
  breakEvenOffsetPips: z.number().min(0).max(500).default(1),
  trailingEnabled: z.boolean().default(false),
  trailingDistancePips: z.number().min(1).max(2000).default(15),
  trailingActivationPips: z.number().min(0).max(2000).optional(),
  /** Named exit preset: SCALP | SWING | RUNNER | CUSTOM */
  exitVersion: z.string().max(32).optional(),
});

export const AccountStrategyRunSchema = z.object({
  accountId: z.string().uuid(),
  mode: z.nativeEnum(StrategyMode),
  configuration: z.record(z.unknown()),
  assignedSymbols: z.array(z.string()).min(1),
  action: z.enum(["start", "stop", "save"]).default("start"),
});

export type StrategyExitConfig = z.infer<typeof StrategyExitConfigSchema>;
export type AccountStrategyRunInput = z.infer<typeof AccountStrategyRunSchema>;

export const CreateStrategySchema = z.object({
  name: z.string().min(2).max(120),
  mode: z.nativeEnum(StrategyMode),
  configuration: z.record(z.unknown()),
  assignedAccountIds: z.array(z.string().uuid()).default([]),
  assignedSymbols: z.array(z.string()).default([]),
});

export const InviteUserSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(Role),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;
export type UpdateAccountCredentialsInput = z.infer<
  typeof UpdateAccountCredentialsSchema
>;
export type PlaceOrderInput = z.infer<typeof PlaceOrderSchema>;
