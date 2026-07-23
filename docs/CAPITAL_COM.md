## Capital.com LIVE

### Ja error "api key" / auth failed

1. **API Password ≠ login parole**  
   Settings → API integrations → Generate key → tur ievadi **Custom API password**.  
   NEXUS laukā "API Password" jābūt **šai** parolei (ne Capital.com login parolei).

2. **Mode sakrīt ar key**  
   - LIVE key (REAL konts) → Mode **LIVE**  
   - Demo key → Mode **DEMO**  
   NEXUS tagad vienmēr izmanto konta Mode (LIVE/DEMO), nevis veco credential flag.

3. **Email** = Capital.com login email

4. **API Key** ielīmē bez atstarpēm (NEXUS trim-o)

5. 2FA ieslēgts; key nav expired / paused  
   Ja neesi pārliecināts — ģenerē **jaunu** key (vecais tiek rādīts tikai 1x).

6. Esošam ERROR kontam: **Fix API key** → Save & reconnect

### Soļi

1. Capital.com REAL → 2FA → jauns API key + custom password  
2. NEXUS → Verify PIN  
3. Accounts → Capital.com → LIVE → risk checkbox  
4. Email + API Key + **API Password** → Connect  
5. CONNECTED + LIVE ON
