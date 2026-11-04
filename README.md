# Spesa Smart

App iOS e Android che trova in quale negozio vicino la lista della spesa costa meno, con inserimento
manuale rapido, esclusione dei negozi non graditi e metriche di risparmio nel profilo.
Implementa l'MVP descritto nelle specifiche tecniche (microservizi + app Flutter).

## Struttura

```
spesa-smart/
├── .github/workflows/    # CI: build, unit test, end-to-end, Flutter, immagini Docker
├── app/                  # App Flutter (iOS e Android)
├── deploy/k8s/           # Kubernetes (kustomize): Deployment, HPA, gateway, CronJob ingestion
├── gateway/dynamic.yml   # API Gateway Traefik: routing e rate limit
├── packages/common/      # Libreria condivisa Node: bootstrap, JWT, eventi, outbox, errori RFC 7807
├── services/
│   ├── auth/             # registrazione, login, JWT RS256, refresh token a rotazione
│   ├── user/             # profilo, raggio, fidelity card cifrate (AES-256-GCM)
│   ├── store/            # insegne, punti vendita (PostGIS), blacklist utente
│   ├── catalog/          # prodotti, categorie, sinonimi, autocompletamento (pg_trgm)
│   ├── list/             # liste (anche condivise, in tempo reale), parser "2 latte", scontrini, chiusura spesa
│   ├── pricing/          # prezzi correnti, motore di confronto 1/2 negozi e per articolo
│   ├── analytics/        # storico acquisti e metriche del profilo
│   ├── notification/     # offerte sui prodotti frequenti: push FCM e casella "Offerte per te"
│   └── ingestion/        # Python: raccolta prezzi e pubblicazione di PricesUpdated
├── infra/postgres/       # creazione di un database per servizio
├── scripts/              # chiavi JWT, avvio locale senza Docker
└── tests/                # unit test (parser, motore prezzi) e test end-to-end
```

## Avvio con Docker

```bash
./scripts/gen-keys.sh          # coppia di chiavi RS256 per i JWT (solo sviluppo)
docker compose up --build
```

- API: `http://localhost:8080/api/v1`
- Console RabbitMQ: `http://localhost:15672` (guest / guest)
- Al primo avvio l'Ingestion carica i listini dimostrativi; poi si ripete ogni 24 ore.

Verifica del percorso completo attraverso il gateway:

```bash
npm install && npm run build
GATEWAY_URL=http://localhost:8080 npm run e2e
```

## Avvio senza Docker

Servono Node 20+, PostgreSQL 16 con PostGIS, RabbitMQ e Redis in locale.

```bash
psql -U postgres -c "CREATE USER spesa WITH PASSWORD 'spesa' SUPERUSER"
psql -U postgres -f infra/postgres/init-databases.sql
./scripts/gen-keys.sh
npm install && npm run build
./scripts/dev-local.sh                       # servizi sulle porte 3001–3008
(cd services/ingestion && pip install -r requirements.txt && \
  CATALOG_URL=http://localhost:3004 STORE_URL=http://localhost:3003 \
  AMQP_URL=amqp://guest:guest@localhost:5672 INGESTION_MODE=once python -m ingestion)
npm test && npm run e2e
# per verificare anche le notifiche offerte, il test rilancia l'ingestion:
INGESTION_CMD="cd services/ingestion && SERVICE_TOKEN=dev-only-service-token CATALOG_URL=http://localhost:3004 STORE_URL=http://localhost:3003 AMQP_URL=amqp://guest:guest@localhost:5672 INGESTION_MODE=once python -m ingestion" npm run e2e
```

## App Flutter

```bash
cd app
./tool/setup_platforms.sh      # genera android/ e ios/, aggiunge permessi di posizione
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api/v1   # emulatore Android
flutter run --dart-define=API_BASE_URL=http://localhost:8080/api/v1  # simulatore iOS
flutter test
```

Notifiche push: `dart pub global activate flutterfire_cli && flutterfire configure` genera
`google-services.json` e `GoogleService-Info.plist`; per iOS serve anche la chiave APNs nel progetto
Firebase. Senza questa configurazione l'app funziona e le offerte restano nella schermata
"Offerte per te" (icona nella barra della lista). Lato server, montare l'account di servizio
Firebase e impostare `FCM_SERVICE_ACCOUNT_FILE` nel Notification Service: senza, le push vanno nel log.

Schermate: Lista (inserimento rapido, chip "Compri spesso", +/−, swipe per eliminare, condivisione), Confronto
(1 negozio, 2 negozi, per articolo; swipe per escludere un negozio), Dettaglio negozio ("Ho fatto la
spesa qui" con scansione dello scontrino), Condividi, Scontrino, Offerte per te, Negozi esclusi, Profilo (risparmio totale, risparmio medio, top 3, ciambella per
categoria, filtro periodo), Impostazioni (raggio, fidelity card, logout, eliminazione account).

