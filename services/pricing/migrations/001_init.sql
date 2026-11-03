CREATE TABLE prices (
  store_id      UUID NOT NULL,
  product_id    UUID NOT NULL,
  price         NUMERIC(10,2) NOT NULL CHECK (price > 0),
  promo_price   NUMERIC(10,2),
  loyalty_only  BOOLEAN NOT NULL DEFAULT false,
  valid_from    DATE NOT NULL,
  valid_to      DATE,
  source        TEXT NOT NULL,              -- 'scraper:<insegna>' | 'api:<fornitore>'
  fetched_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (store_id, product_id, valid_from)
);
CREATE INDEX prices_product_idx ON prices (product_id, store_id) WHERE valid_to IS NULL;

CREATE TABLE scrape_runs (
  id             UUID PRIMARY KEY,
  source         TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  rows_upserted  INTEGER,
  status         TEXT NOT NULL CHECK (status IN ('running','ok','failed'))
);
