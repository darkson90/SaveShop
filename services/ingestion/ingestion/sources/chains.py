"""Listini d'insegna dai siti delle catene: Lidl, Aldi, Eurospin, Penny.

Struttura dei siti verificata il 4 novembre 2026 su pagine reali; robots.txt di tutti e quattro consente le
pagine usate. I prezzi sono nazionali (uguali in tutti i punti vendita della catena) e si applicano ai negozi
dell'insegna nell'area di raccolta, creati da OpenStreetMap.

- Lidl: sitemap prodotti (~500 pagine, soprattutto offerte e assortimento a tempo); JSON-LD Product con prezzo
  e spesso il codice a barre (gtin13), categoria nei dati della pagina.
- Aldi: sitemap prodotti (~800 pagine, assortimento fisso); JSON-LD Product con prezzo e BreadcrumbList,
  niente codice a barre: abbinamento per nome.
- Eurospin: elenco prodotti in JSON usato dalla pagina "Prodotti", filtrato sulle offerte (le uniche con
  prezzo nazionale, ~60): prezzo pieno, prezzo scontato e scadenza; niente codice a barre.
- Penny: pagine "Tutte le offerte" (~90 prodotti, HTML): prezzo, prezzo barrato o prezzo con PENNYCard e
  periodo di validità; niente codice a barre.

Esselunga, Coop, Conad, Tigros, Despar e MD mostrano i prezzi solo dentro una sessione con punto vendita o
indirizzo di consegna, o in parti vietate dal robots.txt: restano fuori (vedi README).
"""
import datetime as dt
import json
import os
import re
from html import unescape
from typing import Iterable

from ..scraping import BudgetExhausted, PoliteFetcher, SiteUnavailable, json_ld_products, normalize_gtin, parse_sitemap
from ..scraping.categories import map_category
from ..scraping.jsonld import brand_name, offer_price, parse_price
from . import ProductInfo, RawPrice

_TAGS = re.compile(r"<[^>]+>")


def _text(html: str) -> str:
    return re.sub(r"\s+", " ", unescape(_TAGS.sub(" ", html))).strip()


def _gtins(product: dict) -> list[str]:
    raw = product.get("gtin13") or product.get("gtin") or product.get("gtin8") or []
    return [str(x) for x in (raw if isinstance(raw, list) else [raw])]


def _match_name(brand: str | None, name: str, extra: str | None = None) -> str:
    """Testo per l'abbinamento per nome: marca + nome + dettaglio breve (formato, variante)."""
    parts = [p for p in [brand if brand and brand.strip("- ") else None, name, extra] if p]
    return re.sub(r"\s+", " ", " ".join(parts)).strip()[:120]


def _it_date(text: str | None) -> str | None:
    """'30/11/2026' o '04.11.2026' -> '2026-11-30'."""
    m = re.search(r"(\d{1,2})[./](\d{1,2})[./](\d{4})", text or "")
    if not m:
        return None
    try:
        return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
    except ValueError:
        return None


class ChainSource:
    """Base: listino nazionale applicato ai negozi dell'insegna (`chains`) nell'area di raccolta."""

    name = "web:catena"
    chains: list[str] = []
    base_url = ""

    def __init__(self, fetcher: PoliteFetcher, today: dt.date | None = None, base_url: str | None = None):
        self.fetcher = fetcher
        self.today = today or dt.date.today()
        self.base = (base_url or self.base_url).rstrip("/")
        self.stats = {"pages": 0, "prices": 0, "skipped": 0}

    @property
    def chain_ref(self) -> str:
        return f"chains:{self.name.split(':', 1)[1]}"

    @property
    def chain_targets(self) -> dict[str, list[str]]:
        return {self.chain_ref: self.chains}

    def collect(self) -> Iterable[RawPrice]:
        raise NotImplementedError

    def fetch(self) -> Iterable[RawPrice]:
        prices: dict[str, RawPrice] = {}
        try:
            for price in self.collect():
                key = price.ean or (price.product.name if price.product else "")
                if key:
                    prices[key] = price
        except BudgetExhausted:
            pass
        except SiteUnavailable as exc:
            print(f"[{self.name}] interrotto: {exc}", flush=True)
        self.stats["prices"] = len(prices)
        print(f"[{self.name}] {self.fetcher.requests} richieste, {self.stats['pages']} pagine, "
              f"{self.stats['prices']} prezzi, {self.stats['skipped']} saltati", flush=True)
        return list(prices.values())