## Come funziona

- **Un database per servizio**, nessun accesso incrociato alle tabelle. I dati condivisi viaggiano
  come eventi su RabbitMQ (exchange topic `spesa.events`) o come chiamate REST interne.
- **Outbox e idempotenza**: ogni evento è scritto nella stessa transazione della modifica e inoltrato
  da un relay; i consumer registrano l'`eventId` in `processed_events` e lo elaborano una sola volta.
- **JWT**: firmati RS256 dall'Auth Service; ogni servizio ne verifica la firma con la chiave pubblica.
- **Endpoint interni** `/api/v1/internal/*`: usati solo tra servizi e bloccati dal gateway.
  Le chiamate senza un utente (Ingestion, job del Notification Service) usano un token di servizio
  (`SERVICE_TOKEN`) con l'utente per conto del quale si agisce; il gateway rimuove questi header.
- **Notifiche offerte** (v1.1): il Notification Service tiene una proiezione dei prodotti aggiunti
  almeno 2 volte (da `ItemAdded`). A ogni `PricesUpdated` cerca le promo con almeno il 10% di sconto
  nei negozi entro il raggio dalla posizione di casa, blacklist esclusa; le promo riservate ai
  titolari valgono solo con la carta. Una push per esecuzione, nessun doppione per la stessa offerta,
  consenso spento finché l'utente non attiva "Avvisami delle offerte".
- **Risparmio**: alla chiusura della spesa il Pricing Service congela, riga per riga, il prezzo pagato
  e quello del negozio più caro del raggio (blacklist esclusa) con la maggiore copertura della lista.
  Gli articoli che il riferimento non vende restano nello storico ma fuori dal calcolo del risparmio.

| Evento | Pubblicato da | Consumato da |
| --- | --- | --- |
| UserRegistered | auth | user |
| UserDeleted | user | auth, store, list, analytics, notification |
| StoreExcluded | store | — (disponibile per notifiche future) |
| ProductCreated | catalog | analytics |
| ItemAdded | list | notification |
| PurchaseCompleted | list | analytics |
| PricesUpdated | ingestion | pricing, notification |

## Liste condivise e scontrino (v1.2)

- **Condivisione**: il proprietario genera un codice di 6 caratteri valido 48 ore (`POST /lists/{id}/invites`);
  chi lo riceve entra con `POST /lists/join` e può modificare la lista, fino a 5 membri. Solo il
  proprietario elimina la lista, crea inviti e rimuove membri; gli altri possono uscire.
- **Tempo reale**: `GET /lists/{id}/live` (WebSocket, header `Authorization`) invia un segnale a ogni
  modifica (`item.added`, `item.updated`, `item.removed`, `list.renamed`, `list.purchased`,
  `members.changed`). Le repliche del List Service si scambiano i segnali su RabbitMQ (`ListChanged`,
  non persistente), quindi funziona anche con più istanze. Il client ricarica la lista: il server resta
  l'unica fonte di verità e un segnale perso non crea incoerenze.
- **Scontrino**: il telefono legge il testo con ML Kit (la foto non lascia il dispositivo) e lo invia a
  `POST /lists/{id}/receipt`. Il server riconosce righe prodotto, quantità ("2 x 1,29"), pesi
  ("0,534 kg x 1,89"), sconti e totale, e abbina ogni riga a un articolo (sinonimi del catalogo +
  somiglianza del testo). L'utente corregge gli abbinamenti e chiude la spesa con `paidPrices`: il
  risparmio si calcola sui prezzi pagati davvero invece che sui listini.

## Prezzi reali: Open Prices

L'Ingestion legge anche [Open Prices](https://prices.openfoodfacts.org) di Open Food Facts: prezzi
segnalati dalla comunità con scontrino o foto del cartellino, tramite un'API pubblica e gratuita.

- Fonti attive con `INGESTION_SOURCES` (`demo`, `open_prices`, anche entrambe). In produzione il
  CronJob usa solo `open_prices`; l'area si imposta con `OPEN_PRICES_LAT`, `OPEN_PRICES_LON`,
  `OPEN_PRICES_RADIUS_KM` (default: Belluno, 40 km) e `OPEN_PRICES_DAYS` (default 90).
- Per ogni coppia negozio–prodotto vale l'osservazione più recente; gli sconti senza prezzo pieno sono
  scartati, quelli "LOYALTY_PROGRAM" diventano promo riservate ai titolari di carta.
