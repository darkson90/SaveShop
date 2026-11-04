"""Fonti di prezzi. Ogni fonte restituisce RawPrice con codici esterni (punto vendita, EAN)."""
from dataclasses import dataclass, field
from typing import Iterable, Protocol


@dataclass(frozen=True)
class StoreInfo:
    """Dati del punto vendita per crearlo se non esiste ancora nello Store Service."""
    name: str
    lat: float
    lng: float
    chain: str | None = None
    address: str = ""


@dataclass(frozen=True)
class ProductInfo:
    """Dati del prodotto per crearlo se non esiste ancora nel catalogo."""
    name: str
    brand: str | None = None
    categories: tuple[str, ...] = field(default_factory=tuple)  # categories_tags di Open Food Facts
    quantity: float | None = None
    quantity_unit: str | None = None
    source: str | None = None  # off / obf / opf


@dataclass(frozen=True)
class RawPrice:
    store_ref: str          # codice del punto vendita presso la fonte (stores.external_ref)
    ean: str                # codice a barre del prodotto (products.ean)
    price: float            # prezzo pieno in euro
    promo_price: float | None = None
    loyalty_only: bool = False
    store: StoreInfo | None = None      # presenti solo per le fonti che possono creare negozi/prodotti
    product: ProductInfo | None = None
    observed_on: str | None = None      # YYYY-MM-DD dell'osservazione; None = oggi (listini e feed)


class Source(Protocol):
    name: str

    def fetch(self) -> Iterable[RawPrice]: ...
