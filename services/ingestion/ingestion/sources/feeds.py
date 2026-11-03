"""Feed partner: listini forniti direttamente da negozi e insegne (formato in docs/feed-format.md).

È la via per avere prezzi completi e aggiornati senza scraping: il negozio pubblica un file JSON
(su un URL o consegnato come file) e l'Ingestion lo legge a ogni giro. Righe non valide vengono
scartate una per una con il motivo, il resto del feed viene comunque importato.
"""
import datetime as dt
import json
import urllib.request
from typing import Callable, Iterable

from . import ProductInfo, RawPrice, StoreInfo

USER_AGENT = "SaveShop-Ingestion/0.2 (+https://github.com/darkson90/SaveShop)"
FORMAT_VERSION = 1


def _load(location: str) -> dict:
    if location.startswith(("http://", "https://")):
        req = urllib.request.Request(location, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())
    with open(location, encoding="utf-8") as f:
        return json.load(f)


class FeedError(ValueError):
    pass


def parse_feed(data: dict, today: dt.date | None = None) -> tuple[list[RawPrice], list[str]]:
    """Converte un feed in RawPrice. Restituisce anche gli avvisi sulle righe scartate."""
    today = today or dt.date.today()
    if data.get("version") != FORMAT_VERSION:
        raise FeedError(f"versione del formato non supportata: {data.get('version')!r} (attesa {FORMAT_VERSION})")
    publisher = str(data.get("publisher") or "").strip()
    if not publisher:
        raise FeedError("campo 'publisher' mancante")

    warnings: list[str] = []
    stores: dict[str, StoreInfo] = {}
    for i, s in enumerate(data.get("stores") or []):
        try:
            lat, lng = float(s["lat"]), float(s["lng"])
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                raise ValueError("coordinate fuori intervallo")
            stores[str(s["ref"]).strip()] = StoreInfo(
                name=str(s["name"]).strip(), chain=s.get("chain") or publisher, address=s.get("address") or "", lat=lat, lng=lng,
            )
        except (KeyError, TypeError, ValueError) as exc:
            warnings.append(f"negozio #{i + 1} scartato: {exc}")

    products = {}
    for p in data.get("products") or []:
        ean = str(p.get("ean") or "").strip()
        if ean.isdigit() and p.get("name"):
            products[ean] = ProductInfo(
                name=str(p["name"]).strip(), brand=p.get("brand"), categories=tuple(p.get("categories") or ()),
                quantity=p.get("quantity"), quantity_unit=p.get("quantityUnit"),
            )

    prices: list[RawPrice] = []
    for i, row in enumerate(data.get("prices") or []):
        try:
            store_ref = str(row["store"]).strip()
            ean = str(row["ean"]).strip()
            if store_ref not in stores:
                raise ValueError(f"negozio '{store_ref}' non presente in 'stores'")
            if not ean.isdigit() or not 8 <= len(ean) <= 14:
                raise ValueError(f"EAN non valido: {ean!r}")
            price = round(float(row["price"]), 2)
            promo = row.get("promoPrice")
            promo = round(float(promo), 2) if promo is not None else None
            if price <= 0 or (promo is not None and not 0 < promo < price):
                raise ValueError("prezzo o prezzo promo non valido")
            valid_to = row.get("promoUntil")
            if promo is not None and valid_to and dt.date.fromisoformat(valid_to) < today:
                promo = None  # promo scaduta: vale il prezzo pieno
            prices.append(RawPrice(
                store_ref=f"feed:{publisher}:{store_ref}",
                ean=ean,
                price=price,
                promo_price=promo,
                loyalty_only=bool(row.get("loyaltyOnly")) and promo is not None,
                store=stores[store_ref],
                product=products.get(ean),
            ))
        except (KeyError, TypeError, ValueError) as exc:
            warnings.append(f"prezzo #{i + 1} scartato: {exc}")
    return prices, warnings


class FeedSource:
    """Legge uno o più feed (URL o percorsi di file)."""

    def __init__(self, locations: list[str], load: Callable[[str], dict] = _load):
        self.locations = [loc for loc in locations if loc]
        self.load = load
        self.name = "feed:partner"

    def fetch(self) -> Iterable[RawPrice]:
        out: list[RawPrice] = []
        for loc in self.locations:
            try:
                prices, warnings = parse_feed(self.load(loc))
            except (OSError, ValueError) as exc:  # un feed rotto non blocca gli altri
                print(f"[ingestion] feed {loc} non importato: {exc}", flush=True)
                continue
            for w in warnings[:20]:
                print(f"[ingestion] feed {loc}: {w}", flush=True)
            out.extend(prices)
        return out
