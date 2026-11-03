-- Dispositivi registrati per le push (token FCM, che copre anche iOS tramite APNs).
CREATE TABLE devices (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('android','ios')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_user ON devices (user_id);

-- Consenso esplicito: le notifiche offerte partono solo se l'utente le ha attivate.
CREATE TABLE preferences (
  user_id         UUID PRIMARY KEY,
  offers_enabled  BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proiezione dei prodotti aggiunti spesso (da ItemAdded).
CREATE TABLE user_frequent_products (
  user_id       UUID NOT NULL,
  product_id    UUID NOT NULL,
  product_name  TEXT NOT NULL,
  times_added   INTEGER NOT NULL DEFAULT 0,
  last_added    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX ufp_product ON user_frequent_products (product_id, times_added);

-- Storico delle offerte segnalate: casella "Offerte per te" e deduplica (una volta per offerta).
CREATE TABLE notifications (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL,
  product_id    UUID NOT NULL,
  product_name  TEXT NOT NULL,
  store_id      UUID NOT NULL,
  store_name    TEXT NOT NULL,
  price         NUMERIC(10,2) NOT NULL,
  promo_price   NUMERIC(10,2) NOT NULL,
  loyalty_only  BOOLEAN NOT NULL,
  valid_from    DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  pushed_at     TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  UNIQUE (user_id, product_id, store_id, valid_from)
);
CREATE INDEX notifications_user ON notifications (user_id, id DESC);
