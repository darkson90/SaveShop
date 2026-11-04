-- La vista materializzata veniva ricalcolata per intero (tutti gli utenti, tutti gli acquisti) a ogni
-- spesa chiusa: costo che cresce con lo storico. Ora è una tabella aggiornata riga per riga nella
-- stessa transazione dell'acquisto, con il nome della categoria già risolto.
DROP MATERIALIZED VIEW IF EXISTS user_category_spend;

CREATE TABLE user_category_spend (
  user_id        UUID NOT NULL,
  category_name  TEXT NOT NULL,
  month          DATE NOT NULL,
  spent_eur      NUMERIC(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month, category_name)
);

INSERT INTO user_category_spend (user_id, category_name, month, spent_eur)
SELECT p.user_id, COALESCE(r.category_name, 'Altro'), date_trunc('month', p.purchased_at)::date,
       SUM(l.quantity * l.unit_paid)
FROM purchases p
JOIN purchase_lines l ON l.purchase_id = p.id
LEFT JOIN products_ref r ON r.product_id = l.product_id
GROUP BY 1, 2, 3;

-- Top prodotti per periodo: lettura per utente e data.
CREATE INDEX purchase_lines_product ON purchase_lines (purchase_id, product_id);
