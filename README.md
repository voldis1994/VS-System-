# VS System

Multi-account trading desk + client portal (Capital.com / paper).

## Stack

- **apps/web** — Next.js desk (`/dashboard`) + client (`/client`)
- **apps/api** — NestJS, Prisma, PostgreSQL, strategy runtime
- **packages/domain** — modes, RBAC, Zod schemas
- **packages/shared** — Decimal, risk, instrument distances
- **packages/broker-adapters** — Paper + Capital.com
- **packages/config** — env validation

## Windows — viena palaide

1. Uzliec [Node.js LTS](https://nodejs.org) + [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Palaid Docker Desktop (Engine running).
3. **Atjaunināt kodu** (bez jaunas mapes): **`UPDATE-VS-SYSTEM.bat`** — `git pull origin main`
4. Dubultklikšķis: **`START-VS-SYSTEM.bat`**

Tas dara visu: git pull → install → build → Postgres/Redis → migrate → API + Web → Cloudflare tunnel.

| Kas | URL |
|-----|-----|
| Desk (tev) | http://localhost:3000/dashboard |
| Client (telefonam) | LAN no `client-url.txt` vai remote no `remote-client-url.txt` |
| API | http://localhost:4000/api/health |

Login: `owner@nexus.pro` / `NexusOwner123!` · PIN `123456`

Apturēt: **`STOP-VS-SYSTEM.bat`**

## Mac / Linux

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm --filter @nexus/domain build && pnpm --filter @nexus/shared build && pnpm --filter @nexus/config build && pnpm --filter @nexus/broker-adapters build
pnpm db:generate && pnpm --filter @nexus/api exec prisma migrate deploy
pnpm db:seed
pnpm dev:api   # terminal 1
pnpm dev:web   # terminal 2
pnpm tunnel    # optional remote /client
```

## Docs

- `docs/CAPITAL_COM.md` — Capital.com API / LIVE
- `docs/API.md` — API overview
- `docs/KNOWN_LIMITATIONS.md`
