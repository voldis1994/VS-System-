# Capital.com connection

## 1. Capital.com kontā

1. Izveido kontu (sāc ar **Demo**)
2. Ieslēdz **2FA**
3. Settings → **API integrations** → Generate new key
4. Saglabā: email, API key, API password

Docs: https://open-api.capital.com/

## 2. NEXUS PRO

1. Atjaunini kodu no `main` un pārstartē (`start-nexus.bat`)
2. Accounts → Provider: **Capital.com**
3. Mode: **DEMO**
4. Ievadi email + API key + password → **Connect Capital.com**
5. Statusam jābūt **CONNECTED**
6. Terminal → epic (piem. `EURUSD`) → atver/aizver treidu

## 3. LIVE (reāla nauda)

Tikai pēc Demo testa:
- Mode: LIVE
- Trading PIN verificēts
- Live Trading toggle (joprojām ar riska brīdinājumu)

**CFD risks:** lielākā daļa retail kontu zaudē naudu. Sāc tikai ar Demo.
