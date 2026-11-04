"""Siti dei supermercati simulati con pagine registrate (tests/fixtures/<catena>), per unit test ed end-to-end."""
import json
from pathlib import Path
from urllib.parse import urlparse

from ingestion.scraping.http import Response

ROOT = Path(__file__).parent / "fixtures"
FIXTURES = ROOT / "carrefour"


def routes(site: str) -> dict:
    return json.loads((ROOT / site / "routes.json").read_text())


def page(path: str, base: str, site: str = "carrefour") -> bytes | None:
    name = routes(site).get(path)
    return (ROOT / site / name).read_text().replace("{BASE}", base).encode() if name else None


class FakeSite:
    """Trasporto per PoliteFetcher: risponde dalle fixture e registra le richieste ricevute."""

    def __init__(self, base: str = "https://www.carrefour.it", overrides: dict | None = None, site: str = "carrefour"):
        self.base = base
        self.site = site
        self.overrides = overrides or {}  # percorso -> (stato, corpo, intestazioni)
        self.requests: list[str] = []

    def __call__(self, url: str, headers: dict, timeout: float) -> Response:
        self.requests.append(url)
        self.user_agent = headers.get("User-Agent")
        path = urlparse(url).path
        if path in self.overrides:
            status, body, hdrs = self.overrides[path]
            return Response(status, body, hdrs)
        body = page(path, self.base, self.site)
        return Response(200, body, {}) if body is not None else Response(404, b"", {})
