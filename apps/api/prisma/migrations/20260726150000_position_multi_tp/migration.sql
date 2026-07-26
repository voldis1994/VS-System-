-- Multi-TP state on open positions (app-managed scale-out)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "initialVolume" DECIMAL(24,8);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "takeProfitsJson" JSONB;