class SitemapJsonLdSource(ChainSource):
    """Pagine prodotto elencate in una sitemap, con prezzo nel JSON-LD schema.org."""

    sitemap_path = ""
    product_url = re.compile(r".")

    def category(self, html: str, product: dict) -> str | None:
        raise NotImplementedError

    def extra_name(self, product: dict) -> str | None:
        return None

    def parse(self, html: str) -> RawPrice | None:
        products = json_ld_products(html)
        if not products:
            return None
        ld = products[0]
        price = offer_price(ld)
        name = unescape(str(ld.get("name") or "")).strip()
        category = self.category(html, ld)
        if price is None or not name or category is None:
            return None
        ean = next((g for g in map(normalize_gtin, _gtins(ld)) if g), None)
        brand = brand_name(ld)
        brand = brand if brand and brand.strip("- ") else None
        info = ProductInfo(
            name=(name if ean else _match_name(brand, name, self.extra_name(ld)))[:120],
            brand=brand, categories=(f"saveshop:{category}",), source=self.name.split(":", 1)[1],
        )
        return RawPrice(store_ref=self.chain_ref, ean=ean or "", price=price, product=info,
                        observed_on=self.today.isoformat())

    def collect(self) -> Iterable[RawPrice]:
        res = self.fetcher.get(f"{self.base}{self.sitemap_path}")
        if res is None:
            raise SiteUnavailable(f"sitemap {self.sitemap_path} non disponibile")
        urls = [e.loc for e in parse_sitemap(res.body)[0] if self.product_url.search(e.loc)]
        for url in urls:
            page = self.fetcher.get(url)
            if page is None:
                continue
            self.stats["pages"] += 1
            price = self.parse(page.text())
            if price is None:
                self.stats["skipped"] += 1
                continue
            yield price


class LidlSource(SitemapJsonLdSource):
    name = "web:lidl"
    chains = ["Lidl"]
    base_url = os.environ.get("LIDL_URL", "https://www.lidl.it")
    sitemap_path = "/p/export/IT/it/product_sitemap.xml.gz"
    product_url = re.compile(r"/p/[^/]+/p\d+$")
    _WON = re.compile(r'"wonCategoryPrimary":"([^"]*)"')

    def category(self, html: str, product: dict) -> str | None:
        m = self._WON.search(html)
        levels = m.group(1).split("/") if m else []
        if len(levels) < 2 or "cibo" not in levels[1].lower():
            return None  # fai da te, casa, abbigliamento...
        return map_category(*levels[2:])


class AldiSource(SitemapJsonLdSource):
    name = "web:aldi"
    chains = ["Aldi"]
    base_url = os.environ.get("ALDI_URL", "https://www.aldi.it")
    sitemap_path = "/sitemap_products.xml"
    product_url = re.compile(r"/prodotto/[^/]+-\d+$")

    def category(self, html: str, product: dict) -> str | None:
        for node in json_ld_breadcrumbs(html):
            names = [str(i.get("name") or (i.get("item") or {}).get("name") or "") for i in node.get("itemListElement") or []]
            return map_category(*names[2:-1])  # senza Home, Prodotti e il prodotto stesso
        return None

    def extra_name(self, product: dict) -> str | None:
        desc = unescape(str(product.get("description") or "")).strip()
        return desc if 0 < len(desc) <= 40 else None


