CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE categories (
  id         UUID PRIMARY KEY,
  parent_id  UUID REFERENCES categories(id),
  name       TEXT NOT NULL
);

CREATE TABLE products (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  brand        TEXT,
  ean          TEXT UNIQUE,
  category_id  UUID NOT NULL REFERENCES categories(id),
  unit         TEXT NOT NULL CHECK (unit IN ('pz','kg','l')),
  size         NUMERIC(8,3),
  popularity   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX products_name_trgm ON products USING GIN (name gin_trgm_ops);

-- Sinonimi per il parser ("latte ps" -> Latte parz. scremato)
CREATE TABLE product_aliases (
  alias       TEXT PRIMARY KEY,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX product_aliases_trgm ON product_aliases USING GIN (alias gin_trgm_ops);