- I negozi sono luoghi OpenStreetMap (`osm:node:…`) e vengono creati nello Store Service al primo prezzo;
  i prodotti nuovi entrano nel catalogo per codice a barre, con la categoria dedotta da quelle di
  Open Food Facts (`services/catalog/src/categories.ts`).
- **Licenza ODbL**: l'app cita la fonte nella schermata di confronto; se la base dati derivata viene resa
  pubblica, va condivisa alle stesse condizioni.
- Copertura: i dati dipendono dalle segnalazioni. Nel bellunese oggi sono pochi; chiunque può
  contribuire con l'app Open Prices, e i prezzi entrano qui al giro notturno successivo.

## Listini dei negozi partner

Un negozio può pubblicare il proprio listino come file JSON (formato in
[docs/feed-format.md](docs/feed-format.md)): `INGESTION_SOURCES=open_prices,feeds` e
`INGESTION_FEEDS=<url o file>`. Righe non valide vengono scartate e segnalate nel log; negozi e
prodotti nuovi vengono creati automaticamente. È l'alternativa allo scraping dei siti delle insegne:
prezzi completi, con il consenso di chi li pubblica.

## Inviti tramite link e uso senza rete

- Ogni invito ha anche un link `https://<PUBLIC_BASE_URL>/i/CODICE`. Sul telefono con l'app installata
  il link apre l'app ed entra nella lista (Android App Links, iOS Universal Links); altrimenti si apre
  una pagina con il codice e le istruzioni. Il servizio pubblica `/.well-known/assetlinks.json` e
  `/.well-known/apple-app-site-association`: configurare `ANDROID_CERT_SHA256` e `IOS_APP_ID`.
  Per Android `tool/setup_platforms.sh` aggiunge i filtri dei link (`APP_LINK_HOST=dominio`); per iOS va
  aggiunta in Xcode la capability Associated Domains (`applinks:dominio`).
- Senza rete ogni modifica della lista (aggiunta, quantità, spunta, rimozione) resta valida sul
  telefono e va in una coda locale, compattata e inviata in ordine al ritorno della connessione.

## Affidabilità e prestazioni

- **Eventi**: l'outbox considera un evento pubblicato solo dopo la conferma di RabbitMQ; un messaggio
  che fallisce due volte finisce nella coda `spesa.dead` invece di andare perso. Se la connessione al
  broker cade, il servizio esce e viene riavviato da Docker o Kubernetes.
- **Avvio di più repliche**: le migrazioni del database sono protette da un lock, così due pod che
  partono insieme non si ostacolano. `/health` dice se il processo è vivo, `/ready` se database e bus
  rispondono (usato da Kubernetes, Docker Compose e CI).
- **Cache**: i confronti in cache dipendono anche da negozi ammessi, carte fedeltà e versione dei
  listini, quindi escludere un negozio cambia subito il risultato. L'invalidazione avviene cambiando
  versione, senza scansioni `KEYS` su Redis.
- **Prezzi vecchi**: un prezzo che nessuna fonte conferma da `PRICE_MAX_AGE_DAYS` giorni (default 60)
  non entra più nei confronti; per Open Prices conta la data dello scontrino o del cartellino.
- **Metriche**: la spesa per categoria è aggiornata riga per riga a ogni acquisto, invece di ricalcolare
  ogni volta una vista su tutto lo storico.
- **Ricerca prodotti**: usa gli indici trigram anche con un catalogo grande, con le soglie impostate
  sulla connessione (una query per ricerca, non una transazione) e una cache in memoria di 5 minuti
  per i prefissi più digitati; gli scontrini vengono abbinati con una sola chiamata al catalogo.
- **Limiti del gateway**: 300 richieste al minuto per utente sulle API, 20 al minuto per IP su login e
  registrazione, 120 al minuto per IP sulle pagine d'invito.
- **Pulizia automatica** ogni ora: eventi già pubblicati, token scaduti, inviti scaduti, storico prezzi
  oltre 180 giorni, notifiche oltre 60 giorni.

## Test di latenza

`npm run latency` (servizi avviati) misura p50, p95 e p99 delle chiamate dell'app, prima una alla volta
e poi con 20 richieste contemporanee, e li confronta con gli obiettivi delle specifiche
(autocompletamento p95 < 80 ms, confronto di 50 articoli p95 < 1 s). Opzioni: `LATENCY_ROUNDS`,
`LATENCY_CONCURRENCY`, `GATEWAY_URL` (attraverso il gateway), `LATENCY_JSON` (risultati in un file).
Gira anche in CI, solo come informazione.

Misura del 4 novembre 2026, tutto su una macchina con 2 vCPU (8 servizi, PostgreSQL, RabbitMQ, Redis),
senza gateway; tempi in millisecondi:

