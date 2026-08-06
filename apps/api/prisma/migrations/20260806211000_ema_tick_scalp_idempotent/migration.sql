-- AlterEnum
-- Idempotent: safe if EMA_TICK_SCALP already applied by prior migration
ALTER TYPE "StrategyMode" ADD VALUE IF NOT EXISTS 'EMA_TICK_SCALP';
