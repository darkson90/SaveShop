-- Proiezione locale dei prodotti (da ProductCreated): nome e categoria di primo livello.
CREATE TABLE products_ref (
  product_id     UUID PRIMARY KEY,
  name           TEXT NOT NULL,
  category_id    UUID NOT NULL,
  category_name  TEXT NOT NULL
);

CREATE TABLE purchases (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL,
  list_id          UUID NOT NULL,
  store_id         UUID NOT NULL,
  purchased_at     TIMESTAMPTZ NOT NULL,
  total_paid       NUMERIC(10,2) NOT NULL,   -- tutto ciò che è stato pagato
  comparable_paid  NUMERIC(10,2) NOT NULL,   -- pagato sui soli articoli presenti anche nel riferimento
  total_reference  NUMERIC(10,2) NOT NULL    -- stessi articoli nel negozio più caro del raggio
);
CREATE INDEX purchases_user_time ON purchases (user_id, purchased_at DESC);

CREATE TABLE purchase_lines (
  purchase_id     UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL,
  category_id     UUID,                      -- copiato al momento dell'evento
  quantity        NUMERIC(8,3) NOT NULL,
  unit_paid       NUMERIC(10,2) NOT NULL,
  unit_reference  NUMERIC(10,2),             -- NULL se il riferimento non vende l'articolo
  PRIMARY KEY (purchase_id, product_id)
);

-- Spesa mensile per categoria; aggiornata a ogni PurchaseCompleted.
CREATE MATERIALIZED VIEW user_category_spend AS
SELECT p.user_id, l.category_id, date_trunc('month', p.purchased_at) AS month,
       SUM(l.quantity * l.unit_paid) AS spent_eur
FROM purchases p JOIN purchase_lines l ON l.purchase_id = p.id
GROUP BY 1, 2, 3;
CREATE UNIQUE INDEX user_category_spend_pk ON user_category_spend (user_id, category_id, month);
