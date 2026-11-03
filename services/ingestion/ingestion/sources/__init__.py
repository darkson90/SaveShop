"""Fonti di prezzi. Ogni fonte restituisce RawPrice con codici esterni (punto vendita, EAN)."""
from dataclasses import dataclass
from typing import Iterable, Protocol


@dataclass(frozen=True)
class RawPrice:
    store_ref: str          # codice del punto vendita presso la fonte (stores.external_ref)
    ean: str                # codice a barre del prodotto (products.ean)
    price: float            # prezzo pieno in euro
    promo_price: float | None = None
    loyalty_only: bool = False


class Source(Protocol):
    name: str

    def fetch(self) -> Iterable[RawPrice]: ...
