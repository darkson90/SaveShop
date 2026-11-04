"""Dati strutturati schema.org (JSON-LD) nelle pagine prodotto: nome, marca, codice, prezzo."""
import json
import re
from html import unescape

_SCRIPT = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.S | re.I)


def _walk(node):
    if isinstance(node, list):
        for item in node:
            yield from _walk(item)
    elif isinstance(node, dict):
        yield node
        for key in ("@graph", "mainEntity", "itemListElement", "item"):
            if key in node:
                yield from _walk(node[key])


def _is_product(node: dict) -> bool:
    kind = node.get("@type")
    kinds = kind if isinstance(kind, list) else [kind]
    return "Product" in kinds


def json_ld_products(html: str) -> list[dict]:
    """Oggetti Product trovati nella pagina; i blocchi JSON non validi vengono ignorati."""
    found = []
    for block in _SCRIPT.findall(html or ""):
        text = block.strip()
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            try:
                data = json.loads(unescape(text))
            except json.JSONDecodeError:
                continue
        found.extend(node for node in _walk(data) if _is_product(node))
    return found


def offer_price(product: dict) -> float | None:
    """Prezzo dell'offerta principale (Offer o AggregateOffer.lowPrice), in euro."""
    offers = product.get("offers")
    if isinstance(offers, list):
        offers = offers[0] if offers else None
    if not isinstance(offers, dict):
        return None
    if offers.get("priceCurrency", "EUR") != "EUR":
        return None
    raw = offers.get("price", offers.get("lowPrice"))
    if raw is None and isinstance(offers.get("priceSpecification"), dict):
        raw = offers["priceSpecification"].get("price")
    return parse_price(raw)


def parse_price(raw) -> float | None:
    """'1.19', '1,19', '€ 1,19', 1.19 -> 1.19; None se mancante o non positivo."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        value = float(raw)
    else:
        text = re.sub(r"[^\d,.]", "", str(raw))
        if "," in text and "." in text:
            text = text.replace(".", "").replace(",", ".")  # 1.234,56
        else:
            text = text.replace(",", ".")
        try:
            value = float(text)
        except ValueError:
            return None
    return round(value, 2) if 0 < value < 10_000 else None


def brand_name(product: dict) -> str | None:
    brand = product.get("brand")
    if isinstance(brand, dict):
        brand = brand.get("name")
    if isinstance(brand, list):
        brand = brand[0] if brand else None
    return str(brand).strip() or None if brand else None


def gtin_candidates(product: dict) -> list[str]:
    """Campi che possono contenere il codice a barre, dal più affidabile."""
    keys = ("gtin13", "gtin", "gtin12", "gtin8", "gtin14", "ean", "sku", "mpn", "productID")
    return [str(product[k]) for k in keys if product.get(k)]
