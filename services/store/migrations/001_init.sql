CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE chains (
  id    UUID PRIMARY KEY,
  name  TEXT UNIQUE NOT NULL
);

CREATE TABLE stores (
  id            UUID PRIMARY KEY,
  chain_id      UUID NOT NULL REFERENCES chains(id),
  name          TEXT NOT NULL,
  address       TEXT NOT NULL,
  location      GEOGRAPHY(Point, 4326) NOT NULL,
  external_ref  TEXT UNIQUE,              -- codice del punto vendita presso la fonte dati (Ingestion)
  active        BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX stores_location_gix ON stores USING GIST (location);

CREATE TABLE excluded_stores (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL,
  store_id    UUID REFERENCES stores(id),
  chain_id    UUID REFERENCES chains(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((store_id IS NULL) <> (chain_id IS NULL))   -- esclude un negozio OPPURE un'insegna
);
CREATE UNIQUE INDEX excluded_unique ON excluded_stores (user_id, COALESCE(store_id, chain_id));
