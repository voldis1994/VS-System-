# VS Client — iPhone aplikācija

## Svarīgi (Apple ierobežojums)

**Es nevaru no cloud/Linux iedot Tev gatavu App Store lejupielādi.**  
iPhone `.ipa` / TestFlight / App Store **vienmēr** prasa:

1. **Mac** ar **Xcode**
2. **Apple Developer** kontu (99 USD/gadā — App Store; bezmaksas Apple ID der kabelim ~7 dienas)

Tavs **Windows dators** var būt **galvenais serveris** (API + web).  
iPhone app savienojas ar Tava PC **IP** (piem. `192.168.1.50`).

---

## A) Profesionāla app uz iPhone BEZ App Store (šodien)

1. Uz PC palaid `start-vs-system.bat`
2. Skaties CMD izvadē **LAN IP** (vai `ipconfig` → IPv4)
3. iPhone (tajā pašā Wi‑Fi) Safari: `http://TAVA-IP:3000/client`
4. Share → **Add to Home Screen** → Add  
   → ikona **VS Client** kā aplikācija
5. Appā ievadi servera IP (ja jautā) + klienta kodu/PIN no Accounts

---

## B) Īsta native iPhone app (Xcode → telefonā)

Uz **Mac**:

```bash
cd apps/client-native
pnpm install
export CLIENT_APP_URL="http://TAVA-PC-IP:3000"
pnpm cap:sync
pnpm cap:ios
```

Xcode → izvēlies savu iPhone → Run (▶).  
App ielādē `/client` no Tava datora.

App Store publicēšanai: Archive → Upload → TestFlight / Review.

---

## Serveris (Windows PC)

- API jau klausās `0.0.0.0:4000`
- Web: `0.0.0.0:3000` (LAN)
- Firewall: atļauj inbound **3000** un **4000**
- CORS atļauj LAN `192.168.*` / `10.*` originus

Operators: **Accounts → Klienta PIN** → kods + PIN klientam.
