"""Supermercati da OpenStreetMap e abbinamento per nome: python -m unittest discover -s tests"""
import datetime as dt
import unittest
from unittest import mock

from ingestion import __main__ as main
from ingestion.sources import ProductInfo, RawPrice
from ingestion.sources.osm_stores import OsmStoresSource, build_query, canonical_brand, to_store

OVERPASS = {"elements": [
    {"type": "node", "id": 1, "lat": 46.42, "lon": 12.24,
     "tags": {"shop": "supermarket", "brand": "Conad City", "name": "Conad City", "addr:city": "Vodo di Cadore", "addr:street": "Via Nazionale", "addr:housenumber": "5"}},
    {"type": "way", "id": 2, "center": {"lat": 46.14, "lon": 12.21},
     "tags": {"shop": "supermarket", "brand": "EUROSPIN", "name": "Eurospin Belluno"}},
    {"type": "node", "id": 3, "lat": 46.16, "lon": 12.29, "tags": {"shop": "supermarket", "brand": "Carrefour Express"}},
    {"type": "node", "id": 4, "lat": 46.0, "lon": 12.0, "tags": {"shop": "supermarket", "name": "Alimentari Da Gino"}},
    {"type": "node", "id": 5, "tags": {"shop": "supermarket", "brand": "Lidl"}},  # senza coordinate
    {"type": "node", "id": 6, "lat": 45.9, "lon": 12.1, "tags": {"shop": "supermarket", "brand": "Despar", "disused:shop": "supermarket"}},
]}


class BrandTest(unittest.TestCase):
    def test_insegne(self):
        self.assertEqual(canonical_brand("CONAD", None), "Conad")
        self.assertEqual(canonical_brand("Conad City", None), "Conad City")
        self.assertEqual(canonical_brand(None, "Supermercato Lidl Italia"), "Lidl")
        self.assertEqual(canonical_brand("Interspar", None), "Interspar")
        self.assertEqual(canonical_brand("SPAR", None), "Despar")
        self.assertEqual(canonical_brand("Carrefour Express", None), "Carrefour Express")
        self.assertEqual(canonical_brand(None, "Ipercoop Belluno"), "Coop")
        self.assertEqual(canonical_brand(None, "Napoli Market"), None)  # "poli" dentro "Napoli" non è Poli
        self.assertEqual(canonical_brand(None, "Alimentari Rossi"), None)
        self.assertEqual(canonical_brand("Bottega Locale", None), "Bottega Locale")  # insegna sconosciuta: tenuta com'è

    def test_query(self):
        self.assertIn('area["ISO3166-1"="IT"]', build_query())
        self.assertIn("(around:25000,46.4,12.2)", build_query(46.4, 12.2, 25))


class OsmSourceTest(unittest.TestCase):
    def test_negozi(self):
        ref, store = to_store(OVERPASS["elements"][0])
        self.assertEqual(ref, "osm:node:1")
        self.assertEqual((store.chain, store.address), ("Conad City", "Via Nazionale 5, Vodo di Cadore"))
        ref, store = to_store(OVERPASS["elements"][1])
        self.assertEqual((ref, store.chain, store.lat), ("osm:way:2", "Eurospin", 46.14))
        ref, store = to_store(OVERPASS["elements"][3])
        self.assertEqual((store.chain, store.name), (None, "Alimentari Da Gino"))

    def test_giro(self):
        queries = []
        source = OsmStoresSource(post=lambda url, q: (queries.append(q), OVERPASS)[1], skip_chains=["Carrefour Express"],
                                 every_days=1, today=dt.date(2026, 11, 4))
        source.prepare({}, {"osm:way:2": "s2"})
        self.assertEqual(list(source.fetch()), [])
        self.assertEqual(sorted(source.found_stores), ["osm:node:1", "osm:node:4"])  # niente noti, Carrefour, chiusi
        self.assertEqual(len(queries), 1)

    def test_ogni_n_giorni(self):
        day = dt.date(2026, 11, 4)
        source = OsmStoresSource(every_days=7, post=lambda u, q: OVERPASS, today=day)
        source.prepare({}, {"osm:node:9": "s9"})
        self.assertEqual(source.due(), day.toordinal() % 7 == 0)
        source.prepare({}, {"carrefour:1": "c1"})
        self.assertTrue(source.due())  # primo giro: nessun negozio OSM ancora noto


class NameMatchTest(unittest.TestCase):
    def test_abbinamento_per_nome(self):
        raw = [RawPrice(store_ref="chains:x", ean="", price=1.0, product=ProductInfo(name="Latte intero 1 l")),
               RawPrice(store_ref="chains:x", ean="", price=2.0, product=ProductInfo(name="Cosa strana"))]
        calls = []

        def fake_post(url, body):
            calls.append((url, body))
            known = {"Latte intero 1 l": ({"id": "p-latte"}, 0.82), "Cosa strana": ({"id": "p-x"}, 0.4)}
            return {"items": [{"product": known[q][0], "confidence": known[q][1]} for q in body["q"]]}

        products: dict[str, str] = {}
        with mock.patch.object(main, "post_json", fake_post):
            self.assertEqual(main.match_names(raw, products, 0.6), 1)
        self.assertTrue(calls[0][0].endswith("/internal/products/match-batch"))
        self.assertEqual(products, {"name:Latte intero 1 l": "p-latte"})
        rows, skipped = main.normalize(raw, products, {}, {"chains:x": ["s1"]})
        self.assertEqual(([r["productId"] for r in rows], skipped), (["p-latte"], 1))

    def test_fonte_osm_dal_pannello(self):
        sources = main.build_sources({"ingestion.sources": ["osm_stores", "carrefour"], "ingestion.osmWholeItaly": False,
                                      "ingestion.openPricesLat": 46.4, "ingestion.openPricesLon": 12.2, "ingestion.openPricesRadiusKm": 30})
        osm = sources[0]
        self.assertIsInstance(osm, OsmStoresSource)
        self.assertEqual((osm.lat, osm.radius_km), (46.4, 30))
        self.assertIn("carrefour express", osm.skip_chains)


if __name__ == "__main__":
    unittest.main()
