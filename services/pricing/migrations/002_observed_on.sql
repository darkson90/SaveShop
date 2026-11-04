-- Data in cui il prezzo è stato osservato davvero (scontrino o cartellino per Open Prices, giorno
-- di pubblicazione per listini e feed). Serve a ignorare i prezzi che nessuna fonte conferma più.
ALTER TABLE prices ADD COLUMN observed_on DATE;
-- Lo storico chiuso non serve ai confronti: indice per la pulizia periodica.
CREATE INDEX prices_closed_idx ON prices (valid_to) WHERE valid_to IS NOT NULL;
