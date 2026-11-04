-- Il raggio massimo ora è un parametro del pannello (geo.maxRadiusKm, fino a 100 km):
-- il vincolo del database si allarga di conseguenza; il limite effettivo lo applica il servizio.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_default_radius_km_check;
ALTER TABLE users ADD CONSTRAINT users_default_radius_km_check CHECK (default_radius_km BETWEEN 1 AND 100);
