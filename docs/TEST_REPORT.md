# Test Report

**Run date:** 2026-07-23

## Unit tests

| Package | Result |
|---------|--------|
| `@nexus/shared` (decimal + risk formulas) | 5/5 passed |
| `@nexus/domain` (RBAC) | 3/3 passed |
| `@nexus/broker-adapters` (paper engine) | 5/5 passed |

Commands:

```bash
pnpm --filter @nexus/shared test
pnpm --filter @nexus/domain test
pnpm --filter @nexus/broker-adapters test
```

## Manual integration (Scenario A excerpt)

Against local API (`localhost:4000`):

1. Register organization ✅
2. Create paper account ✅
3. Connect account → `CONNECTED` ✅
4. Place MARKET BUY EURUSD with `riskPercent: 1` → sized to `1.96` lots, `FILLED` ✅
5. Position visible in `/positions` ✅
6. Activate trailing ✅
7. Partial close → remaining `0.98`, status `PARTIALLY_CLOSED` ✅
8. Analytics overview returns live equity/daily P/L ✅
9. Audit log contains `ORDER_FILLED`, `TRAILING_ACTIVATED`, `POSITION_PARTIAL_CLOSE` ✅

## Typecheck

- `apps/api` `tsc --noEmit` — clean after DI/compile setup
- `apps/web` — built successfully in frontend scaffold commit

## Not yet green

- Playwright E2E suite
- Load tests (10k ticks/sec targets)
- Full Nest integration test suite under Vitest
