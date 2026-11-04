"""Carrefour Italia (carrefour.it): punti vendita e prezzi della spesa online.

Come legge il sito (struttura verificata il 4 novembre 2026):
- robots.txt consente le pagine prodotto (/p/...) e dei negozi (/punti-vendita/...); vieta ricerca e carrello,
  che non usiamo;
- sitemap_index.xml elenca la sitemap dei prodotti (~24.000 pagine /p/<nome>/<codice>.html, il codice è
  l'EAN riempito di zeri) e quella dei negozi (~1.000 pagine con coordinate nella mappa);
- ogni pagina prodotto ha un blocco JSON-LD schema.org Product (nome, marca, prezzo di vendita), il prezzo
  barrato nel riquadro prezzi quando c'è una promozione e le categorie nei dati di analisi della pagina.

I prezzi sono quelli della spesa online, uguali per tutta Italia: li applichiamo ai negozi Carrefour dell'area
di raccolta, per i formati scelti nel pannello (parametro scraping.carrefourFormats). Nei negozi fisici possono
differire, soprattutto negli Express.

Per non pesare sul sito: robots.txt rispettato, una pagina alla volta con pausa, tetto di pagine per notte.
Il catalogo si copre a rotazione: metà delle pagine va ai prodotti già nel nostro catalogo, metà agli altri.
"""
import datetime as dt
import hashlib
import os
import re
from html import unescape
from typing import Iterable

from ..scraping import BudgetExhausted, PoliteFetcher, SiteUnavailable, json_ld_products, normalize_gtin, parse_sitemap
from ..scraping.jsonld import brand_name, gtin_candidates, offer_price, parse_price
from . import ProductInfo, RawPrice, StoreInfo

BASE_URL = os.environ.get("CARREFOUR_URL", "https://www.carrefour.it").rstrip("/")
CHAIN_REF = "chains:carrefour"

# Formati dei punti vendita: valore del parametro -> nome dell'insegna nello Store Service.
FORMATS = {
    "iper": "Carrefour Iper",
    "market": "Carrefour Market",
    "express": "Carrefour Express",
    "altri": "Carrefour",
}

# Categorie del sito (primo livello, es. "Acqua, succhi e bibite") -> categorie del catalogo. Quelle assenti
# (giocattoli, tessile, giardino, "Articoli per la casa e per la tua auto"...) non sono spesa e vengono saltate.
# Il campo item_type della pagina non aiuta: vale "food" anche per un nastro adesivo.
CATEGORIES = [
    (("uova", "latte", "latticini", "formaggi", "yogurt"), "Latticini"),
    (("pane", "snack salati", "panetteria", "sostitutivi"), "Panetteria"),
    (("frutta", "verdura"), "Frutta e verdura"),
    (("carne", "pesce", "gastronomia", "salumi", "hamburger"), "Carne e pesce"),
    (("surgelati", "gelati"), "Surgelati"),
    (("acqua", "analcolici", "bevande", "birra", "vino", "liquori"), "Bevande"),
    (("cura della casa", "cura della persona", "igiene", "animali", "prima infanzia", "salute"), "Casa e igiene"),
    (("dolci", "colazione", "pasta", "riso", "farina", "condimenti", "conserve", "dispensa", "sfusi",
      "biologic", "stili alimentari"), "Dispensa"),
]

_STORE_URL = re.compile(r"/punti-vendita/[^/]+-(\d+)\.html$")
_PRODUCT_URL = re.compile(r"/p/[^/]+/(\d{8,14})\.html$")
_LAT = re.compile(r'data-option-lat="(-?\d+(?:\.\d+)?)"')
_LNG = re.compile(r'data-option-lng="(-?\d+(?:\.\d+)?)"')
_H1 = re.compile(r"<h1[^>]*>(.*?)</h1>", re.S)
_TAGS = re.compile(r"<[^>]+>")
_STRIKE = re.compile(r'class="strike-through list".*?content="(\d+(?:\.\d+)?)"', re.S)
_SALE = re.compile(r'class="value discounted[^"]*"\s+content="(\d+(?:\.\d+)?)"')
_CATEGORY = re.compile(r'"item_category":"([^"]*)"')
_PACKAGE = re.compile(r"/\s*(\d+(?:[.,]\d+)?)\s*(g|kg|ml|cl|l|lt)\b", re.I)


