"""BFS-краулер аудита: asyncio + aiohttp + networkx.

Pipeline (ТЗ 2.2):
    1. robots.txt (urllib.robotparser) + sitemap.xml → Set A
    2. BFS от главной (deque) → Set B, глубина = уровень BFS
    3. Для каждой страницы — параллельный сбор метрик (Semaphore)
    4. inlinks из networkx.DiGraph.predecessors, сироты = A − B
    5. Итоговый report dict

Ограничения (ТЗ 5): Semaphore(50), max_pages=2000, max_depth=4,
request_delay 200ms на домен, HEAD-only для изображений.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Callable, Dict, Optional, Set
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import aiohttp
import networkx as nx
from protego import Protego

from . import issues as issues_mod
from . import page_parser
from .fetcher import FetchResult, assert_public_host, fetch_page, head_request, _headers
from .urls import normalize_url

logger = logging.getLogger("audit.crawler")

DEFAULT_MAX_PAGES = 2000
DEFAULT_MAX_DEPTH = 4
CONCURRENCY = 50
DOMAIN_DELAY_S = 0.2  # вежливый краулинг: 200ms между запросами на домен
MAX_IMAGES_CHECK = 500  # потолок HEAD-проверок изображений на весь аудит
SITEMAP_MAX_URLS = 20000
GRAPH_MAX_NODES = 600   # потолок узлов в экспорте графа для UI-визуализации
GRAPH_MAX_EDGES = 3000


def _export_graph(graph: "nx.DiGraph", pages: Dict[str, dict]) -> dict:
    """Граф структуры сайта для UI (ТЗ 7.2 «Граф»): узлы с глубиной и числом
    ошибок + рёбра. Обрезается по GRAPH_MAX_NODES (приоритет — меньшая глубина,
    затем больше inlinks), чтобы отчёт не разбухал на больших сайтах."""
    def _key(url: str):
        p = pages.get(url) or {}
        return (p.get("crawl_depth") if p.get("crawl_depth") is not None else 99,
                -graph.in_degree(url) if graph.has_node(url) else 0)

    urls = sorted(pages.keys(), key=_key)[:GRAPH_MAX_NODES]
    keep = set(urls)
    nodes = []
    for url in urls:
        p = pages.get(url) or {}
        nodes.append({
            "id": url,
            "depth": p.get("crawl_depth") or 0,
            "issues": len(p.get("issues") or []),
            "status_code": p.get("status_code"),
            "inlinks": graph.in_degree(url) if graph.has_node(url) else 0,
        })
    edges = []
    for s, t in graph.edges():
        if s in keep and t in keep:
            edges.append([s, t])
            if len(edges) >= GRAPH_MAX_EDGES:
                break
    return {"nodes": nodes, "edges": edges,
            "truncated": graph.number_of_nodes() > len(nodes)}

_SKIP_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".pdf", ".zip",
    ".rar", ".doc", ".docx", ".xls", ".xlsx", ".mp4", ".mp3", ".avi", ".css",
    ".js", ".woff", ".woff2", ".ttf", ".eot", ".xml", ".json",
)


def _norm(url: str) -> Optional[str]:
    """Нормализация URL для visited-set (БАГФИКС #1): единая каноническая
    форма через normalize_url (без trailing slash, отсортированный query,
    без fragment) + отсев не-HTML расширений."""
    try:
        n = normalize_url(url)
        if not n:
            return None
        low = (urlsplit(n).path or "/").lower()
        if any(low.endswith(ext) for ext in _SKIP_EXTENSIONS):
            return None
        return n
    except Exception:
        return None


class _DomainThrottle:
    """request_delay между запросами на один домен."""

    def __init__(self, delay: float = DOMAIN_DELAY_S):
        self._delay = delay
        self._last: Dict[str, float] = {}
        self._locks: Dict[str, asyncio.Lock] = {}

    async def wait(self, url: str):
        host = (urlsplit(url).hostname or "").lower()
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            last = self._last.get(host, 0.0)
            wait_s = self._delay - (now - last)
            if wait_s > 0:
                await asyncio.sleep(wait_s)
            self._last[host] = time.monotonic()


async def _fetch_text(session: aiohttp.ClientSession, url: str, limit: int = 4 * 1024 * 1024) -> str:
    if not await assert_public_host(url):
        return ""
    try:
        async with session.get(url, headers=_headers(),
                               timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status != 200:
                return ""
            body = await resp.content.read(limit)
            return body.decode(resp.charset or "utf-8", errors="replace")
    except Exception:
        return ""


async def load_robots(session: aiohttp.ClientSession, base_url: str):
    """Скачивает robots.txt один раз, возвращает (Protego|None, sitemap_urls).

    БАГФИКС #1 (Health Score = 0): urllib.robotparser не понимает wildcard-
    директивы (`Disallow: /*?`, `Disallow: */feed/` и т.п.), из-за чего такие
    страницы реально скачивались краулером, ловили 404/дубли и обнуляли
    health_score. Protego корректно поддерживает `*`/`$`."""
    parts = urlsplit(base_url)
    robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
    text = await _fetch_text(session, robots_url, limit=512 * 1024)
    sitemaps = []
    rp = None
    if text:
        rp = Protego.parse(text)
        for line in text.splitlines():
            if line.lower().startswith("sitemap:"):
                sitemaps.append(line.split(":", 1)[1].strip())
    if not sitemaps:
        sitemaps = [f"{parts.scheme}://{parts.netloc}/sitemap.xml"]
    return rp, sitemaps


async def load_sitemap_urls(session: aiohttp.ClientSession, sitemap_urls: list,
                            base_host: str, _depth: int = 0) -> Set[str]:
    """Рекурсивно собирает URL из sitemap.xml / sitemap-index (Set A)."""
    out: Set[str] = set()
    if _depth > 2:
        return out
    for sm in sitemap_urls[:20]:
        text = await _fetch_text(session, sm)
        if not text:
            continue
        try:
            root = ElementTree.fromstring(text.encode("utf-8"))
        except ElementTree.ParseError:
            continue
        tag = root.tag.lower()
        locs = [el.text.strip() for el in root.iter()
                if el.tag.lower().endswith("loc") and el.text and el.text.strip()]
        if tag.endswith("sitemapindex"):
            out |= await load_sitemap_urls(session, locs, base_host, _depth + 1)
        else:
            for u in locs:
                n = _norm(u)
                if n and page_parser.base_hostname(n) == base_host:
                    out.add(n)
        if len(out) >= SITEMAP_MAX_URLS:
            break
    return out


async def run_audit(start_url: str, *,
                    max_pages: int = DEFAULT_MAX_PAGES,
                    max_depth: int = DEFAULT_MAX_DEPTH,
                    use_playwright: bool = False,
                    check_images: bool = True,
                    progress_cb: Optional[Callable[[dict], None]] = None) -> dict:
    """Полный аудит сайта. Возвращает финальный report dict (ТЗ 6)."""
    start = _norm(start_url) or start_url
    base_host = page_parser.base_hostname(start)
    max_pages = max(1, min(int(max_pages or DEFAULT_MAX_PAGES), 5000))
    max_depth = max(0, min(int(max_depth or DEFAULT_MAX_DEPTH), 10))

    graph = nx.DiGraph()
    pages: Dict[str, dict] = {}
    visited: Set[str] = set()
    queued: Set[str] = set()
    throttle = _DomainThrottle()
    sem = asyncio.Semaphore(CONCURRENCY)

    connector = aiohttp.TCPConnector(limit=CONCURRENCY)
    async with aiohttp.ClientSession(connector=connector) as session:
        # 1. robots.txt + sitemap (кешируются на задачу — один запрос,
        #    БАГФИКС #3: RobotsCache инициализируется 1 раз при старте задачи)
        rp, sitemap_locs = await load_robots(session, start)
        if rp is not None:
            # Уважаем Crawl-delay из robots.txt (не меньше дефолтной вежливой паузы)
            try:
                cd = rp.crawl_delay("*")
                if cd:
                    throttle._delay = max(DOMAIN_DELAY_S, float(cd))
            except Exception:
                pass
        sitemap_urls = await load_sitemap_urls(session, sitemap_locs, base_host)

        # 2. BFS
        queue: deque = deque([(start, 0)])
        queued.add(start)
        total_found = 1
        # БАГФИКС #1: Protego (в отличие от urllib.robotparser) корректно
        # матчит wildcard-директивы (`/*?`, `*/feed/`), но только если ему
        # передать RAW-ссылку (с исходным query, до normalize_url, которая
        # обрезает trailing slash и может съесть "?"). raw_map хранит первую
        # встреченную сырую форму для каждой нормализованной ссылки.
        raw_map: Dict[str, str] = {start: start}

        def _robots_blocked(url: str) -> bool:
            if rp is None:
                return False
            try:
                return not rp.can_fetch(raw_map.get(url, url), "*")
            except Exception:
                return False

        async def process(url: str, depth: int):
            nonlocal total_found
            # БАГФИКС #3: запрещённые в robots.txt страницы НЕ сканируем —
            # фиксируем факт блокировки без HTTP-запроса.
            robots_blocked = _robots_blocked(url)
            if robots_blocked:
                return {
                    "url": url,
                    "status_code": None,
                    "fetch_status": "robots_blocked",
                    "robots_blocked": True,
                    "response_time_ms": None,
                    "content_size_bytes": None,
                    "crawl_depth": depth,
                    "is_https": url.startswith("https://"),
                    "redirect_chain": [],
                    "fetch_method": None,
                    "error": None,
                    "indexability": {
                        "meta_robots": None,
                        "x_robots_tag": None,
                        "robots_txt_blocked": True,
                        "canonical": None,
                    },
                    "indexable": False,
                    "parsed": False,
                }

            async with sem:
                await throttle.wait(url)
                res: FetchResult = await fetch_page(session, url, use_playwright=use_playwright)

            page = {
                "url": url,
                "status_code": res.status_code,
                "final_url": res.final_url,
                "response_time_ms": res.response_time_ms,
                "content_size_bytes": res.content_size_bytes,
                "crawl_depth": depth,
                "is_https": url.startswith("https://"),
                "redirect_chain": res.redirect_chain,
                "fetch_method": res.method,
                "error": res.error,
                "indexability": {
                    "meta_robots": None,
                    "x_robots_tag": None,
                    "robots_txt_blocked": False,
                    "canonical": None,
                },
                "parsed": False,
            }

            if res.html and res.status_code == 200:
                try:
                    parsed = page_parser.parse_page(res.final_url or url, res.html)
                    idx = parsed.pop("indexability")
                    page["indexability"]["meta_robots"] = idx.get("meta_robots")
                    page["indexability"]["canonical"] = idx.get("canonical")
                    page.update(parsed)
                except Exception as e:
                    logger.warning("parse failed for %s: %s", url, e)
            return page

        while queue and len(pages) < max_pages:
            # Волна текущего уровня очереди — параллельно, пачками
            batch = []
            while queue and len(batch) + len(pages) < max_pages and len(batch) < CONCURRENCY:
                u, d = queue.popleft()
                if u in visited or d > max_depth:
                    continue
                visited.add(u)
                batch.append((u, d))
            if not batch:
                break

            results = await asyncio.gather(*[process(u, d) for u, d in batch],
                                           return_exceptions=True)
            for (u, d), page in zip(batch, results):
                if isinstance(page, Exception):
                    logger.warning("crawl error %s: %s", u, page)
                    page = {"url": u, "status_code": None, "crawl_depth": d,
                            "error": str(page)[:200], "parsed": False,
                            "is_https": u.startswith("https://"),
                            "redirect_chain": [],
                            "indexability": {"meta_robots": None, "x_robots_tag": None,
                                             "robots_txt_blocked": False, "canonical": None}}
                pages[u] = page
                graph.add_node(u)
                for link in page.get("outlinks_internal") or []:
                    n = _norm(link)
                    if not n or page_parser.base_hostname(n) != base_host:
                        continue
                    raw_map.setdefault(n, link)
                    # БАГФИКС #2: проверяем robots.txt ДО добавления в граф/очередь —
                    # заблокированные URL с GET-параметрами не тратят max_pages и не
                    # засоряют граф структуры сайта.
                    if _robots_blocked(n):
                        graph.add_node(n, robots_blocked=True)
                        graph.add_edge(u, n)
                        continue
                    graph.add_edge(u, n)
                    if n not in visited and n not in queued and len(queued) < max_pages * 3:
                        queued.add(n)
                        total_found += 1
                        queue.append((n, d + 1))

            if progress_cb:
                progress_cb({"crawled": len(pages), "total_found": max(total_found, len(pages))})

        # 3. HEAD-проверка изображений (только HEAD, потолок MAX_IMAGES_CHECK)
        if check_images:
            seen_imgs: Dict[str, dict] = {}
            for p in pages.values():
                for img in p.get("images") or []:
                    if img["src"] not in seen_imgs and len(seen_imgs) < MAX_IMAGES_CHECK:
                        seen_imgs[img["src"]] = img

            async def check_img(src: str):
                async with sem:
                    await throttle.wait(src)
                    return src, await head_request(session, src)

            head_results = await asyncio.gather(
                *[check_img(src) for src in seen_imgs], return_exceptions=True)
            head_map = {}
            for r in head_results:
                if not isinstance(r, Exception):
                    head_map[r[0]] = r[1]
            for p in pages.values():
                for img in p.get("images") or []:
                    info = head_map.get(img["src"])
                    if info:
                        img["status_code"] = info["status_code"]
                        img["size_bytes"] = info["size_bytes"]

    # 4. inlinks из графа
    for url, page in pages.items():
        try:
            page["inlinks"] = list(graph.predecessors(url))[:200]
        except Exception:
            page["inlinks"] = []

    # 5. Ошибки + сводка
    all_issues = []
    raw_codes: Dict[str, list] = {}
    for url, page in pages.items():
        page_iss = issues_mod.page_issues(page)
        raw_codes[url] = [i["code"] for i in page_iss]
        all_issues.extend(page_iss)
    cross = issues_mod.site_issues(pages, sitemap_urls)
    # раскидываем cross-page коды по страницам
    for it in cross:
        if it["page_url"] in raw_codes:
            raw_codes[it["page_url"]].append(it["code"])
    all_issues.extend(cross)
    # Дедупликация кодов (ТЗ 6): [{"code","count"}] перед сохранением в БД
    for url, codes in raw_codes.items():
        pages[url]["issues"] = issues_mod.deduplicate_issues(codes)

    duplicates = issues_mod.find_duplicate_content(pages)
    orphans = issues_mod.find_orphan_pages(
        {issues_mod._norm_url(u) for u in sitemap_urls},
        {issues_mod._norm_url(u) for u in pages.keys()})

    depths = [p.get("crawl_depth") or 0 for p in pages.values()]
    graph_stats = {
        "avg_depth": round(sum(depths) / len(depths), 2) if depths else 0,
        "max_depth": max(depths) if depths else 0,
        "orphan_count": len(orphans),
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
    }

    summary = issues_mod.summarize(all_issues, len(pages))

    graph_export = _export_graph(graph, pages)

    # Обрезаем тяжёлые поля страниц для финального JSON (anchors/outlinks дают
    # мегабайты; в отчёте оставляем counts + top-примеры).
    slim_pages = []
    for url, p in pages.items():
        slim = dict(p)
        slim["inlinks_count"] = len(p.get("inlinks") or [])
        slim["outlinks_internal_count"] = len(p.get("outlinks_internal") or [])
        slim["outlinks_external_count"] = len(p.get("outlinks_external") or [])
        slim["images_count"] = len(p.get("images") or [])
        slim["inlinks"] = (p.get("inlinks") or [])[:20]
        slim["outlinks_internal"] = (p.get("outlinks_internal") or [])[:20]
        slim["outlinks_external"] = (p.get("outlinks_external") or [])[:20]
        slim["anchors"] = (p.get("anchors") or [])[:20]
        slim["images"] = (p.get("images") or [])[:30]
        slim["h2"] = (p.get("h2") or [])[:20]
        slim_pages.append(slim)

    return {
        "start_url": start,
        "summary": summary,
        "pages": slim_pages,
        "issues": all_issues,
        "issue_defs": issues_mod.ISSUE_DEFS,
        "duplicates": duplicates,
        "orphan_pages": orphans,
        "sitemap_url_count": len(sitemap_urls),
        "graph_stats": graph_stats,
        "graph": graph_export,
    }
