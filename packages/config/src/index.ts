import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("24h"),
  ENCRYPTION_KEY: z.string().length(64),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  DEFAULT_TRADING_MODE: z.enum(["PAPER", "LIVE"]).default("PAPER"),
  LIVE_TRADING_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  SEED_OWNER_EMAIL: z.string().email().optional(),
  SEED_OWNER_PASSWORD: z.string().optional(),
  SEED_TRADING_PIN: z.string().optional(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
