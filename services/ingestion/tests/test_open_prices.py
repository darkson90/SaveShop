"""Test della fonte Open Prices senza rete: le risposte dell'API sono simulate.

Esecuzione: cd services/ingestion && python -m unittest discover -s tests
"""
import datetime as dt
import unittest
from urllib.parse import parse_qs, urlparse

from ingestion.sources.open_prices import OpenPricesSource, to_raw_price


def item(**over):
    base = {
        "product_code": "8032390001277",
        "price": 2.49,
        "price_is_discounted": False,
        "price_without_discount": None,
        "discount_type": None,
        "currency": "EUR",
        "date": "2026-10-19",
        "type": "PRODUCT",
        "duplicate_of": None,
        "location": {
            "type": "OSM", "osm_id": 2620770361, "osm_type": "NODE", "osm_name": "Kanguro Supermercati",
            "osm_brand": None, "osm_address_city": "Castion", "osm_address_postcode": "32024",
            "osm_lat": 46.1225949, "osm_lon": 12.2335109,
        },
        "product": {
            "product_name": "Cuore di lattuga", "brands": "Esempio",
            "categories_tags": ["en:plant-based-foods", "en:fresh-vegetables", "en:lettuces"],
            "product_quantity": 160, "product_quantity_unit": "g", "source": "off",
        },
    }
    base.update(over)
    return base


class ToRawPriceTest(unittest.TestCase):
    def test_prezzo_pieno(self):
        p = to_raw_price(item())
        self.assertEqual(p.store_ref, "osm:node:2620770361")
        self.assertEqual((p.ean, p.price, p.promo_price), ("8032390001277", 2.49, None))
        self.assertEqual(p.store.name, "Kanguro Supermercati")
        self.assertEqual(p.store.address, "Castion, 32024")
        self.assertEqual(p.product.quantity_unit, "g")
        self.assertEqual(p.observed_on, "2026-10-19")

    def test_prezzo_scontato(self):
        p = to_raw_price(item(price=1.99, price_is_discounted=True, price_without_discount=2.49))
        self.assertEqual((p.price, p.promo_price, p.loyalty_only), (2.49, 1.99, False))

    def test_sconto_con_carta(self):
        p = to_raw_price(item(price=1.99, price_is_discounted=True, price_without_discount=2.49, discount_type="LOYALTY_PROGRAM"))
        self.assertTrue(p.loyalty_only)

    def test_scarti(self):
        self.assertIsNone(to_raw_price(item(product_code=None)))                       # prezzo per categoria
        self.assertIsNone(to_raw_price(item(product_code="12AB")))
        self.assertIsNone(to_raw_price(item(price=0)))
        self.assertIsNone(to_raw_price(item(duplicate_of=123)))
        self.assertIsNone(to_raw_price(item(price_is_discounted=True, price_without_discount=None)))
        self.assertIsNone(to_raw_price(item(location={"type": "ONLINE", "osm_lat": None, "osm_lon": None})))


class FetchTest(unittest.TestCase):
    def test_paginazione_filtri_e_osservazione_piu_recente(self):
        calls = []
        pages = {
            1: {"items": [item(price=2.29, date="2026-10-30"), item(product_code="8000000000101", price=1.19)], "pages": 2},
            2: {"items": [item(price=2.49, date="2026-10-19")], "pages": 2},  # più vecchio: ignorato
        }

        def fake_get(url):
            calls.append(url)
            return pages[int(parse_qs(urlparse(url).query)["page"][0])]

        source = OpenPricesSource(46.14, 12.22, radius_km=40, days=30, delay_seconds=0,
                                  get_json=fake_get, today=dt.date(2026, 11, 3))
        prices = {p.ean: p.price for p in source.fetch()}
        self.assertEqual(prices, {"8032390001277": 2.29, "8000000000101": 1.19})
        self.assertEqual(len(calls), 2)
        q = parse_qs(urlparse(calls[0]).query)
        self.assertEqual(q["date__gte"], ["2026-10-04"])
        self.assertEqual((q["type"], q["currency"], q["order_by"]), (["PRODUCT"], ["EUR"], ["-date"]))
        self.assertEqual((q["lat"], q["lon"], q["radius_km"]), (["46.14"], ["12.22"], ["40"]))


if __name__ == "__main__":
    unittest.main()
