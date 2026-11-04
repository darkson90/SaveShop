"""Test dei feed partner: python -m unittest discover -s tests"""
import datetime as dt
import json
import pathlib
import unittest

from ingestion.sources.feeds import FeedError, FeedSource, parse_feed

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "feed-esempio.json"


class ParseFeedTest(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_righe_valide_e_scartate(self):
        prices, warnings = parse_feed(self.data, today=dt.date(2026, 11, 3))
        # L'ultima riga ripete il latte: il feed la importa, il Pricing tiene l'ultima per coppia.
        self.assertEqual([p.ean for p in prices], ["8000000000101", "8099999000024", "8000000000107", "8000000000126", "8000000000101"])
        self.assertEqual(len(warnings), 2)  # negozio sconosciuto, EAN non valido
        self.assertTrue(all(p.store_ref == "feed:alimentari-rossi:vodo-01" for p in prices))

    def test_promo_scaduta_e_promo_con_carta(self):
        prices = {p.ean: p for p in parse_feed(self.data, today=dt.date(2026, 11, 3))[0]}
        self.assertEqual((prices["8000000000101"].price, prices["8000000000101"].promo_price), (1.35, 0.99))
        self.assertIsNone(prices["8000000000107"].promo_price)          # scaduta nel 2020
        self.assertTrue(prices["8000000000126"].loyalty_only)

    def test_prodotto_e_negozio_nuovi(self):
        prices = {p.ean: p for p in parse_feed(self.data)[0]}
        self.assertEqual(prices["8099999000024"].product.name, "Formaggio Piave DOP 250 g")
        self.assertEqual(prices["8099999000024"].store.chain, "Alimentari Rossi")

    def test_formato_non_supportato(self):
        with self.assertRaises(FeedError):
            parse_feed({**self.data, "version": 2})
        with self.assertRaises(FeedError):
            parse_feed({**self.data, "publisher": ""})


class FeedSourceTest(unittest.TestCase):
    def test_un_feed_rotto_non_blocca_gli_altri(self):
        def load(loc):
            if loc == "rotto":
                raise OSError("404")
            return json.loads(FIXTURE.read_text(encoding="utf-8"))

        prices = FeedSource(["rotto", str(FIXTURE)], load=load).fetch()
        self.assertEqual(len(prices), 5)


if __name__ == "__main__":
    unittest.main()
