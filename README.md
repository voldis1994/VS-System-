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

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres redis   # or local Postgres/Redis
pnpm install
pnpm --filter @nexus/domain build && pnpm --filter @nexus/shared build && pnpm --filter @nexus/config build && pnpm --filter @nexus/broker-adapters build
pnpm db:generate && pnpm --filter @nexus/api prisma:migrate:dev
pnpm db:seed
pnpm dev:api    # :4000
pnpm dev:web    # :3000
```

Seed owner: `owner@nexus.pro` / `NexusOwner123!` (PIN `123456`)

## Defaults

- System starts in **Paper Trading**
- Live Trading requires identity, 2FA, trading PIN, broker health, permissions, and explicit risk acknowledgement
- All money values use Decimal; timestamps stored UTC

## Docs

- `docs/IMPLEMENTATION_STATUS.md`
- `docs/KNOWN_LIMITATIONS.md`
- `docs/API.md`
- `docs/TEST_REPORT.md`
