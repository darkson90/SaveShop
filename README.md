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

- Backend: compilato e provato in locale su PostgreSQL 16 + PostGIS, RabbitMQ e Redis; 28 unit test e
  il test end-to-end passano. Il percorso: registrazione → lista → blacklist → confronto → spesa →
  metriche → offerte notificate senza doppioni → endpoint interni protetti → lista condivisa con un
  secondo utente e aggiornamento via WebSocket → chiusura con lo scontrino → uscita del membro →
  cancellazione account.
- Non verificati in questo ambiente: le immagini Docker, il gateway Traefik, i manifest Kubernetes
  (solo sintassi YAML) e la compilazione dell'app Flutter (SDK non scaricabile). La CI li copre al
  primo push: `flutter analyze` potrebbe segnalare piccoli aggiustamenti.

## Pubblicazione su GitHub

```bash
./scripts/publish-github.sh            # crea il repository privato "spesa-smart" e fa il push
./scripts/publish-github.sh nome --public
```

## Prossimi passi

- Fonti prezzi reali nell'Ingestion (API e volantini digitali delle insegne della zona).
- Storico offline dell'app e sincronizzazione completa (drift), se le liste crescono.
- Inviti tramite link (deep link) oltre al codice.
