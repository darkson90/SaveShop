"""Listini delle catene (Lidl, Aldi, Eurospin, Penny, EasyCoop) su pagine registrate: python -m unittest discover -s tests"""
import datetime as dt
import unittest

from carrefour_site import FakeSite
from ingestion.__main__ import DEFAULT_SOURCES, build_sources
from ingestion.scraping import PoliteFetcher
from ingestion.sources.chains import AldiSource, EasyCoopSource, EurospinSource, LidlSource, PennySource

TODAY = dt.date(2026, 11, 4)


def source(cls, site: str, base: str):
    fetcher = PoliteFetcher(delay_seconds=0, transport=FakeSite(base=base, site=site), sleep=lambda s: None)
    return cls(fetcher, today=TODAY, base_url=base)


class LidlTest(unittest.TestCase):
    def test_listino(self):
        s = source(LidlSource, "lidl", "https://www.lidl.it")
        prices = {(p.ean or p.product.name): p for p in s.fetch()}
        self.assertEqual(set(prices), {"4335619274983", "8015100578665", "Brezel con formaggio"})  # niente trapano
        self.assertEqual(prices["4335619274983"].price, 1.79)
        self.assertEqual(prices["4335619274983"].product.categories, ("saveshop:Dispensa",))
        self.assertEqual(prices["8015100578665"].product.categories, ("saveshop:Casa e igiene",))
        self.assertEqual(prices["Brezel con formaggio"].product.categories, ("saveshop:Panetteria",))  # marca "-" ignorata
        self.assertEqual(prices["Brezel con formaggio"].store_ref, "chains:lidl")
        self.assertEqual(s.chain_targets, {"chains:lidl": ["Lidl"]})


class AldiTest(unittest.TestCase):
    def test_listino_per_nome(self):
        prices = {p.product.name: p for p in source(AldiSource, "aldi", "https://www.aldi.it").fetch()}
        self.assertEqual(set(prices), {"GRANAROLO Latte UHT Parzialmente scremato", "BUON' ORA Frollini con gocce di cioccolato",
                                       "TANDIL Detersivo liquido Superbianco 46 Lavaggi"})
        latte = prices["GRANAROLO Latte UHT Parzialmente scremato"]
        self.assertEqual((latte.ean, latte.price, latte.product.categories), ("", 0.95, ("saveshop:Latticini",)))
        self.assertEqual(prices["BUON' ORA Frollini con gocce di cioccolato"].product.categories, ("saveshop:Dispensa",))


class EurospinTest(unittest.TestCase):
    def test_offerte(self):
        prices = {p.product.name: p for p in source(EurospinSource, "eurospin", "https://www.eurospin.com").fetch()}
        self.assertEqual(set(prices), {"PUERTOSOL Fettine di mela disidratate 20g", "PASCOLI ITALIANI Formaggio cacio misto"})
        mela = prices["PUERTOSOL Fettine di mela disidratate 20g"]
        self.assertEqual((mela.price, mela.promo_price, mela.promo_until, mela.expires_on), (0.79, 0.59, "2026-11-30", None))
        cacio = prices["PASCOLI ITALIANI Formaggio cacio misto"]
        self.assertEqual((cacio.price, cacio.promo_price, cacio.expires_on), (9.99, None, "2027-01-21"))  # solo durante l'offerta


class PennyTest(unittest.TestCase):
    def test_offerte(self):
        s = source(PennySource, "penny", "https://www.penny.it")
        prices = {p.product.name: p for p in s.fetch()}
        birra = prices["Nastro azzurro Birra 0,33 l"]
        self.assertEqual((birra.price, birra.promo_price, birra.loyalty_only), (0.99, 0.79, True))  # prezzo con PENNYCard
        pasta = prices["Rummo Spaghetti grossi N.5 0,5 kg"]
        self.assertEqual((pasta.price, pasta.promo_price, pasta.loyalty_only, pasta.promo_until), (1.59, 0.89, False, "2026-11-04"))
        self.assertEqual(s.stats["pages"], 2)  # pagina 2 elencata nella paginazione


class WiringTest(unittest.TestCase):
    def test_fonti_predefinite(self):
        names = [type(s).__name__ for s in build_sources({"ingestion.sources": DEFAULT_SOURCES})]
        for expected in ("CarrefourSource", "LidlSource", "AldiSource", "EurospinSource", "PennySource", "OsmStoresSource"):
            self.assertIn(expected, names)
        fetchers = [s.fetcher for s in build_sources({"ingestion.sources": ["lidl", "aldi"]})]
        self.assertIsNot(fetchers[0], fetchers[1])  # tetto di pagine separato per sito


class EasyCoopTest(unittest.TestCase):
    def test_listino(self):
        s = source(EasyCoopSource, "easycoop", "https://www.easycoop.com")
        prices = {p.ean: p for p in s.fetch()}
        self.assertEqual(set(prices), {"8001120656902", "8002670000122"})  # niente pastelli, niente pagine categoria
        sugo, latte = prices["8001120656902"], prices["8002670000122"]
        self.assertEqual((sugo.price, sugo.promo_price, sugo.product.categories), (2.1, None, ("saveshop:Dispensa",)))
        self.assertEqual((latte.price, latte.promo_price, latte.product.categories), (1.89, 1.49, ("saveshop:Latticini",)))
        self.assertEqual(s.chain_targets, {"chains:easycoop": ["Coop"]})

    def test_tetto_di_pagine(self):
        s = source(EasyCoopSource, "easycoop", "https://www.easycoop.com")
        s.max_pages = 1
        self.assertEqual(s.stats["pages"], 0)
        s.fetch()
        self.assertEqual(s.stats["pages"], 1)


if __name__ == "__main__":
    unittest.main()