| Chiamata | p95 singola | p95 con 20 contemporanee |
| --- | --- | --- |
| Autocompletamento (prefissi comuni, in cache) | 2,7 | 25,7 |
| Autocompletamento (sempre dal database) | 4,8 | 90,2 |
| Aggiunta rapida di un articolo | 11,3 | 99,3 |
| Lettura scontrino | 10,1 | – |
| Confronto 50 articoli, senza cache | 14,9 | 497,6 |
| Confronto 50 articoli, in cache | 10,8 | – |
| Metriche del profilo | 2,6 | 35,1 |
| Login (argon2, lento di proposito) | 16,3 | – |

## Endpoint aggiuntivi rispetto alle specifiche

- `GET /lists/frequent-products`: alimenta i chip "Compri spesso".
- `GET /stores/chains`: elenco insegne per escluderne una o aggiungere una fidelity card.
- `PUT /notifications/devices`, `DELETE /notifications/devices/{token}`: token push del dispositivo.
- `GET` / `PATCH /notifications/preferences`: consenso alle offerte.
- `GET /notifications`, `POST /notifications/read`: casella "Offerte per te".
- `POST /lists/{id}/invites`, `POST /lists/join`, `GET /lists/{id}/members`, `DELETE /lists/{id}/members/{userId}`.
- `GET /lists/{id}/live` (WebSocket) e `POST /lists/{id}/receipt`; `POST /lists/{id}/purchase` accetta `paidPrices`.

## Differenze dalle specifiche da conoscere

- **Cache locale dell'app** con `shared_preferences` invece di drift: basta per la lista corrente e la
  coda offline e non richiede generazione di codice. Da rivalutare se servirà lo storico offline.
- **Cache Redis del Pricing** applicata ai risultati del confronto (15 minuti, invalidata a ogni
  `PricesUpdated`), mentre i prezzi si leggono da PostgreSQL con indice dedicato.
- **analytics_db** ha la colonna `comparable_paid`, necessaria per escludere dal risparmio gli
  articoli assenti nel negozio di riferimento, come richiesto dalla sezione Metriche.
- **Dati dimostrativi**: insegne, punti vendita (area del Cadore) e prezzi sono fittizi. Le fonti reali
  vanno aggiunte in `services/ingestion/ingestion/sources/` (vedi `scraper_template.py`).

## Produzione (Kubernetes)

`deploy/k8s` contiene un Deployment, un Service e un HPA per ogni servizio Node, il gateway Traefik
con Ingress TLS, il CronJob dell'Ingestion alle 02:00 ora italiana e una NetworkPolicy che lascia
raggiungere i servizi solo dall'interno del progetto. PostgreSQL, RabbitMQ e Redis sono previsti come
servizi gestiti in region UE. Creare i Secret come in `secrets.example.yaml`, aggiornare le immagini in
`kustomization.yaml`, poi `./deploy/k8s/deploy.sh`.

## Stato della verifica

- Backend: NestJS 12, nessuna vulnerabilità nota nelle dipendenze (`npm audit`, controllato anche in CI).
  Compilato con controlli TypeScript stretti e provato in locale su PostgreSQL 16 + PostGIS, RabbitMQ e
  Redis; 31 unit test Node, 10 test Python dell'Ingestion e
  il test end-to-end passano. Il percorso: registrazione → lista → blacklist → confronto → spesa →
  metriche → offerte notificate senza doppioni → endpoint interni protetti → lista condivisa con un
  secondo utente e aggiornamento via WebSocket → chiusura con lo scontrino → uscita del membro →
  prezzi Open Prices (con un server che simula l'API) → feed partner → cancellazione account.
  Il test copre anche link d'invito, pagina di atterraggio e file `.well-known`, più i casi limite
  corretti nella revisione: token malformati, logout con segreto sbagliato, invii simultanei con la
  stessa chiave, chiusura contemporanea della spesa da due membri, negozio escluso dopo un confronto
  già in cache, righe ripetute in un feed.
- La CI su GitHub esegue tutto questo a ogni push, più analisi e test dell'app Flutter (modelli,
  coda offline, schermate di login e profilo) e la build delle immagini Docker.
- Ancora da provare su un ambiente reale: il gateway Traefik con Docker Compose, i manifest Kubernetes
  (solo sintassi YAML) e l'app su un telefono o emulatore.

## Pubblicazione su GitHub

```bash
./scripts/publish-github.sh            # crea il repository privato "spesa-smart" e fa il push
./scripts/publish-github.sh nome --public
```

## Prossimi passi

- Accordi con negozi della zona per pubblicare il feed del listino.
- Provare l'app su un telefono reale: link d'invito, notifiche push e lettura degli scontrini.
- Database locale (drift) solo se servirà lo storico delle liste senza rete: oggi la coda offline
  copre l'uso tipico.
