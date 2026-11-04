"""Fonte dimostrativa: genera listini plausibili e deterministici per giorno, sui dati seed.

Sostituirla (o affiancarla) con fonti reali in sources/: API ufficiali, feed, volantini digitali,
oppure scraper che rispettano robots.txt e i termini d'uso (esempio: sources/carrefour.py con gli strumenti di scraping/).
"""
import datetime as dt
import random
from typing import Iterable

from . import RawPrice

# Prezzo base indicativo in euro per EAN del catalogo seed.
BASE_PRICES = {
    "8000000000101": 1.29, "8000000000102": 1.39, "8000000000103": 1.49, "8000000000104": 0.99,
    "8000000000105": 5.90, "8000000000106": 2.49, "8000000000107": 2.19, "8000000000108": 1.69,
    "8000000000109": 1.79, "8000000000110": 1.59, "8000000000111": 1.89, "8000000000112": 2.29,
    "8000000000113": 2.99, "8000000000114": 1.09, "8000000000115": 1.49, "8000000000116": 1.39,
    "8000000000117": 9.90, "8000000000118": 5.49, "8000000000119": 3.49, "8000000000120": 0.99,
    "8000000000121": 0.99, "8000000000122": 3.29, "8000000000123": 1.19, "8000000000124": 8.99,
    "8000000000125": 3.99, "8000000000126": 2.49, "8000000000127": 1.99, "8000000000128": 1.29,
    "8000000000129": 1.69, "8000000000130": 3.59, "8000000000131": 2.79, "8000000000132": 2.99,
}

# Livello di prezzo per punto vendita (1.0 = media) e quota di assortimento.
STORES = {
    "superrisparmio-pieve":   {"level": 0.96, "assortment": 0.97, "loyalty_promos": True},
    "superrisparmio-cortina": {"level": 1.08, "assortment": 0.95, "loyalty_promos": True},
    "mercatopiu-calalzo":     {"level": 1.00, "assortment": 0.98, "loyalty_promos": False},
    "mercatopiu-valle":       {"level": 1.02, "assortment": 0.92, "loyalty_promos": False},
    "discount-borca":         {"level": 0.86, "assortment": 0.80, "loyalty_promos": False},
    "bottega-vodo":           {"level": 1.15, "assortment": 0.70, "loyalty_promos": False},
}


def _round_price(value: float) -> float:
    """Arrotonda ai prezzi "psicologici" tipici dello scaffale (x,x9)."""
    cents = max(19, int(round(value * 100)))
    return round((cents // 10) * 10 / 100 + 0.09, 2)


class DemoSource:
    name = "demo:listini-seed"

    def __init__(self, day: dt.date | None = None):
        self.day = day or dt.date.today()

    def fetch(self) -> Iterable[RawPrice]:
        for store_ref, cfg in STORES.items():
            rng = random.Random(f"{store_ref}:{self.day.isoformat()}")
            for ean, base in BASE_PRICES.items():
                if rng.random() > cfg["assortment"]:
                    continue  # prodotto non a scaffale in questo punto vendita
                price = _round_price(base * cfg["level"] * rng.uniform(0.95, 1.05))
                promo, loyalty = None, False
                if rng.random() < 0.15:
                    promo = _round_price(price * rng.uniform(0.70, 0.85))
                    loyalty = cfg["loyalty_promos"] and rng.random() < 0.5
                yield RawPrice(store_ref, ean, price, promo, loyalty)
