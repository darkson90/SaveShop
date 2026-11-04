-- La ricerca confronta lower(name): l'indice trigram deve essere sulla stessa espressione,
-- così i filtri LIKE '%…%' e "<%" (word similarity) lo usano invece di leggere tutta la tabella.
DROP INDEX IF EXISTS products_name_trgm;
CREATE INDEX products_name_lower_trgm ON products USING GIN (lower(name) gin_trgm_ops);
