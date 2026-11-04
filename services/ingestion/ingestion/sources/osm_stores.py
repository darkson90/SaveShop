"""Tutti i supermercati d'Italia da OpenStreetMap (Overpass API), con insegna normalizzata.

Non porta prezzi: crea i punti vendita nello Store Service (codice "osm:node:123", lo stesso usato da Open
Prices, quindi niente doppioni) così che i listini d'insegna letti dai siti delle catene abbiano negozi a cui
applicarsi. Dati © OpenStreetMap contributors, licenza ODbL: vanno citati.

Una query sola per l'Italia intera (circa 25.000 punti vendita), ogni notte o ogni `every_days` giorni:
l'Overpass pubblico chiede meno di 10.000 query e 1 GB al giorno per utente, siamo molto sotto.
"""
import datetime as dt
import json
import os
import re
import urllib.parse
import urllib.request
from typing import Callable, Iterable

from ..scraping.http import USER_AGENT
from . import RawPrice, StoreInfo

OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")

# Insegne italiane: nome canonico e varianti con cui compaiono nei tag brand/name di OpenStreetMap.
# I formati distinti (Conad City, Carrefour Express...) restano insegne separate: prezzi e
# blacklist possono differire. L'ordine conta: le varianti più specifiche prima.
BRANDS: list[tuple[str, str]] = [
    ("Carrefour Express", r"carrefour\s*express"),
    ("Carrefour Market", r"carrefour\s*market"),
    ("Carrefour Iper", r"carrefour\s*iper|ipermercato\s*carrefour"),
    ("Carrefour", r"carrefour"),
    ("Conad Superstore", r"conad\s*superstore"),
    ("Conad City", r"conad\s*city"),
    ("Spazio Conad", r"spazio\s*conad"),
    ("Sapori & Dintorni Conad", r"sapori\s*&?\s*dintorni"),
    ("Conad", r"conad"),
    ("Margherita Conad", r"margherita"),
    ("Todis", r"todis"),
    ("Esselunga", r"esselunga|la\s*esse"),
    ("Coop", r"\bcoop\b|ipercoop|incoop|coop\.fi|unicoop|novacoop|coop\s*alleanza"),
    ("Lidl", r"\blidl\b"),
    ("Eurospin", r"eurospin"),
    ("Aldi", r"\baldi\b"),
    ("Penny", r"penny"),
    ("MD", r"^md\b|md\s*discount|md\s*spa"),
    ("In's Mercato", r"in'?s\s*mercato"),
    ("Interspar", r"interspar"),
    ("Eurospar", r"eurospar"),
    ("Despar", r"despar|\bspar\b"),
    ("Famila", r"famila|iperfamila"),
    ("A&O", r"^a\s*&\s*o\b|\ba&o\b"),
    ("Pam", r"\bpam\b|pam\s*local|pam\s*panorama"),
    ("Panorama", r"panorama"),
    ("Iper", r"^iper\b|iper\s*la\s*grande"),
    ("U2 Supermercato", r"\bu2\b"),
    ("Unes", r"\bunes\b"),
    ("Tigros", r"tigros"),
    ("Bennet", r"bennet"),
    ("Crai", r"\bcrai\b"),
    ("Sigma", r"\bsigma\b"),
    ("Tuodì", r"tuod[iì]"),
    ("Dpiù", r"d\s*pi[uù]"),
    ("Prix", r"\bprix\b"),
    ("Ekom", r"\bekom\b"),
    ("Dok", r"\bdok\b"),
    ("Mercatò", r"mercat[oò]\b"),
    ("Basko", r"basko"),
    ("Il Gigante", r"il\s*gigante"),
    ("Iperal", r"iperal"),
    ("Poli", r"supermercati\s*poli|\bpoli\b"),
    ("Gros", r"\bgros\b"),
    ("Pewex", r"pewex"),
    ("Decò", r"\bdec[oò]\b"),
    ("Simply", r"\bsimply\b"),
    ("Ali", r"\bal[iì]\b|alìper"),
    ("Cadoro", r"cadoro"),
    ("Visotto", r"visotto"),
    ("Emisfero", r"emisfero"),
    ("Maxi Dì", r"maxi\s*d[iì]"),
    ("Dimeglio", r"dimeglio"),
    ("Sisa", r"\bsisa\b"),
    ("Coal", r"\bcoal\b"),
    ("Paghi Poco", r"paghi\s*poco"),
    ("NaturaSì", r"naturas[iì]"),
]
_COMPILED = [(name, re.compile(pattern, re.I)) for name, pattern in BRANDS]


