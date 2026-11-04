"""Strumenti per leggere i prezzi dai siti dei supermercati in modo rispettoso.

Regole applicate a ogni richiesta (vedi http.PoliteFetcher):
- robots.txt del sito letto e rispettato: un percorso vietato non viene mai scaricato;
- User-Agent che identifica il servizio e rimanda al progetto, mai quello di un browser;
- una richiesta alla volta per dominio, con pausa (parametro scraping.delaySeconds);
- su 429 o 503 si aspetta (anche quanto chiesto da Retry-After) e dopo troppi errori ci si ferma;
- tetto di richieste per esecuzione (scraping.maxRequestsPerRun): il catalogo si copre a rotazione
  nelle notti successive invece di scaricare tutto insieme.
"""
from .ean import normalize_gtin
from .http import BudgetExhausted, PoliteFetcher, SiteUnavailable
from .jsonld import json_ld_products
from .sitemap import parse_sitemap

__all__ = ["BudgetExhausted", "PoliteFetcher", "SiteUnavailable", "json_ld_products", "normalize_gtin", "parse_sitemap"]
