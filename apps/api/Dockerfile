FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm --filter @nexus/domain build && pnpm --filter @nexus/shared build && pnpm --filter @nexus/config build && pnpm --filter @nexus/broker-adapters build
WORKDIR /app/apps/api
RUN pnpm prisma generate && pnpm build
EXPOSE 4000
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/main.js"]
