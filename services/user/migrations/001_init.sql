CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id                UUID PRIMARY KEY,
  email             TEXT NOT NULL,
  display_name      TEXT,
  default_radius_km SMALLINT NOT NULL DEFAULT 10 CHECK (default_radius_km BETWEEN 1 AND 25),
  home_location     GEOGRAPHY(Point, 4326),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_cards (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id         UUID NOT NULL,           -- riferimento logico a store_db.chains
  card_number_enc  BYTEA NOT NULL,          -- AES-256-GCM (in produzione chiave da KMS)
  card_last4       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, chain_id)
);