def map_category(site_category: str | None) -> str | None:
    text = (site_category or "").lower()
    if not text:
        return None
    for words, category in CATEGORIES:
        if any(w in text for w in words):
            return category
    return None


def store_format(title: str) -> str:
    t = title.lower()
    if "express" in t:
        return FORMATS["express"]
    if "market" in t:
        return FORMATS["market"]
    if "iper" in t:
        return FORMATS["iper"]
    return FORMATS["altri"]


def _title_case(text: str) -> str:
    small = {"di", "del", "della", "dei", "e", "a", "al", "in", "nelle", "nel", "sul", "da"}
    words = text.strip().lower().split()
    return " ".join(w if i and w in small else w[:1].upper() + w[1:] for i, w in enumerate(words))


def parse_store(html: str, url: str) -> tuple[str, StoreInfo] | None:
    """Pagina di un punto vendita -> (codice, dati). None se mancano coordinate o codice."""
    ref = _STORE_URL.search(url)
    lat, lng, h1 = _LAT.search(html), _LNG.search(html), _H1.search(html)
    if not ref or not lat or not lng or not h1:
        return None
    title = unescape(_TAGS.sub("", h1.group(1))).strip()
    title = re.sub(r"^(supermercato|ipermercato|negozio)\s+", "", title, flags=re.I)
    parts = [p.strip() for p in title.split(" - ") if p.strip()]
    chain = store_format(parts[0] if parts else title)
    town = _title_case(parts[1]) if len(parts) > 1 else ""
    address = ", ".join(_title_case(p) for p in parts[2:])
    name = f"{chain} {town}".strip()
    return f"carrefour:{ref.group(1)}", StoreInfo(
        name=name[:120], lat=float(lat.group(1)), lng=float(lng.group(1)), chain=chain,
        address=(f"{address}, {town}" if address and town else address or town)[:200],
    )


def parse_product(html: str, url: str, today: str, with_product_info: bool = True) -> RawPrice | None:
    """Pagina prodotto -> prezzo. None se non è un prodotto della spesa con EAN e prezzo validi."""
    products = json_ld_products(html)
    if not products:
        return None
    ld = products[0]
    ean = next((g for g in map(normalize_gtin, gtin_candidates(ld)) if g), None)
    if ean is None:
        m = _PRODUCT_URL.search(url)
        ean = normalize_gtin(m.group(1)) if m else None
    sale = parse_price(_SALE.search(html).group(1)) if _SALE.search(html) else offer_price(ld)
    if ean is None or sale is None:
        return None

    category = map_category((_CATEGORY.search(html) or [None, None])[1])
    if category is None:
        return None  # non è spesa (casa e giardino, tessile, giocattoli...)

    strike = _STRIKE.search(html)
    full = parse_price(strike.group(1)) if strike else None
    price, promo = (full, sale) if full and full > sale else (sale, None)

    info = None
    if with_product_info:
        package = _PACKAGE.search(html[html.find('class="unit-price"'):][:300]) if 'class="unit-price"' in html else None
        quantity = float(package.group(1).replace(",", ".")) if package else None
        unit = package.group(2).lower().replace("lt", "l") if package else None
        name = unescape(str(ld.get("name") or "")).strip()
        info = ProductInfo(
            name=name[:120], brand=brand_name(ld), categories=(f"saveshop:{category}",),
            quantity=quantity, quantity_unit=unit, source="carrefour",
        ) if name else None
    return RawPrice(store_ref=CHAIN_REF, ean=ean, price=price, promo_price=promo, product=info, observed_on=today)


def rotate(items: list, count: int, day: int) -> list:
    """`count` elementi presi a rotazione: ogni giorno una finestra diversa, ordine stabile tra le esecuzioni."""
    if not items or count <= 0:
        return []
    ordered = sorted(items, key=lambda x: hashlib.sha1(str(x).encode()).hexdigest())
    start = (day * count) % len(ordered)
    window = ordered[start:] + ordered[:start]
    return window[:count]


