# API Reference (Phase 1–3+)

Base URL: `http://localhost:4000/api`  
Auth: `Authorization: Bearer <accessToken>` or `access_token` httpOnly cookie.  
All authenticated routes are organization-scoped from the JWT.

## Auth

| Method | Path | Notes |
|--------|------|-------|
| POST | `/auth/register` | Creates org + owner |
| POST | `/auth/login` | May return `requires2FA` |
| POST | `/auth/2fa/verify` | Challenge token + TOTP |
| POST | `/auth/2fa/enable` | Returns otpauth URL |
| POST | `/auth/trading-pin/verify` | Elevates token claim |
| POST | `/auth/logout` | Revokes sessions |
| GET | `/auth/me` | Current user + org + permissions |

## Accounts

| Method | Path |
|--------|------|
| GET/POST | `/accounts` |
| GET/PATCH | `/accounts/:id` |
| POST | `/accounts/:id/connect` |
| POST | `/accounts/:id/disconnect` |
| POST | `/accounts/:id/sync` |
| POST | `/accounts/:id/lock` |
| POST | `/accounts/:id/unlock` |

## Trading

| Method | Path |
|--------|------|
| GET/POST | `/orders` |
| DELETE | `/orders/:id` |
| GET | `/positions` |
| POST | `/positions/:id/close` |
| POST | `/positions/:id/partial-close` |
| PATCH | `/positions/:id/sl-tp` |
| POST | `/positions/:id/break-even` |
| POST | `/positions/:id/trailing` |

## Market / Risk / Strategies / Copier / Automation / Alerts

| Method | Path |
|--------|------|
| GET | `/symbols` |
| GET | `/market-data/ticks` |
| GET | `/market-data/:symbol/candles` |
| GET/POST | `/risk/profiles` |
| POST | `/risk/evaluate` |
| GET/POST | `/strategies` |
| POST | `/strategies/:id/validate\|start\|stop\|backtest` |
| GET/POST | `/copiers` |
| POST | `/copiers/:id/start\|stop` |
| GET/POST | `/automations` |
| POST | `/automations/:id/run` |
| GET/POST | `/alerts` |
| PATCH | `/alerts/:id` |

## Analytics / Ops

| Method | Path |
|--------|------|
| GET | `/analytics/overview` |
| GET | `/analytics/equity` |
| GET | `/analytics/drawdown` |
| GET | `/audit` |
| GET/POST | `/reports` |
| GET | `/reports/:id/download` |
| GET/POST/PATCH | `/journal` |
| GET | `/notifications` |
| GET | `/health` |
| GET | `/health/system` |

## Errors

```json
{
  "code": "RISK_DAILY_LIMIT_EXCEEDED",
  "message": "...",
  "details": {},
  "correlationId": "...",
  "timestamp": "..."
}
```

## WebSocket

Path: `/ws?token=<jwt>`  
Subscribe message: `{ "event": "subscribe", "data": { "channels": ["market.tick","order.updated","position.updated"] } }`
