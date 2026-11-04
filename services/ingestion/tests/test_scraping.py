"""Strumenti di scraping e fonte Carrefour: python -m unittest discover -s tests"""
import datetime as dt
import unittest

from carrefour_site import FIXTURES, FakeSite
from ingestion.__main__ import build_sources, normalize
from ingestion.scraping import BudgetExhausted, PoliteFetcher, SiteUnavailable, json_ld_products, normalize_gtin, parse_sitemap
from ingestion.scraping.http import USER_AGENT, Response
from ingestion.scraping.jsonld import parse_price
from ingestion.sources import RawPrice
from ingestion.sources.carrefour import CHAIN_REF, CarrefourSource, map_category, parse_product, parse_store, rotate

BASE = "https://www.carrefour.it"
TODAY = dt.date(2026, 11, 4)


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text().replace("{BASE}", BASE)


def fetcher(site, **kw) -> PoliteFetcher:
    kw.setdefault("delay_seconds", 0)
    return PoliteFetcher(transport=site, sleep=lambda s: None, **kw)


class GtinTest(unittest.TestCase):
    def test_codici(self):
        self.assertEqual(normalize_gtin("0000040052410"), "40052410")  # EAN-8 riempito di zeri
        self.assertEqual(normalize_gtin("8000500310427"), "8000500310427")
        self.assertEqual(normalize_gtin("00008000500310427"), None)  # troppo lungo
        self.assertEqual(normalize_gtin("0000000000208"), None)  # codice interno del negozio
        self.assertEqual(normalize_gtin("2121679000000"), None)  # prodotto a peso variabile (prefisso 2)
        self.assertEqual(normalize_gtin("0000020451479"), None)  # EAN-8 a circolazione ristretta
        self.assertEqual(normalize_gtin("8000500310428"), None)  # cifra di controllo sbagliata
        self.assertEqual(normalize_gtin("036000291452"), "0036000291452")  # UPC-A -> EAN-13
        self.assertEqual(normalize_gtin(None), None)


class ParsingTest(unittest.TestCase):
    def test_prezzi(self):
        self.assertEqual(parse_price("1.19"), 1.19)
        self.assertEqual(parse_price("€ 1,19"), 1.19)
        self.assertEqual(parse_price("1.234,50"), 1234.5)
        self.assertIsNone(parse_price("0"))
        self.assertIsNone(parse_price("gratis"))

    def test_json_ld(self):
        products = json_ld_products(fixture("kitkat.html"))
        self.assertEqual(products[0]["sku"], "0000040052410")
        graph = '<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":["Product"],"name":"X"}]}</script>'
        self.assertEqual(json_ld_products(graph)[0]["name"], "X")
        self.assertEqual(json_ld_products('<script type="application/ld+json">{non json</script>'), [])

    def test_sitemap(self):
        pages, children = parse_sitemap(fixture("sitemap_index.xml"))
        self.assertEqual(pages, [])
        self.assertEqual(children[0], f"{BASE}/sitemap_0-product.xml")
        pages, _ = parse_sitemap(fixture("sitemap_0-product.xml").encode())
        self.assertEqual(pages[0].lastmod, "2026-11-03T22:47:35+00:00")


