# Known Limitations

1. **Live broker adapters** are mocks reusing the paper engine. Real MT4/MT5/cTrader/Binance/Bybit packages are isolated for a later phase.
2. **Redis/BullMQ** is provisioned in Compose but critical loops currently run in-process in the API (worker is a heartbeat stub).
3. **WebSocket** uses Nest `platform-ws`; client reconnect UX is basic.
4. **Chart** uses Lightweight Charts with API candles; drawing tools / drag SL-TP confirm round-trip is simplified.
5. **Report export** currently produces JSON (CSV/XLSX/PDF queued for later).
6. **Prop firm compliance engine** schema hooks exist via risk profiles; dedicated challenge phase UI/engine is incomplete.
7. **Indicator engine** EMA used in backtest; full indicator suite + condition builder UI is incomplete.
8. **E2E Playwright** suite and load tests are not yet in CI.
9. **Email/Telegram/Discord** notification channels store intent; delivery adapters not wired.
10. **Rate limiting** middleware is prepared via stack choices but not applied per-route with Redis store yet.