class CarrefourSource:
    name = "web:carrefour"

    def __init__(
        self,
        fetcher: PoliteFetcher,
        formats: Iterable[str] = ("iper", "market", "express", "altri"),
        create_products: bool = True,
        store_share: float = 0.2,
        today: dt.date | None = None,
        base_url: str = BASE_URL,
    ):
        self.fetcher = fetcher
        self.chains = [FORMATS[f] for f in formats if f in FORMATS]
        self.create_products = create_products
        self.store_share = store_share
        self.today = today or dt.date.today()
        self.base = base_url.rstrip("/")
        self.known_eans: set[str] = set()
        self.known_store_refs: set[str] = set()
        self.found_stores: dict[str, StoreInfo] = {}
        self.stats = {"pages": 0, "prices": 0, "not_grocery": 0, "stores": 0}

    # Chiamato dall'ingestion prima di fetch: cosa c'è già nel catalogo e nello Store Service.
    def prepare(self, products: dict[str, str], stores: dict[str, str]) -> None:
        self.known_eans = set(products)
        self.known_store_refs = set(stores)

    @property
    def chain_targets(self) -> dict[str, list[str]]:
        return {CHAIN_REF: self.chains}

    def _sitemaps(self) -> tuple[str | None, str | None]:
        res = self.fetcher.get(f"{self.base}/sitemap_index.xml")
        if res is None:
            raise SiteUnavailable("sitemap_index.xml non disponibile")
        _, children = parse_sitemap(res.body)
        products = next((c for c in children if "product" in c), None)
        stores = next((c for c in children if "store" in c), None)
        return products, stores

    def _entries(self, sitemap_url: str | None) -> list[str]:
        if not sitemap_url:
            return []
        res = self.fetcher.get(sitemap_url)
        return [e.loc for e in parse_sitemap(res.body)[0]] if res else []

    def _fetch_stores(self, urls: list[str], budget: int) -> None:
        todo = [u for u in urls if (m := _STORE_URL.search(u)) and f"carrefour:{m.group(1)}" not in self.known_store_refs]
        for url in todo[:budget]:
            res = self.fetcher.get(url)
            parsed = parse_store(res.text(), url) if res else None
            if parsed:
                self.found_stores[parsed[0]] = parsed[1]
        self.stats["stores"] = len(self.found_stores)

    def fetch(self) -> Iterable[RawPrice]:
        prices: dict[str, RawPrice] = {}
        today = self.today.isoformat()
        day = self.today.toordinal()
        try:
            product_map, store_map = self._sitemaps()
            # Negozi nuovi (una tantum, poi solo quelli aperti di recente), con una quota del tetto.
            store_budget = int(self.fetcher.remaining * self.store_share)
            if store_budget > 0:
                self._fetch_stores(self._entries(store_map), store_budget)

            urls = self._entries(product_map)
            known, other, seen = [], [], set()
            for url in urls:
                m = _PRODUCT_URL.search(url)
                ean = normalize_gtin(m.group(1)) if m else None
                if ean and ean not in seen and self.fetcher.allowed(url):
                    seen.add(ean)
                    (known if ean in self.known_eans else other).append(url)
            budget = self.fetcher.remaining
            first = rotate(known, budget, day)
            second = rotate(other, budget, day) if self.create_products else []
            queue = [u for pair in zip(first, second) for u in pair] + first[len(second):] + second[len(first):]
            for url in queue:
                res = self.fetcher.get(url)
                if res is None:
                    continue
                self.stats["pages"] += 1
                price = parse_product(res.text(), url, today, with_product_info=self.create_products)
                if price is None:
                    self.stats["not_grocery"] += 1
                    continue
                prices[price.ean] = price
        except BudgetExhausted:
            pass  # tetto della notte raggiunto: il resto alla prossima esecuzione
        except SiteUnavailable as exc:
            print(f"[carrefour] interrotto: {exc}", flush=True)
        self.stats["prices"] = len(prices)
        print(
            f"[carrefour] {self.fetcher.requests} richieste, {self.stats['pages']} pagine prodotto, "
            f"{self.stats['prices']} prezzi, {self.stats['not_grocery']} non di spesa, {self.stats['stores']} negozi nuovi, "
            f"{self.fetcher.skipped_by_robots} vietate da robots.txt",
            flush=True,
        )
        return list(prices.values())
