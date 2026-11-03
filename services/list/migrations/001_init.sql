CREATE TABLE shopping_lists (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL,
  name        TEXT NOT NULL DEFAULT 'Spesa',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','purchased','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shopping_lists_user ON shopping_lists (user_id, id DESC);

CREATE TABLE list_items (
  id               UUID PRIMARY KEY,
  list_id          UUID NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  product_id       UUID,                    -- NULL se voce libera non ancora abbinata
  product_name     TEXT,                    -- copia del nome dal catalogo, per la visualizzazione
  category         TEXT,
  raw_text         TEXT NOT NULL,
  quantity         NUMERIC(8,3) NOT NULL DEFAULT 1,
  unit             TEXT NOT NULL DEFAULT 'pz',
  match_confidence NUMERIC(3,2),
  checked          BOOLEAN NOT NULL DEFAULT false,
  position         INTEGER NOT NULL,
  idempotency_key  TEXT,
  UNIQUE (list_id, idempotency_key)
);
CREATE INDEX list_items_list ON list_items (list_id, position);

-- Alimenta i chip "Compri spesso"
CREATE TABLE user_product_frequency (
  user_id      UUID,
  product_id   UUID,
  product_name TEXT NOT NULL,
  times_added  INTEGER NOT NULL DEFAULT 0,
  last_added   TIMESTAMPTZ,
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX upf_rank ON user_product_frequency (user_id, times_added DESC);
