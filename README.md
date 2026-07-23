# NEXUS PRO

Multi-account trading operations platform (management & execution coordination — not a broker).

## Stack

- **apps/web** — Next.js 15, React, Tailwind, TanStack Query, Zustand
- **apps/api** — NestJS, Prisma, PostgreSQL, WebSocket gateway
- **apps/worker** — background workers
- **packages/domain** — enums, events, RBAC, Zod schemas
- **packages/shared** — Decimal math, risk formulas, time helpers
- **packages/broker-adapters** — Paper + mock MT4/MT5/cTrader/Binance/Bybit
- **packages/config** — env validation

## Quick start (Windows)

1. Install [Node.js LTS](https://nodejs.org), [Docker Desktop](https://www.docker.com/products/docker-desktop/), enable WSL if asked.
2. Start Docker Desktop (Engine running).
3. Double-click `start-nexus.bat` in the project folder.

UI: http://localhost:3000  
Login: `owner@nexus.pro` / `NexusOwner123!` (PIN `123456`)

Stop containers: `stop-nexus.bat`

## Quick start (Mac/Linux)

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm --filter @nexus/domain build && pnpm --filter @nexus/shared build && pnpm --filter @nexus/config build && pnpm --filter @nexus/broker-adapters build
pnpm db:generate && pnpm --filter @nexus/api exec prisma migrate deploy
pnpm db:seed
pnpm dev:api
pnpm dev:web
```

## Defaults

- System starts in **Paper Trading**
- Live Trading requires identity, 2FA, trading PIN, broker health, permissions, and explicit risk acknowledgement
- All money values use Decimal; timestamps stored UTC

## Docs

- `docs/IMPLEMENTATION_STATUS.md`
- `docs/KNOWN_LIMITATIONS.md`
- `docs/API.md`
- `docs/TEST_REPORT.md`
