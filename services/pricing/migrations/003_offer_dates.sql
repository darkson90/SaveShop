-- Scadenze delle offerte lette da volantini e pagine promozioni:
--   promo_until: ultimo giorno del prezzo scontato (dopo vale il prezzo pieno);
--   expires_on:  ultimo giorno dell'intera riga, per le fonti che pubblicano solo offerte
--                (finita l'offerta quel negozio non ha più un prezzo noto per il prodotto).
ALTER TABLE prices ADD COLUMN promo_until DATE;
ALTER TABLE prices ADD COLUMN expires_on DATE;