def canonical_brand(brand: str | None, name: str | None) -> str | None:
    """Insegna canonica dal tag brand (preferito) o dal nome; None se indipendente o sconosciuta."""
    for text in (brand, name):
        if not text:
            continue
        for canonical, pattern in _COMPILED:
            if pattern.search(text):
                return canonical
    return brand.strip()[:80] if brand and brand.strip() else None


def build_query(lat: float | None = None, lon: float | None = None, radius_km: float | None = None) -> str:
    """Supermercati e minimarket con insegna: in tutta Italia, oppure nel raggio indicato."""
    if lat is not None and lon is not None and radius_km:
        scope, filt = "", f"(around:{int(radius_km * 1000)},{lat},{lon})"
    else:
        scope, filt = 'area["ISO3166-1"="IT"][admin_level=2]->.it;\n', "(area.it)"
    return (
        f"[out:json][timeout:300];\n{scope}"
        f'(nwr["shop"="supermarket"]{filt};nwr["shop"="convenience"]["brand"]{filt};);\n'
        "out center tags;"
    )


def _http_post(url: str, data: str) -> dict:
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode({"data": data}).encode(), method="POST",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=360) as res:
        return json.loads(res.read())


def to_store(element: dict) -> tuple[str, StoreInfo] | None:
    tags = element.get("tags") or {}
    lat = element.get("lat", (element.get("center") or {}).get("lat"))
    lon = element.get("lon", (element.get("center") or {}).get("lon"))
    if lat is None or lon is None or tags.get("disused:shop") or tags.get("opening_hours") == "closed":
        return None
    chain = canonical_brand(tags.get("brand"), tags.get("name"))
    name = (tags.get("name") or chain or "Supermercato").strip()
    if chain and chain.lower() not in name.lower():
        name = f"{chain} {name}"
    city = tags.get("addr:city") or ""
    street = " ".join(p for p in [tags.get("addr:street"), tags.get("addr:housenumber")] if p)
    address = ", ".join(p for p in [street, city] if p)
    return f"osm:{element['type']}:{element['id']}", StoreInfo(
        name=name[:120], chain=chain, lat=float(lat), lng=float(lon), address=address[:200],
    )


class OsmStoresSource:
    """Fonte senza prezzi: popola `found_stores`, che l'ingestion crea nello Store Service."""

    name = "osm:supermercati"

    def __init__(
        self,
        every_days: int = 1,
        lat: float | None = None,
        lon: float | None = None,
        radius_km: float | None = None,
        skip_chains: Iterable[str] = (),
        post: Callable[[str, str], dict] = _http_post,
        today: dt.date | None = None,
    ):
        self.every_days = max(1, every_days)
        self.lat, self.lon, self.radius_km = lat, lon, radius_km
        self.skip_chains = {c.lower() for c in skip_chains}
        self.post = post
        self.today = today or dt.date.today()
        self.known: set[str] = set()
        self.found_stores: dict[str, StoreInfo] = {}

    def prepare(self, products: dict[str, str], stores: dict[str, str]) -> None:
        self.known = set(stores)

    def due(self) -> bool:
        # Primo giro (nessun negozio OSM ancora noto) oppure un giorno ogni `every_days`.
        return not any(ref.startswith("osm:") for ref in self.known) or self.today.toordinal() % self.every_days == 0

    def fetch(self) -> Iterable[RawPrice]:
        if not self.due():
            print(f"[osm] elenco negozi aggiornato ogni {self.every_days} giorni: oggi no", flush=True)
            return []
        data = self.post(OVERPASS_URL, build_query(self.lat, self.lon, self.radius_km))
        total = 0
        for element in data.get("elements") or []:
            parsed = to_store(element)
            if not parsed:
                continue
            total += 1
            ref, store = parsed
            # Insegne coperte da una fonte che crea già i suoi negozi (es. Carrefour dal suo sito).
            if store.chain and store.chain.lower() in self.skip_chains:
                continue
            if ref not in self.known:
                self.found_stores[ref] = store
        print(f"[osm] {total} supermercati letti, {len(self.found_stores)} nuovi", flush=True)
        return []
