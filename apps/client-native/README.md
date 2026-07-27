# VS Client — telefona aplikācija

Divas opcijas:

## 1) PWA (ātrākais — iPhone / Android)

1. Deploy VS System web ar HTTPS
2. Telefonā Safari/Chrome atver: `https://TAVS-DOMAINS/client`
3. **iPhone:** Share → **Add to Home Screen** → Add  
   **Android:** izvēlne → **Install app** / Instalēt

Uz sākuma ekrāna parādās **VS Client** kā aplikācija (bez browser joslas).

Login: operators Accounts → **Klienta PIN** → kods + PIN.

## 2) Native (Capacitor) — App Store / Play Store

```bash
cd apps/client-native
pnpm install
export CLIENT_APP_URL="https://TAVS-DOMAINS"   # bez /client
pnpm cap:add:ios      # vajag macOS + Xcode
pnpm cap:add:android  # vajag Android Studio
pnpm cap:ios          # vai pnpm cap:android
```

WebView ielādē `/client` no tava servera. PIN portāls un API paliek tie paši.

## Piezīme

Desk (`/login`, Strategies, Accounts) paliek galvenā sistēma.  
Klienta app ir tikai `/client` + native/PWA čaula.
