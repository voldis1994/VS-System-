#!/usr/bin/env bash
# Cloud Agent install script for NEXUS PRO.
# Idempotent: prepares system deps, project deps, env files, and the database.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. System dependency: PostgreSQL (only installed if missing).
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib
fi

# 2. Bring the database up and ensure the role/database exist.
bash "$REPO_ROOT/.cursor/pg-up.sh"

# 3. Environment files. The apps load config via dotenv (from each app's own
#    directory) and Next.js (from its own directory); Turbo runs tasks in strict
#    env mode, so per-app .env files are the reliable way to supply config.
#    All values are local development defaults from .env.example.
[ -f .env ] || cp .env.example .env
cp .env.example apps/api/.env
cp .env.example apps/web/.env

# 4. Install workspace dependencies.
pnpm install --frozen-lockfile

# 5. Build the internal library packages that the apps depend on.
pnpm --filter @nexus/domain build
pnpm --filter @nexus/shared build
pnpm --filter @nexus/config build
pnpm --filter @nexus/broker-adapters build

# 6. Prisma client generation, schema migration, and seed data.
#    Prisma CLI and the seed script both auto-load apps/api/.env.
pnpm --filter @nexus/api prisma:generate
pnpm --filter @nexus/api exec prisma migrate deploy
pnpm --filter @nexus/api prisma:seed

echo "NEXUS PRO install complete."
