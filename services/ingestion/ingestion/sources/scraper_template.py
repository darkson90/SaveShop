"""Modello per una fonte reale basata su pagine web. Non è registrata di default.

Regole: preferire API o feed ufficiali; leggere robots.txt e i termini d'uso del sito;
una richiesta alla volta per dominio con pausa; User-Agent che identifica il servizio.
Per pagine renderizzate in JavaScript si può usare Playwright al posto di urllib.
"""
import time
import urllib.request
import urllib.robotparser
from typing import Iterable
from urllib.parse import urljoin, urlparse

from . import RawPrice

USER_AGENT = "SpesaSmartIngestion/0.1 (+https://example.invalid/bot)"


class ScraperTemplate:
    name = "scraper:esempio"

    def __init__(self, base_url: str, store_ref: str, delay_seconds: float = 2.0):
        self.base_url = base_url
        self.store_ref = store_ref
        self.delay = delay_seconds
        self.robots = urllib.robotparser.RobotFileParser(urljoin(base_url, "/robots.txt"))
        self.robots.read()

    def _get(self, url: str) -> str | None:
        if not self.robots.can_fetch(USER_AGENT, url):
            print(f"[scraper] robots.txt non consente {urlparse(url).path}: salto")
            return None
        time.sleep(self.delay)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.read().decode("utf-8", "replace")

    def parse(self, html: str) -> Iterable[RawPrice]:
        """Da implementare per la fonte specifica: estrarre EAN, prezzo, eventuale promo."""
        raise NotImplementedError

    def fetch(self) -> Iterable[RawPrice]:
        html = self._get(urljoin(self.base_url, "/offerte"))
        return self.parse(html) if html else []
