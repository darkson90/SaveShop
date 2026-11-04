"""Esecuzione: python -m ingestion. INGESTION_MODE=once (CronJob) oppure loop (sviluppo)."""
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.request
import uuid

import pika

from .sources import RawPrice, Source
from .scraping import PoliteFetcher
from .sources.carrefour import CarrefourSource
from .sources.demo import DemoSource
from .sources.feeds import FeedSource
from .sources.open_prices import OpenPricesSource
from .sources.osm_stores import OsmStoresSource
from .sources.carrefour import FORMATS as CARREFOUR_FORMATS
from .sources.chains import CHAIN_SOURCES

AMQP_URL = os.environ.get("AMQP_URL", "amqp://guest:guest@rabbitmq:5672")
CATALOG_URL = os.environ.get("CATALOG_URL", "http://catalog:3000")
STORE_URL = os.environ.get("STORE_URL", "http://store:3000")
SERVICE_TOKEN = os.environ.get("SERVICE_TOKEN", "")
EXCHANGE = "spesa.events"
BATCH_SIZE = 500
CONFIG_URL = os.environ.get("CONFIG_URL", "http://config:3000")


def panel_settings() -> dict:
    """Parametri impostati dal pannello di amministrazione; vuoto se il Config Service non risponde."""
    try:
        return get_json(f"{CONFIG_URL}/api/v1/internal/settings", retries=3)["values"]
    except Exception as exc:  # senza pannello valgono variabili d'ambiente e predefiniti
        print(f"[ingestion] parametri del pannello non disponibili ({exc}): uso l'ambiente", flush=True)
        return {}


def setting(values: dict, key: str, env: str, default, cast=str):
    """Valore effettivo: pannello, poi variabile d'ambiente, poi predefinito (come nei servizi Node)."""
    if key in values:
        return values[key]
    raw = os.environ.get(env)
    if raw not in (None, ""):
        try:
            return cast(raw)
        except ValueError:
            print(f"[ingestion] {env} non valido: {raw!r}", flush=True)
    return default


def as_list(raw: str) -> list[str]:
    return [x.strip() for x in raw.split(",") if x.strip()]


def as_bool(raw: str) -> bool:
    return raw.strip().lower() in ("1", "true", "si", "sì", "yes")


DEFAULT_SOURCES = ["demo", "open_prices", "osm_stores", "carrefour", "lidl", "aldi", "eurospin", "penny"]


def area(values: dict) -> tuple[float, float, float]:
    """Area di raccolta (centro e raggio): Open Prices e listini d'insegna dei siti dei supermercati."""
    return (
        float(setting(values, "ingestion.openPricesLat", "OPEN_PRICES_LAT", 46.14, float)),  # Belluno
        float(setting(values, "ingestion.openPricesLon", "OPEN_PRICES_LON", 12.22, float)),
        float(setting(values, "ingestion.openPricesRadiusKm", "OPEN_PRICES_RADIUS_KM", 40, float)),
    )


def polite_fetcher(values: dict) -> PoliteFetcher:
    """Un fetcher per sito: pausa e tetto di pagine valgono per ciascuna catena."""
    return PoliteFetcher(
        delay_seconds=float(setting(values, "scraping.delaySeconds", "SCRAPING_DELAY_SECONDS", 1.5, float)),
        max_requests=int(setting(values, "scraping.maxRequestsPerRun", "SCRAPING_MAX_REQUESTS", 1500, int)),
    )


def build_sources(values: dict | None = None) -> list[Source]:
    """Fonti attive (parametro ingestion.sources): vedi DEFAULT_SOURCES, più "feeds"."""
    values = panel_settings() if values is None else values
    lat, lon, radius = area(values)
    sources: list[Source] = []
    active = setting(values, "ingestion.sources", "INGESTION_SOURCES", DEFAULT_SOURCES, as_list)
    for name in active:
        if name == "demo":
            sources.append(DemoSource())
        elif name == "open_prices":
            sources.append(OpenPricesSource(
                lat=lat, lon=lon, radius_km=radius,
                days=int(setting(values, "ingestion.openPricesDays", "OPEN_PRICES_DAYS", 60, int)),
            ))
        elif name == "feeds":
            # URL o percorsi dei feed dei negozi partner (docs/feed-format.md).
            sources.append(FeedSource(setting(values, "ingestion.feeds", "INGESTION_FEEDS", [], as_list)))
        elif name == "osm_stores":
            whole_italy = bool(setting(values, "ingestion.osmWholeItaly", "OSM_WHOLE_ITALY", True, as_bool))
            sources.append(OsmStoresSource(
                every_days=int(setting(values, "ingestion.osmEveryDays", "OSM_EVERY_DAYS", 1, int)),
                lat=None if whole_italy else lat, lon=None if whole_italy else lon,
                radius_km=None if whole_italy else radius,
                # Carrefour crea i suoi negozi dal proprio sito, con i codici del sito: niente doppioni.
                skip_chains=CARREFOUR_FORMATS.values() if "carrefour" in active else (),
            ))
        elif name in CHAIN_SOURCES:
            sources.append(CHAIN_SOURCES[name](polite_fetcher(values)))
        elif name == "carrefour":
            sources.append(CarrefourSource(
                polite_fetcher(values),
                formats=setting(values, "scraping.carrefourFormats", "CARREFOUR_FORMATS", ["iper", "market", "express", "altri"], as_list),
                create_products=bool(setting(values, "scraping.createProducts", "SCRAPING_CREATE_PRODUCTS", True, as_bool)),
            ))
        else:
            print(f"[ingestion] fonte sconosciuta ignorata: {name}", flush=True)
    return sources


