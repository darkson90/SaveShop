# Spesa Smart

App iOS e Android che trova in quale negozio vicino la lista della spesa costa meno, con inserimento
manuale rapido, esclusione dei negozi non graditi e metriche di risparmio nel profilo.
Implementa l'MVP descritto nelle specifiche tecniche (microservizi + app Flutter).

## Struttura

```
spesa-smart/
├── app/                  # App Flutter (iOS e Android)
├── gateway/dynamic.yml   # API Gateway Traefik: routing e rate limit
├── packages/common/      # Libreria condivisa Node: bootstrap, JWT, eventi, outbox, errori RFC 7807
├── services/
│   ├── auth/             # registrazione, login, JWT RS256, refresh token a rotazione
│   ├── user/             # profilo, raggio, fidelity card cifrate (AES-256-GCM)
│   ├── store/            # insegne, punti vendita (PostGIS), blacklist utente
│   ├── catalog/          # prodotti, categorie, sinonimi, autocompletamento (pg_trgm)
│   ├── list/             # liste, parser "2 latte", frequenze, chiusura spesa
│   ├── pricing/          # prezzi correnti, motore di confronto 1/2 negozi e per articolo
│   ├── analytics/        # storico acquisti e metriche del profilo
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
./scripts/dev-local.sh                       # servizi sulle porte 3001–3007
(cd services/ingestion && pip install -r requirements.txt && \
  CATALOG_URL=http://localhost:3004 STORE_URL=http://localhost:3003 \
  AMQP_URL=amqp://guest:guest@localhost:5672 INGESTION_MODE=once python -m ingestion)
npm test && npm run e2e
```

## App Flutter

```bash
cd app
./tool/setup_platforms.sh      # genera android/ e ios/, aggiunge permessi di posizione
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api/v1   # emulatore Android
flutter run --dart-define=API_BASE_URL=http://localhost:8080/api/v1  # simulatore iOS
flutter test
```

Schermate: Lista (inserimento rapido, chip "Compri spesso", +/−, swipe per eliminare), Confronto
(1 negozio, 2 negozi, per articolo; swipe per escludere un negozio), Dettaglio negozio ("Ho fatto la
spesa qui"), Negozi esclusi, Profilo (risparmio totale, risparmio medio, top 3, ciambella per
categoria, filtro periodo), Impostazioni (raggio, fidelity card, logout, eliminazione account).

## Come funziona

- **Un database per servizio**, nessun accesso incrociato alle tabelle. I dati condivisi viaggiano
  come eventi su RabbitMQ (exchange topic `spesa.events`) o come chiamate REST interne.
- **Outbox e idempotenza**: ogni evento è scritto nella stessa transazione della modifica e inoltrato
  da un relay; i consumer registrano l'`eventId` in `processed_events` e lo elaborano una sola volta.
- **JWT**: firmati RS256 dall'Auth Service; ogni servizio ne verifica la firma con la chiave pubblica.
- **Endpoint interni** `/api/v1/internal/*`: usati solo tra servizi e bloccati dal gateway.
- **Risparmio**: alla chiusura della spesa il Pricing Service congela, riga per riga, il prezzo pagato
  e quello del negozio più caro del raggio (blacklist esclusa) con la maggiore copertura della lista.
  Gli articoli che il riferimento non vende restano nello storico ma fuori dal calcolo del risparmio.

| Evento | Pubblicato da | Consumato da |
| --- | --- | --- |
| UserRegistered | auth | user |
| UserDeleted | user | auth, store, list, analytics |
| StoreExcluded | store | — (disponibile per notifiche future) |
| ProductCreated | catalog | analytics |
| ItemAdded | list | — (Notification, v1.1) |
| PurchaseCompleted | list | analytics |
| PricesUpdated | ingestion | pricing |

## Endpoint aggiuntivi rispetto alle specifiche

- `GET /lists/frequent-products`: alimenta i chip "Compri spesso".
- `GET /stores/chains`: elenco insegne per escluderne una o aggiungere una fidelity card.

## Differenze dalle specifiche da conoscere

- **Cache locale dell'app** con `shared_preferences` invece di drift: basta per la lista corrente e la
  coda offline e non richiede generazione di codice. Da rivalutare se servirà lo storico offline.
- **Cache Redis del Pricing** applicata ai risultati del confronto (15 minuti, invalidata a ogni
  `PricesUpdated`), mentre i prezzi si leggono da PostgreSQL con indice dedicato.
- **analytics_db** ha la colonna `comparable_paid`, necessaria per escludere dal risparmio gli
  articoli assenti nel negozio di riferimento, come richiesto dalla sezione Metriche.
- **Notification Service** (v1.1) non è incluso; gli eventi che userà sono già pubblicati.
- **Dati dimostrativi**: insegne, punti vendita (area del Cadore) e prezzi sono fittizi. Le fonti reali
  vanno aggiunte in `services/ingestion/ingestion/sources/` (vedi `scraper_template.py`).

## Stato della verifica

- Backend: compilato e provato in locale su PostgreSQL 16 + PostGIS, RabbitMQ e Redis; 18 unit test e
  il test end-to-end (registrazione → lista → blacklist → confronto → spesa → metriche → cancellazione
  account) passano.
- Non verificati in questo ambiente: le immagini Docker e il gateway Traefik (nessun daemon Docker
  disponibile) e la compilazione dell'app Flutter (SDK non scaricabile). Al primo `flutter analyze`
  potrebbero emergere piccoli aggiustamenti.
