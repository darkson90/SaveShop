"""Parametri del pannello nell'Ingestion: python -m unittest discover -s tests"""
import os
import unittest
from unittest import mock

from ingestion.__main__ import build_sources, setting, as_list
from ingestion.sources.demo import DemoSource
from ingestion.sources.feeds import FeedSource
from ingestion.sources.open_prices import OpenPricesSource


class SettingTest(unittest.TestCase):
    def test_pannello_poi_ambiente_poi_predefinito(self):
        with mock.patch.dict(os.environ, {"OPEN_PRICES_DAYS": "30"}):
            self.assertEqual(setting({"ingestion.openPricesDays": 10}, "ingestion.openPricesDays", "OPEN_PRICES_DAYS", 60, int), 10)
            self.assertEqual(setting({}, "ingestion.openPricesDays", "OPEN_PRICES_DAYS", 60, int), 30)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(setting({}, "ingestion.openPricesDays", "OPEN_PRICES_DAYS", 60, int), 60)

    def test_fonti_dal_pannello(self):
        sources = build_sources({"ingestion.sources": ["open_prices", "feeds"], "ingestion.openPricesRadiusKm": 15,
                                 "ingestion.feeds": ["https://esempio.it/listino.json"]})
        self.assertEqual([type(s) for s in sources], [OpenPricesSource, FeedSource])
        self.assertEqual(sources[0].radius_km, 15)
        self.assertEqual(sources[1].locations, ["https://esempio.it/listino.json"])

    def test_fonti_dall_ambiente(self):
        with mock.patch.dict(os.environ, {"INGESTION_SOURCES": "demo"}):
            self.assertEqual([type(s) for s in build_sources({})], [DemoSource])
        self.assertEqual(as_list(" a, ,b "), ["a", "b"])


if __name__ == "__main__":
    unittest.main()