def json_ld_breadcrumbs(html: str) -> list[dict]:
    found = []
    for block in re.findall(r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>", html or "", re.S):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        for node in data if isinstance(data, list) else [data]:
            if isinstance(node, dict) and node.get("@type") == "BreadcrumbList":
                found.append(node)
    return found


class EurospinSource(ChainSource):
    """Offerte nazionali Eurospin dal JSON dell'elenco prodotti (le sole voci con prezzo pubblico)."""

    name = "web:eurospin"
    chains = ["Eurospin"]
    base_url = os.environ.get("EUROSPIN_URL", "https://www.eurospin.com")
    listing = ("/content/eurospin/it/it/home/products/jcr:content/root/container/productlisting.model.json"
               "?q=&page={page}&size=48&sortBy=&sortOrder=&by_subcategory=&by_category="
               "&by_typeOffer=offerta&by_typeOffer=family&by_typeOffer=limitati&by_typeOffer=ribassati")

    def parse(self, item: dict) -> RawPrice | None:
        price = parse_price(item.get("visiblePrice"))
        name = str(item.get("name") or "").strip()
        if not item.get("hasPrice") or price is None or not name:
            return None
        full = parse_price(item.get("visibleOriginalPrice")) if item.get("hasOriginalPrice") else None
        until = _it_date(item.get("promotionEndDate"))
        regular, promo = (full, price) if full and full > price else (price, None)
        return RawPrice(
            store_ref=self.chain_ref, ean="", price=regular, promo_price=promo,
            product=ProductInfo(name=_match_name(item.get("brand"), name, item.get("weight")), brand=item.get("brand"),
                                source="eurospin"),
            observed_on=self.today.isoformat(),
            promo_until=until if promo else None,
            # Senza prezzo barrato il prezzo vale solo per la durata dell'offerta.
            expires_on=None if promo else until,
        )

    def collect(self) -> Iterable[RawPrice]:
        page, pages = 1, 1
        while page <= pages:
            res = self.fetcher.get(f"{self.base}{self.listing.format(page=page)}")
            if res is None:
                raise SiteUnavailable("elenco prodotti non disponibile")
            data = json.loads(res.body)
            self.stats["pages"] += 1
            pages = min(int(data.get("totalPages") or 1), 50)
            for item in data.get("items") or []:
                price = self.parse(item)
                if price is None:
                    self.stats["skipped"] += 1
                    continue
                yield price
            page += 1


class PennySource(ChainSource):
    """Offerte della settimana Penny dalle pagine "Tutte le offerte" (HTML)."""

    name = "web:penny"
    chains = ["Penny"]
    base_url = os.environ.get("PENNY_URL", "https://www.penny.it")
    offers_path = "/categorie/tutte-le-offerte-99000000"
    _TILE = re.compile(r'<li[^>]*data-test="product-tile".*?(?=<li[^>]*data-test="product-tile"|</ul>\s*<nav|$)', re.S)
    _TITLE = re.compile(r'data-test="product-title"[^>]*>(.*?)</h3>', re.S)
    _PIECE = re.compile(r'data-test="product-information-piece-description"[^>]*>(.*?)</ul>', re.S)
    _TYPE = re.compile(r'data-test="product-price-type"[^>]*>(.*?)data-test="product-price-type-label"', re.S)
    _LABEL = re.compile(r'data-test="product-price-type-price-label"[^>]*>(.*?)</div>', re.S)
    _MAIN = re.compile(r'class="ws-product-price-value__main"[^>]*>(.*?)</span>', re.S)
    _STRIKE = re.compile(r"<s(?:\s[^>]*)?>(.*?)</s>", re.S)
    _VALIDITY = re.compile(r'data-test="product-price-validity"[^>]*>(.*?)</div>\s*</div>', re.S)
    _PAGES = re.compile(r"tutte-le-offerte-\d+\?page=(\d+)")

    def parse_tile(self, tile: str) -> RawPrice | None:
        title = self._TITLE.search(tile)
        if not title:
            return None
        name, _, brand = _text(title.group(1)).partition(" • ")
        piece = self._PIECE.search(tile)
        size = _text(piece.group(1)) if piece else None
        regular = promo = None
        loyalty = False
        for block in self._TYPE.findall(tile):
            main = self._MAIN.search(block)
            value = parse_price(_text(main.group(1))) if main else None
            label = _text(self._LABEL.search(block).group(1)) if self._LABEL.search(block) else ""
            strike = self._STRIKE.search(block)
            if value is None:
                continue
            if "con penny" in label.lower():
                promo, loyalty = value, True
            elif strike:
                regular, promo = parse_price(_text(strike.group(1))), value
            else:
                regular = value
        if regular is None and promo is not None:
            regular, promo = promo, None
        if regular is None or (promo is not None and promo >= regular):
            promo = None if regular is not None else promo
        if regular is None:
            return None
        validity = self._VALIDITY.search(tile)
        dates = re.findall(r"\d{2}\.\d{2}\.\d{4}", _text(validity.group(1))) if validity else []
        until = _it_date(dates[-1]) if dates else None
        return RawPrice(
            store_ref=self.chain_ref, ean="", price=regular, promo_price=promo, loyalty_only=loyalty and promo is not None,
            product=ProductInfo(name=_match_name(brand or None, name, size), brand=brand or None, source="penny"),
            observed_on=self.today.isoformat(), promo_until=until if promo else None,
        )

    def collect(self) -> Iterable[RawPrice]:
        page, pages = 1, 1
        while page <= pages:
            res = self.fetcher.get(f"{self.base}{self.offers_path}?page={page}")
            if res is None:
                raise SiteUnavailable("pagina offerte non disponibile")
            html = res.text()
            self.stats["pages"] += 1
            pages = min(max([page, *map(int, self._PAGES.findall(html))]), 20)
            for tile in self._TILE.findall(html):
                price = self.parse_tile(tile)
                if price is None:
                    self.stats["skipped"] += 1
                    continue
                yield price
            page += 1


CHAIN_SOURCES = {"lidl": LidlSource, "aldi": AldiSource, "eurospin": EurospinSource, "penny": PennySource}
