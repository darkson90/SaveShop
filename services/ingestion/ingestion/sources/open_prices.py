"""Open Prices (Open Food Facts): prezzi reali segnalati dalla comunità, con scontrino o cartellino.

API pubblica e gratuita: https://prices.openfoodfacts.org/api (documentazione:
https://openfoodfacts.github.io/documentation/docs/Open-prices/). Dati con licenza ODbL: vanno citati
("Prezzi da Open Prices, ODbL") e le modifiche alla base dati condivise alle stesse condizioni.

Ogni prezzo è un'osservazione datata: per ogni coppia (punto vendita, prodotto) teniamo la più recente
degli ultimi `days` giorni. I punti vendita sono luoghi OpenStreetMap ("osm:node:123"): quelli nuovi
vengono creati nello Store Service, i prodotti nuovi nel catalogo, abbinati per codice a barre.
"""
import datetime as dt
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Callable, Iterable

from . import ProductInfo, RawPrice, StoreInfo

# Sovrascrivibile per i test end-to-end (server locale con risposte registrate).
BASE_URL = os.environ.get("OPEN_PRICES_URL", "https://prices.openfoodfacts.org/api/v1/prices")
USER_AGENT = "SaveShop-Ingestion/0.2 (+https://github.com/darkson90/SaveShop)"
PAGE_SIZE = 100


def _http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


class OpenPricesSource:
    name = "api:open-prices"

    def __init__(
        self,
        lat: float,
        lon: float,
        radius_km: float = 30,
        days: int = 90,
        max_pages: int = 20,
        delay_seconds: float = 1.0,
        get_json: Callable[[str], dict] = _http_get_json,
        today: dt.date | None = None,
    ):
        self.lat, self.lon, self.radius_km = lat, lon, radius_km
        self.days, self.max_pages, self.delay = days, max_pages, delay_seconds
        self.get_json = get_json
        self.today = today or dt.date.today()

    def _pages(self) -> Iterable[dict]:
        params = {
            "lat": self.lat,
            "lon": self.lon,
            "radius_km": self.radius_km,
            "date__gte": (self.today - dt.timedelta(days=self.days)).isoformat(),
            "type": "PRODUCT",          # solo prezzi con codice a barre (non "categoria al kg")
            "currency": "EUR",
            "order_by": "-date",
            "size": PAGE_SIZE,
        }
        for page in range(1, self.max_pages + 1):
            data = self.get_json(f"{BASE_URL}?{urllib.parse.urlencode({**params, 'page': page})}")
            yield data
            if page >= int(data.get("pages") or 1):
                break
            time.sleep(self.delay)  # uso rispettoso dell'API pubblica

    def fetch(self) -> Iterable[RawPrice]:
        latest: dict[tuple[str, str], RawPrice] = {}
        for data in self._pages():
            for item in data.get("items") or []:
                price = to_raw_price(item)
                if price is None:
                    continue
                # Ordinati dal più recente: la prima osservazione per coppia è quella valida.
                latest.setdefault((price.store_ref, price.ean), price)
        return list(latest.values())


def to_raw_price(item: dict) -> RawPrice | None:
    """Converte un prezzo di Open Prices; None se incompleto o non utilizzabile."""
    code = str(item.get("product_code") or "").strip()
    loc = item.get("location") or {}
    if not code.isdigit() or not (8 <= len(code) <= 14) or item.get("duplicate_of"):
        return None
    if loc.get("type") not in (None, "OSM") or loc.get("osm_lat") is None or loc.get("osm_lon") is None:
        return None
    try:
        price = float(item["price"])
    except (KeyError, TypeError, ValueError):
        return None
    if price <= 0:
        return None

    regular, promo = price, None
    if item.get("price_is_discounted"):
        without = item.get("price_without_discount")
        if not without or float(without) <= price:
            return None  # sconto senza prezzo pieno: non sappiamo quanto vale il prezzo normale
        regular, promo = float(without), price

    osm_type = str(loc.get("osm_type") or item.get("location_osm_type") or "node").lower()
    osm_id = loc.get("osm_id") or item.get("location_osm_id")
    product = item.get("product") or {}
    address = ", ".join(p for p in [loc.get("osm_address_city"), loc.get("osm_address_postcode")] if p)
    return RawPrice(
        store_ref=f"osm:{osm_type}:{osm_id}",
        ean=code,
        price=round(regular, 2),
        promo_price=round(promo, 2) if promo else None,
        loyalty_only=item.get("discount_type") == "LOYALTY_PROGRAM",
        store=StoreInfo(
            name=loc.get("osm_name") or "Punto vendita",
            chain=loc.get("osm_brand"),
            lat=float(loc["osm_lat"]),
            lng=float(loc["osm_lon"]),
            address=address,
        ),
        product=ProductInfo(
            name=product.get("product_name") or item.get("product_name") or "",
            brand=(product.get("brands") or None),
            categories=tuple(product.get("categories_tags") or ()),
            quantity=product.get("product_quantity"),
            quantity_unit=product.get("product_quantity_unit"),
            source=product.get("source"),
        ),
    )