def get_json(url: str, retries: int = 30) -> dict:
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"X-Service-Token": SERVICE_TOKEN})
            with urllib.request.urlopen(req, timeout=10) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError:
            raise  # 401/404: configurazione errata, inutile riprovare
        except OSError:
            if attempt == retries:
                raise
            time.sleep(min(attempt, 5))
    raise RuntimeError("irraggiungibile")


def post_json(url: str, body: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def create_missing(
    raw: list[RawPrice], products: dict[str, str], stores: dict[str, str], extra_stores: dict | None = None,
) -> tuple[int, int]:
    """Crea nel catalogo e nello Store Service i prodotti e i negozi nuovi portati da una fonte."""
    new_products = {r.ean: r.product for r in raw if r.ean.isdigit() and r.ean not in products and r.product and r.product.name}
    new_stores = {r.store_ref: r.store for r in raw if r.store_ref not in stores and r.store}
    new_stores.update({ref: st for ref, st in (extra_stores or {}).items() if ref not in stores})
    for i in range(0, len(new_products), BATCH_SIZE):
        chunk = list(new_products.items())[i:i + BATCH_SIZE]
        res = post_json(f"{CATALOG_URL}/api/v1/internal/products/upsert", {"items": [
            {"ean": ean, "name": p.name, "brand": p.brand, "categories": list(p.categories),
             "quantity": p.quantity, "quantityUnit": p.quantity_unit, "source": p.source}
            for ean, p in chunk
        ]})
        products.update({x["ean"]: x["id"] for x in res["items"]})
    for i in range(0, len(new_stores), BATCH_SIZE):
        chunk = list(new_stores.items())[i:i + BATCH_SIZE]
        res = post_json(f"{STORE_URL}/api/v1/internal/stores/upsert", {"items": [
            {"externalRef": ref, "name": st.name, "chain": st.chain, "address": st.address, "lat": st.lat, "lng": st.lng}
            for ref, st in chunk
        ]})
        stores.update({x["externalRef"]: x["id"] for x in res["items"]})
    return len(new_products), len(new_stores)


def resolve_maps() -> tuple[dict[str, str], dict[str, str]]:
    """Abbinamento ai codici interni: EAN -> productId, codice negozio -> storeId."""
    eans = get_json(f"{CATALOG_URL}/api/v1/internal/products/eans")["items"]
    refs = get_json(f"{STORE_URL}/api/v1/internal/stores/by-ref")["items"]
    return {p["ean"]: p["id"] for p in eans}, {s["externalRef"]: s["id"] for s in refs}


def match_names(raw: list[RawPrice], products: dict[str, str], min_confidence: float) -> int:
    """Prodotti senza codice a barre (volantini, siti senza EAN): abbinati per nome al catalogo.

    Aggiunge a `products` le chiavi "name:<testo>" abbinate con somiglianza almeno `min_confidence`;
    gli altri restano scartati (meglio un prezzo in meno che uno sul prodotto sbagliato).
    """
    names = sorted({r.product.name for r in raw if not r.ean and r.product and r.product.name and f"name:{r.product.name}" not in products})
    matched = 0
    for i in range(0, len(names), 150):
        chunk = names[i:i + 150]
        res = post_json(f"{CATALOG_URL}/api/v1/internal/products/match-batch", {"q": chunk})
        for text, m in zip(chunk, res["items"]):
            if m.get("product") and float(m.get("confidence") or 0) >= min_confidence:
                products[f"name:{text}"] = m["product"]["id"]
                matched += 1
    return matched


def price_key(r: RawPrice) -> str:
    return r.ean or (f"name:{r.product.name}" if r.product else "")


def chain_members(targets: dict[str, list[str]], lat: float, lon: float, radius: float) -> dict[str, list[str]]:
    """Per i listini d'insegna ("chains:..."): i punti vendita di quelle insegne nell'area di raccolta."""
    members: dict[str, list[str]] = {}
    for ref, chains in targets.items():
        res = post_json(f"{STORE_URL}/api/v1/internal/stores/chain-members",
                        {"chains": chains, "lat": lat, "lng": lon, "radiusKm": radius})
        members[ref] = [x["id"] for x in res["items"]]
    return members


def normalize(
    raw: list[RawPrice], products: dict[str, str], stores: dict[str, str], members: dict[str, list[str]] | None = None,
) -> tuple[list[dict], int]:
    rows, skipped = [], 0
    for r in raw:
        product_id = products.get(price_key(r))
        store_ids = (members or {}).get(r.store_ref) if r.store_ref.startswith("chains:") else [stores.get(r.store_ref)]
        store_ids = [s for s in store_ids or [] if s]
        if not product_id or not store_ids or r.price <= 0:
            skipped += 1  # in produzione: coda di revisione per il matching manuale
            continue
        for store_id in store_ids:
            rows.append({
                "storeId": store_id,
                "productId": product_id,
                "price": round(r.price, 2),
                "promoPrice": round(r.promo_price, 2) if r.promo_price else None,
                "loyaltyOnly": r.loyalty_only,
                "observedOn": r.observed_on,
                "promoUntil": r.promo_until,
                "expiresOn": r.expires_on,
            })
    return rows, skipped


def publish_confirmed(channel, envelope: dict, retries: int = 60) -> None:
    """Pubblica con conferma: se nessuna coda è ancora legata (primo avvio) riprova invece di perdere il lotto."""
    for attempt in range(1, retries + 1):
        try:
            channel.basic_publish(
                exchange=EXCHANGE,
                routing_key="PricesUpdated",
                body=json.dumps(envelope).encode(),
                properties=pika.BasicProperties(content_type="application/json", delivery_mode=2,
                                                message_id=envelope["eventId"]),
                mandatory=True,
            )
            return
        except pika.exceptions.UnroutableError:
            if attempt == retries:
                raise
            time.sleep(2)


def publish(channel, source: str, rows: list[dict], started_at: str) -> None:
    run_id = str(uuid.uuid4())
    finished_at = dt.datetime.now(dt.timezone.utc).isoformat()
    for i in range(0, len(rows), BATCH_SIZE):
        envelope = {
            "eventId": str(uuid.uuid4()),
            "type": "PricesUpdated",
            "occurredAt": finished_at,
            "payload": {
                "runId": run_id,
                "source": source,
                "startedAt": started_at,
                "finishedAt": finished_at,
                "validFrom": dt.date.today().isoformat(),
                "prices": rows[i:i + BATCH_SIZE],
            },
        }
        publish_confirmed(channel, envelope)


def run_once() -> None:
    values = panel_settings()
    lat, lon, radius = area(values)
    products, stores = resolve_maps()
    connection = pika.BlockingConnection(pika.URLParameters(AMQP_URL))
    try:
        channel = connection.channel()
        channel.exchange_declare(exchange=EXCHANGE, exchange_type="topic", durable=True)
        channel.confirm_delivery()
        for source in build_sources(values):
            started_at = dt.datetime.now(dt.timezone.utc).isoformat()
            try:
                if hasattr(source, "prepare"):
                    source.prepare(products, stores)
                raw = list(source.fetch())
                created_products, created_stores = create_missing(raw, products, stores, getattr(source, "found_stores", None))
                if any(not r.ean for r in raw):
                    match_names(raw, products, float(setting(values, "scraping.minNameMatch", "SCRAPING_MIN_NAME_MATCH", 0.6, float)))
                targets = getattr(source, "chain_targets", None)
                members = chain_members(targets, lat, lon, radius) if targets else None
            except Exception as exc:  # una fonte esterna irraggiungibile non blocca le altre
                print(f"[ingestion] {source.name}: fonte non disponibile ({exc})", flush=True)
                continue
            rows, skipped = normalize(raw, products, stores, members)
            publish(channel, source.name, rows, started_at)
            extra = f", nuovi: {created_products} prodotti, {created_stores} negozi" if created_products or created_stores else ""
            print(f"[ingestion] {source.name}: {len(rows)} prezzi pubblicati, {skipped} scartati{extra}", flush=True)
    finally:
        connection.close()


def main() -> None:
    mode = os.environ.get("INGESTION_MODE", "once")
    interval = float(os.environ.get("INGESTION_INTERVAL_HOURS", "24")) * 3600
    while True:
        try:
            run_once()
        except Exception as exc:  # una fonte in errore non deve fermare le esecuzioni successive
            print(f"[ingestion] esecuzione fallita: {exc}", flush=True)
            if mode == "once":
                raise
        if mode == "once":
            return
        time.sleep(interval)


if __name__ == "__main__":
    main()