class CarrefourParsingTest(unittest.TestCase):
    def test_prodotto_a_prezzo_pieno(self):
        p = parse_product(fixture("kitkat.html"), f"{BASE}/p/kitkat/0000040052410.html", "2026-11-04")
        self.assertEqual((p.ean, p.price, p.promo_price, p.store_ref), ("40052410", 1.19, None, CHAIN_REF))
        self.assertEqual(p.product.categories, ("saveshop:Dispensa",))
        self.assertEqual((p.product.quantity, p.product.quantity_unit), (42.0, "g"))
        self.assertEqual(p.product.brand, "NESTLÉ KITKAT")
        self.assertEqual(p.observed_on, "2026-11-04")

    def test_prodotto_in_promozione(self):
        p = parse_product(fixture("smarties.html"), f"{BASE}/p/smarties/0000042395072.html", "2026-11-04")
        self.assertEqual((p.price, p.promo_price), (2.99, 1.99))  # prezzo barrato e prezzo scontato

    def test_categorie(self):
        p = parse_product(fixture("ricotta.html"), f"{BASE}/p/ricotta/8012666052219.html", "2026-11-04")
        self.assertEqual(p.product.categories, ("saveshop:Latticini",))
        self.assertIsNone(parse_product(fixture("macchinina.html"), f"{BASE}/p/x/8001234567897.html", "2026-11-04"))
        self.assertEqual(map_category("Acqua, succhi e bibite"), "Bevande")
        self.assertEqual(map_category("Formaggi e salumi"), "Latticini")
        self.assertIsNone(map_category("Articoli per la casa e per la tua auto"))
        self.assertEqual(map_category("Gelati e surgelati"), "Surgelati")
        self.assertIsNone(map_category("Giocattoli"))

    def test_senza_dati_strutturati(self):
        self.assertIsNone(parse_product("<html>niente</html>", f"{BASE}/p/x/0000040052410.html", "2026-11-04"))

    def test_negozio(self):
        url = f"{BASE}/punti-vendita/carrefour-express-ponte-nelle-alpi-a27-venezia-belluno-km-82-sud-3381.html"
        ref, store = parse_store(fixture("store-3381.html"), url)
        self.assertEqual(ref, "carrefour:3381")
        self.assertEqual(store.chain, "Carrefour Express")
        self.assertEqual(store.name, "Carrefour Express Ponte nelle Alpi")
        self.assertEqual((store.lat, store.lng), (46.16178, 12.298805))
        self.assertIn("A27 Venezia Belluno", store.address)
        self.assertIsNone(parse_store("<h1>Senza mappa</h1>", url))

    def test_rotazione(self):
        items = [f"u{i}" for i in range(10)]
        day1, day2 = rotate(items, 4, 100), rotate(items, 4, 101)
        self.assertEqual(len(day1), 4)
        self.assertEqual(rotate(items, 4, 100), day1)  # stabile
        self.assertFalse(set(day1) & set(day2))  # giorni consecutivi: finestre diverse
        self.assertEqual(sorted(rotate(items, 20, 5)), sorted(items))
        self.assertEqual(rotate([], 5, 1), [])


class FetcherTest(unittest.TestCase):
    def test_robots_e_user_agent(self):
        site = FakeSite()
        f = fetcher(site)
        self.assertIsNone(f.get(f"{BASE}/search?q=latte"))
        self.assertIsNone(f.get(f"{BASE}/p/vietato/0000040052410.html"))
        self.assertEqual(f.skipped_by_robots, 2)
        self.assertEqual(site.requests, [f"{BASE}/robots.txt"])  # le pagine vietate non vengono mai chieste
        self.assertEqual(site.user_agent, USER_AGENT)
        self.assertIn("SaveShopBot", USER_AGENT)

    def test_robots_assente_o_vietato(self):
        f = fetcher(FakeSite(overrides={"/robots.txt": (404, b"", {})}))
        self.assertTrue(f.allowed(f"{BASE}/qualsiasi"))
        f = fetcher(FakeSite(overrides={"/robots.txt": (403, b"", {})}))
        self.assertFalse(f.allowed(f"{BASE}/qualsiasi"))

    def test_pausa_tra_richieste(self):
        waits, now = [], [0.0]
        f = PoliteFetcher(delay_seconds=2, transport=FakeSite(), sleep=lambda s: (waits.append(s), now.__setitem__(0, now[0] + s)),
                          clock=lambda: now[0])
        f.get(f"{BASE}/sitemap_index.xml")
        f.get(f"{BASE}/sitemap_0-product.xml")
        self.assertEqual(waits, [2, 2])  # dopo robots.txt e dopo la prima pagina

    def test_crawl_delay_del_sito(self):
        robots = b"User-agent: *\nCrawl-delay: 10\n"
        f = fetcher(FakeSite(overrides={"/robots.txt": (200, robots, {})}), delay_seconds=1)
        f.get(f"{BASE}/sitemap_index.xml")
        self.assertEqual(f.delay, 10)

    def test_tetto_di_richieste(self):
        f = fetcher(FakeSite(), max_requests=2)
        f.get(f"{BASE}/sitemap_index.xml")
        with self.assertRaises(BudgetExhausted):
            f.get(f"{BASE}/sitemap_0-product.xml")

    def test_retry_e_blocco(self):
        site = FakeSite(overrides={"/lento.html": (503, b"", {"retry-after": "7"})})
        waits = []
        f = PoliteFetcher(delay_seconds=0, transport=site, sleep=waits.append, max_consecutive_errors=10)
        self.assertIsNone(f.get(f"{BASE}/lento.html", retries=2))
        self.assertEqual(waits, [7, 7])
        self.assertEqual(site.requests.count(f"{BASE}/lento.html"), 3)
        f = fetcher(FakeSite(overrides={"/x.html": (403, b"", {})}))
        with self.assertRaises(SiteUnavailable):
            f.get(f"{BASE}/x.html")
        f = fetcher(FakeSite(overrides={"/y.html": (500, b"", {})}), max_consecutive_errors=2)
        with self.assertRaises(SiteUnavailable):
            f.get(f"{BASE}/y.html", retries=5)


