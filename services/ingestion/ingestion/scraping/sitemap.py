"""Sitemap XML (urlset o indice di sitemap), anche compresse con gzip."""
import gzip
import xml.etree.ElementTree as ET
from dataclasses import dataclass


@dataclass(frozen=True)
class SitemapEntry:
    loc: str
    lastmod: str | None = None


def parse_sitemap(data: bytes | str) -> tuple[list[SitemapEntry], list[str]]:
    """Restituisce (pagine, sitemap figlie). Un indice ha solo figlie, un urlset solo pagine."""
    if isinstance(data, bytes):
        if data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        data = data.decode("utf-8", "replace")
    root = ET.fromstring(data.strip())
    pages, children = [], []
    for el in root:
        tag = el.tag.rsplit("}", 1)[-1]
        loc = next((c.text.strip() for c in el if c.tag.endswith("loc") and c.text), None)
        if not loc:
            continue
        if tag == "sitemap":
            children.append(loc)
        elif tag == "url":
            lastmod = next((c.text.strip() for c in el if c.tag.endswith("lastmod") and c.text), None)
            pages.append(SitemapEntry(loc, lastmod))
    return pages, children
