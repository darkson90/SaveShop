"""Scaricamento rispettoso delle pagine: robots.txt, pausa per dominio, retry limitati, tetto di richieste."""
import gzip
import time
import urllib.error
import urllib.request
import urllib.robotparser
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlparse

USER_AGENT = "SaveShopBot/0.3 (+https://github.com/darkson90/SaveShop; confronto prezzi della spesa)"


@dataclass
class Response:
    status: int
    body: bytes
    headers: dict

    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


class BudgetExhausted(Exception):
    """Raggiunto il tetto di richieste dell'esecuzione: il resto alla prossima."""


class SiteUnavailable(Exception):
    """Troppi errori di fila o blocco esplicito del sito: ci si ferma per questa esecuzione."""


def urllib_transport(url: str, headers: dict, timeout: float) -> Response:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read()
            hdrs = {k.lower(): v for k, v in res.headers.items()}
            status = res.status
    except urllib.error.HTTPError as err:
        body = err.read() if err.fp else b""
        hdrs = {k.lower(): v for k, v in (err.headers or {}).items()}
        status = err.code
    if hdrs.get("content-encoding") == "gzip":
        body = gzip.decompress(body)
    return Response(status, body, hdrs)


class PoliteFetcher:
    def __init__(
        self,
        delay_seconds: float = 1.5,
        max_requests: int = 1500,
        max_consecutive_errors: int = 8,
        timeout: float = 20.0,
        transport: Callable[[str, dict, float], Response] = urllib_transport,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.delay = max(0.0, delay_seconds)
        self.max_requests = max_requests
        self.max_errors = max_consecutive_errors
        self.timeout = timeout
        self.transport = transport
        self.sleep = sleep
        self.clock = clock
        self.requests = 0
        self.errors_in_a_row = 0
        self.skipped_by_robots = 0
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._last: dict[str, float] = {}

    @property
    def remaining(self) -> int:
        return max(0, self.max_requests - self.requests)

    def _wait_turn(self, host: str) -> None:
        last = self._last.get(host)
        if last is not None:
            wait = self.delay - (self.clock() - last)
            if wait > 0:
                self.sleep(wait)
        self._last[host] = self.clock()

    def _raw(self, url: str) -> Response:
        if self.requests >= self.max_requests:
            raise BudgetExhausted(f"{self.max_requests} richieste")
        host = urlparse(url).netloc
        self._wait_turn(host)
        self.requests += 1
        return self.transport(url, {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip", "Accept-Language": "it-IT"}, self.timeout)

    def robots(self, url: str) -> urllib.robotparser.RobotFileParser | None:
        parts = urlparse(url)
        key = f"{parts.scheme}://{parts.netloc}"
        if key not in self._robots:
            parser = urllib.robotparser.RobotFileParser(f"{key}/robots.txt")
            try:
                res = self._raw(f"{key}/robots.txt")
            except OSError:
                res = Response(599, b"", {})
            if res.status == 200:
                parser.parse(res.text().splitlines())
            elif res.status in (401, 403):
                parser.disallow_all = True  # come da RFC 9309: accesso negato a robots.txt = tutto vietato
            elif res.status >= 500:
                parser.disallow_all = True  # server in difficoltà: meglio non insistere
            else:
                parser.allow_all = True  # robots.txt assente
            self._robots[key] = parser
        return self._robots[key]

    def allowed(self, url: str) -> bool:
        parser = self.robots(url)
        return parser.can_fetch(USER_AGENT, url) if parser else True

    def crawl_delay(self, url: str) -> None:
        """Se robots.txt indica Crawl-delay più lungo della pausa configurata, vale quello."""
        parser = self.robots(url)
        delay = parser.crawl_delay(USER_AGENT) if parser else None
        if delay and float(delay) > self.delay:
            self.delay = float(delay)

    def get(self, url: str, retries: int = 2) -> Response | None:
        """Pagina scaricata, oppure None se vietata da robots.txt o non trovata (404/410)."""
        if not self.allowed(url):
            self.skipped_by_robots += 1
            return None
        self.crawl_delay(url)
        for attempt in range(retries + 1):
            try:
                res = self._raw(url)
            except OSError as exc:
                res, error = None, exc
            else:
                error = None
            if res is not None and res.status == 200:
                self.errors_in_a_row = 0
                return res
            if res is not None and res.status in (404, 410):
                self.errors_in_a_row = 0
                return None
            if res is not None and res.status == 403:
                raise SiteUnavailable(f"accesso negato (403) su {urlparse(url).netloc}")
            self.errors_in_a_row += 1
            if self.errors_in_a_row >= self.max_errors:
                raise SiteUnavailable(f"{self.errors_in_a_row} errori di fila su {urlparse(url).netloc}")
            if attempt < retries:
                retry_after = (res.headers.get("retry-after") if res is not None else None) or ""
                wait = float(retry_after) if retry_after.isdigit() else self.delay * (2 ** (attempt + 2))
                self.sleep(min(wait, 300))
        if error:
            print(f"[scraping] {url}: {error}", flush=True)
        return None