class CarrefourSourceTest(unittest.TestCase):
    def test_giro_completo(self):
        site = FakeSite()
        source = CarrefourSource(fetcher(site), today=TODAY)
        source.prepare({"42395072": "p-smarties"}, {"carrefour:3381": "s-esistente"})
        prices = {p.ean: p for p in source.fetch()}
        self.assertEqual(set(prices), {"40052410", "42395072", "8012666052219"})  # niente giocattolo né codice interno
        self.assertEqual(prices["42395072"].promo_price, 1.99)
        self.assertEqual(list(source.found_stores), ["carrefour:9001"])  # il negozio già noto non si riscarica
        self.assertNotIn(f"{BASE}/punti-vendita/carrefour-express-ponte-nelle-alpi-a27-venezia-belluno-km-82-sud-3381.html", site.requests)
        self.assertEqual(source.found_stores["carrefour:9001"].chain, "Carrefour Market")
        self.assertEqual(source.chain_targets, {CHAIN_REF: ["Carrefour Iper", "Carrefour Market", "Carrefour Express", "Carrefour"]})

    def test_solo_prodotti_noti(self):
        source = CarrefourSource(fetcher(FakeSite()), create_products=False, formats=["market"], today=TODAY)
        source.prepare({"40052410": "p-kitkat"}, {})
        prices = list(source.fetch())
        self.assertEqual([p.ean for p in prices], ["40052410"])
        self.assertIsNone(prices[0].product)
        self.assertEqual(source.chain_targets, {CHAIN_REF: ["Carrefour Market"]})

    def test_tetto_raggiunto_tiene_quanto_letto(self):
        source = CarrefourSource(fetcher(FakeSite(), max_requests=6), store_share=0, today=TODAY)
        prices = list(source.fetch())  # robots + 2 sitemap + 3 delle 4 pagine prodotto
        self.assertEqual((source.fetcher.requests, source.stats["pages"]), (6, 3))
        self.assertEqual(len(prices), source.stats["pages"] - source.stats["not_grocery"])

    def test_sito_irraggiungibile(self):
        source = CarrefourSource(fetcher(FakeSite(overrides={"/sitemap_index.xml": (403, b"", {})})), today=TODAY)
        self.assertEqual(list(source.fetch()), [])


class ChainPricesTest(unittest.TestCase):
    def test_listino_d_insegna_su_tutti_i_negozi_dell_area(self):
        raw = [RawPrice(store_ref=CHAIN_REF, ean="40052410", price=1.19), RawPrice(store_ref=CHAIN_REF, ean="99999999", price=2.0)]
        rows, skipped = normalize(raw, {"40052410": "p1"}, {}, {CHAIN_REF: ["s1", "s2"]})
        self.assertEqual([r["storeId"] for r in rows], ["s1", "s2"])
        self.assertEqual(skipped, 1)
        rows, skipped = normalize(raw[:1], {"40052410": "p1"}, {}, {CHAIN_REF: []})
        self.assertEqual((rows, skipped), ([], 1))  # nessun negozio dell'insegna nell'area

    def test_fonte_dal_pannello(self):
        sources = build_sources({"ingestion.sources": ["carrefour"], "scraping.maxRequestsPerRun": 300,
                                 "scraping.delaySeconds": 3, "scraping.carrefourFormats": ["iper"], "scraping.createProducts": False})
        (source,) = sources
        self.assertIsInstance(source, CarrefourSource)
        self.assertEqual((source.fetcher.max_requests, source.fetcher.delay), (300, 3.0))
        self.assertEqual((source.chains, source.create_products), (["Carrefour Iper"], False))


if __name__ == "__main__":
    unittest.main()
