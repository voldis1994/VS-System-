# Known Limitations

1. **Capital.com** is the live CFD path; MT4/MT5/cTrader/Binance/Bybit remain mock stubs in `createBrokerAdapter`.
2. **Redis** is in Compose for future queues; strategy/order loops run in-process in the API.
3. **“10s” modes** use Capital **1m** OHLC + live mid (Capital has no sub-minute history API).
4. **Chart** is Lightweight Charts with API candles; advanced drawing / drag SL-TP is simplified.
5. **Report export** is JSON-oriented; full CSV/XLSX/PDF later.
6. **E2E Playwright** / load tests are not in CI yet.
7. **Email/Telegram/Discord** notification delivery adapters are not wired.
8. Post-fill **SL attach** is best-effort — if Capital rejects min-stop, check Alerts and tighten distance.
