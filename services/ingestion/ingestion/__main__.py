"""Esecuzione: python -m ingestion. INGESTION_MODE=once (CronJob) oppure loop (sviluppo)."""
import datetime as dt
import json
import os
import time
import urllib.request
import uuid

import pika

from .sources import RawPrice
from .sources.demo import DemoSource

AMQP_URL = os.environ.get("AMQP_URL", "amqp://guest:guest@rabbitmq:5672")
CATALOG_URL = os.environ.get("CATALOG_URL", "http://catalog:3000")
STORE_URL = os.environ.get("STORE_URL", "http://store:3000")
EXCHANGE = "spesa.events"
BATCH_SIZE = 500


def get_json(url: str, retries: int = 30) -> dict:
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=10) as res:
                return json.loads(res.read())
        except OSError:
            if attempt == retries:
                raise
            time.sleep(min(attempt, 5))
    raise RuntimeError("irraggiungibile")


def resolve_maps() -> tuple[dict[str, str], dict[str, str]]:
    """Abbinamento ai codici interni: EAN -> productId, codice negozio -> storeId."""
    eans = get_json(f"{CATALOG_URL}/api/v1/internal/products/eans")["items"]
    refs = get_json(f"{STORE_URL}/api/v1/internal/stores/by-ref")["items"]
    return {p["ean"]: p["id"] for p in eans}, {s["externalRef"]: s["id"] for s in refs}


def normalize(raw: list[RawPrice], products: dict[str, str], stores: dict[str, str]) -> tuple[list[dict], int]:
    rows, skipped = [], 0
    for r in raw:
        product_id, store_id = products.get(r.ean), stores.get(r.store_ref)
        if not product_id or not store_id or r.price <= 0:
            skipped += 1  # in produzione: coda di revisione per il matching manuale
            continue
        rows.append({
            "storeId": store_id,
            "productId": product_id,
            "price": round(r.price, 2),
            "promoPrice": round(r.promo_price, 2) if r.promo_price else None,
            "loyaltyOnly": r.loyalty_only,
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
    products, stores = resolve_maps()
    connection = pika.BlockingConnection(pika.URLParameters(AMQP_URL))
    try:
        channel = connection.channel()
        channel.exchange_declare(exchange=EXCHANGE, exchange_type="topic", durable=True)
        channel.confirm_delivery()
        for source in [DemoSource()]:
            started_at = dt.datetime.now(dt.timezone.utc).isoformat()
            rows, skipped = normalize(list(source.fetch()), products, stores)
            publish(channel, source.name, rows, started_at)
            print(f"[ingestion] {source.name}: {len(rows)} prezzi pubblicati, {skipped} scartati", flush=True)
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
