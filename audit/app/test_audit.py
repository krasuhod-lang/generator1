"""Тесты чистых функций аудита: issues.py + page_parser.py.

Запуск: python -m pytest app/test_audit.py  (или python -m unittest)
"""

import unittest

from . import issues, page_parser
from .urls import normalize_url


class TestNormalizeUrl(unittest.TestCase):
    """БАГФИКС #1: /page/ == /page, сортировка query, без fragment."""

    def test_trailing_slash(self):
        self.assertEqual(normalize_url("https://e.com/page/"), "https://e.com/page")
        self.assertEqual(normalize_url("https://e.com/"), "https://e.com/")
        self.assertEqual(normalize_url("https://e.com"), "https://e.com/")

    def test_query_sorted(self):
        self.assertEqual(normalize_url("https://e.com/p?pg=2&cat=1"),
                         normalize_url("https://e.com/p?cat=1&pg=2"))

    def test_fragment_removed(self):
        self.assertEqual(normalize_url("https://e.com/p#anchor"), "https://e.com/p")

    def test_host_lower_default_port(self):
        self.assertEqual(normalize_url("HTTPS://E.com:443/p"), "https://e.com/p")
        self.assertEqual(normalize_url("https://e.com:8080/p"), "https://e.com:8080/p")

    def test_invalid(self):
        self.assertIsNone(normalize_url("mailto:x@y.z"))
        self.assertIsNone(normalize_url(""))


class TestContentHash(unittest.TestCase):
    """БАГФИКС #2: умный хеш с порогом 150 символов."""

    def test_short_text_uses_html_structure(self):
        h = page_parser.get_content_hash("<html><body><nav>menu</nav></body></html>", "")
        self.assertEqual(h["type"], "html_structure")
        self.assertIsNotNone(h["hash"])

    def test_listing_pages_differ(self):
        # Разные листинги с пустым clean_text не должны давать одинаковый хеш
        h1 = page_parser.get_content_hash("<html><body><a href='/a'>Услуги</a></body></html>", "")
        h2 = page_parser.get_content_hash("<html><body><a href='/b'>Блог</a></body></html>", "")
        self.assertNotEqual(h1["hash"], h2["hash"])

    def test_script_style_stripped(self):
        base = "<html><body><p>x</p></body></html>"
        with_js = "<html><body><script>var t=Date.now()</script><p>x</p></body></html>"
        self.assertEqual(page_parser.get_content_hash(base, "")["hash"],
                         page_parser.get_content_hash(with_js, "")["hash"])

    def test_long_text_uses_text_content(self):
        text = "слово " * 50
        h = page_parser.get_content_hash("<html>...</html>", text)
        self.assertEqual(h["type"], "text_content")
        # Нормализация регистра и пробелов
        h2 = page_parser.get_content_hash("<other></other>", text.upper() + "  ")
        self.assertEqual(h["hash"], h2["hash"])


class TestDeduplicateIssues(unittest.TestCase):
    def test_dedup(self):
        out = issues.deduplicate_issues(
            ["missing_alt", "missing_alt", "missing_alt", "large_image", "large_image"])
        self.assertEqual(out, [{"code": "missing_alt", "count": 3},
                               {"code": "large_image", "count": 2}])

    def test_empty(self):
        self.assertEqual(issues.deduplicate_issues([]), [])


def _page(**kw):
    base = {
        "url": "https://example.com/page",
        "status_code": 200,
        "parsed": True,
        "crawl_depth": 1,
        "is_https": True,
        "redirect_chain": [],
        "title": {"text": "Нормальный заголовок страницы про SEO-аудит", "length_chars": 42},
        "meta_description": {"text": "О" * 100, "length_chars": 100},
        "h1": [{"text": "H1"}],
        "text_html_ratio": 0.25,
        "mixed_content": [],
        "images": [],
        "indexability": {"meta_robots": None, "canonical": None,
                         "robots_txt_blocked": False, "x_robots_tag": None},
    }
    base.update(kw)
    return base


class TestPageIssues(unittest.TestCase):
    def codes(self, page):
        return {i["code"] for i in issues.page_issues(page)}

    def test_healthy_page_no_issues(self):
        self.assertEqual(self.codes(_page()), set())

    def test_404_and_5xx(self):
        self.assertIn("404_page", self.codes(_page(status_code=404)))
        self.assertIn("5xx_error", self.codes(_page(status_code=502)))

    def test_redirect_chain_and_loop(self):
        self.assertIn("redirect_chain", self.codes(_page(redirect_chain=["a", "b"])))
        self.assertIn("redirect_loop", self.codes(_page(redirect_chain=["a", "b", "a"])))

    def test_redirect_chain_dict_hops(self):
        # БАГФИКС #4: хопы цепочки — {"url","status"}
        chain = [{"url": "a", "status": 301}, {"url": "b", "status": 301}]
        self.assertIn("redirect_chain", self.codes(_page(redirect_chain=chain)))
        loop = chain + [{"url": "a", "status": None}]
        self.assertIn("redirect_loop", self.codes(_page(redirect_chain=loop)))
        one_hop = [{"url": "a", "status": 301}]
        self.assertNotIn("redirect_chain", self.codes(_page(redirect_chain=one_hop)))

    def test_robots_blocked_page(self):
        # БАГФИКС #3: заблокированная страница получает только robots_blocked
        c = self.codes(_page(status_code=None, robots_blocked=True, parsed=False))
        self.assertEqual(c, {"robots_blocked"})

    def test_fetch_error(self):
        self.assertIn("fetch_error", self.codes(_page(status_code=None, error="timeout", parsed=False)))

    def test_missing_title_description_h1(self):
        c = self.codes(_page(title={"text": "", "length_chars": 0},
                             meta_description={"text": "", "length_chars": 0}, h1=[]))
        self.assertTrue({"missing_title", "missing_description", "missing_h1"} <= c)

    def test_title_length_bounds(self):
        self.assertIn("title_too_long", self.codes(_page(title={"text": "x" * 80, "length_chars": 80})))
        self.assertIn("title_too_short", self.codes(_page(title={"text": "x" * 10, "length_chars": 10})))

    def test_description_too_long(self):
        self.assertIn("description_too_long",
                      self.codes(_page(meta_description={"text": "x" * 200, "length_chars": 200})))

    def test_multiple_h1(self):
        self.assertIn("multiple_h1", self.codes(_page(h1=[{"text": "a"}, {"text": "b"}])))

    def test_mixed_content(self):
        self.assertIn("mixed_content",
                      self.codes(_page(mixed_content=[{"tag": "img", "url": "http://x/i.jpg"}])))

    def test_images(self):
        c = self.codes(_page(images=[
            {"src": "a.jpg", "alt": "", "size_bytes": 200000, "status_code": 404},
        ]))
        self.assertTrue({"missing_alt", "large_image", "404_image"} <= c)

    def test_deep_page_and_low_ratio(self):
        self.assertIn("deep_page", self.codes(_page(crawl_depth=5)))
        self.assertIn("low_text_ratio", self.codes(_page(text_html_ratio=0.05)))


class TestSiteIssues(unittest.TestCase):
    def test_duplicates_and_orphans(self):
        pages = {
            "https://e.com/a": _page(url="https://e.com/a", content_hash="H1"),
            "https://e.com/b": _page(url="https://e.com/b", content_hash="H1"),
        }
        sitemap = {"https://e.com/a", "https://e.com/orphan"}
        iss = issues.site_issues(pages, sitemap)
        codes = {(i["code"], i["page_url"]) for i in iss}
        self.assertIn(("duplicate_content", "https://e.com/a"), codes)
        self.assertIn(("duplicate_title", "https://e.com/a"), codes)
        self.assertIn(("orphan_page", "https://e.com/orphan"), codes)

    def test_duplicates_exclude_html_structure(self):
        # БАГФИКС #2: листинги (html_structure) не считаются дублями
        pages = {
            "https://e.com/a": _page(url="https://e.com/a", content_hash="H1",
                                     content_hash_type="html_structure"),
            "https://e.com/b": _page(url="https://e.com/b", content_hash="H1",
                                     content_hash_type="html_structure"),
            "https://e.com/c": _page(url="https://e.com/c", content_hash="H2",
                                     content_hash_type="text_content"),
            "https://e.com/d": _page(url="https://e.com/d", content_hash="H2",
                                     content_hash_type="text_content"),
        }
        dups = issues.find_duplicate_content(pages)
        self.assertNotIn("H1", dups)
        self.assertIn("H2", dups)

    def test_noindex_in_sitemap(self):
        p = _page(url="https://e.com/a")
        p["indexability"]["meta_robots"] = "noindex, follow"
        iss = issues.site_issues({"https://e.com/a": p}, {"https://e.com/a"})
        self.assertIn("noindex_in_sitemap", {i["code"] for i in iss})

    def test_canonical_conflict(self):
        p = _page(url="https://e.com/a")
        p["indexability"]["canonical"] = "https://other.com/page"
        iss = issues.site_issues({"https://e.com/a": p}, set())
        self.assertIn("canonical_conflict", {i["code"] for i in iss})

    def test_summarize_health_score(self):
        iss = [{"severity": "critical"}] * 2 + [{"severity": "high"}] * 3 + \
              [{"severity": "medium"}] * 4 + [{"severity": "low"}] * 10
        s = issues.summarize(iss, 100)
        # 100 - 20 - 9 - 4 - 3 = 64
        self.assertEqual(s["health_score"], 64)
        self.assertEqual(s["issues_critical"], 2)

    def test_health_score_floor_zero(self):
        s = issues.summarize([{"severity": "critical"}] * 50, 10)
        self.assertEqual(s["health_score"], 0)


class TestGraphExport(unittest.TestCase):
    def test_export_graph_nodes_edges(self):
        import networkx as nx
        from . import crawler
        g = nx.DiGraph()
        g.add_edge("https://e.com/", "https://e.com/a")
        g.add_edge("https://e.com/", "https://e.com/b")
        pages = {
            "https://e.com/":  _page(url="https://e.com/", crawl_depth=0, issues=[]),
            "https://e.com/a": _page(url="https://e.com/a", crawl_depth=1, issues=["missing_h1"]),
            "https://e.com/b": _page(url="https://e.com/b", crawl_depth=1, issues=[]),
        }
        out = crawler._export_graph(g, pages)
        self.assertEqual(len(out["nodes"]), 3)
        self.assertEqual(len(out["edges"]), 2)
        self.assertFalse(out["truncated"])
        root = next(n for n in out["nodes"] if n["id"] == "https://e.com/")
        self.assertEqual(root["depth"], 0)
        a = next(n for n in out["nodes"] if n["id"] == "https://e.com/a")
        self.assertEqual(a["issues"], 1)
        self.assertEqual(a["inlinks"], 1)

    def test_export_graph_truncation(self):
        import networkx as nx
        from . import crawler
        g = nx.DiGraph()
        pages = {}
        for i in range(crawler.GRAPH_MAX_NODES + 50):
            u = f"https://e.com/p{i}"
            g.add_node(u)
            pages[u] = _page(url=u, crawl_depth=i % 5, issues=[])
        out = crawler._export_graph(g, pages)
        self.assertEqual(len(out["nodes"]), crawler.GRAPH_MAX_NODES)
        self.assertTrue(out["truncated"])


class TestRobotsWildcard(unittest.TestCase):
    """БАГФИКС #1: Protego (в отличие от urllib.robotparser) корректно
    матчит wildcard-директивы (`/*?`, `*/feed/`), из-за которых страницы
    с GET-параметрами ошибочно скачивались и обнуляли health_score."""

    def test_disallow_query_wildcard(self):
        from protego import Protego
        rp = Protego.parse("User-agent: *\nDisallow: /*?\n")
        self.assertTrue(rp.can_fetch("https://site.com/page/", "*"))
        self.assertFalse(rp.can_fetch("https://site.com/?sort=price", "*"))
        self.assertFalse(rp.can_fetch("https://site.com/page/?cat=1", "*"))

    def test_disallow_feed_wildcard(self):
        from protego import Protego
        rp = Protego.parse("User-agent: *\nDisallow: */feed/\n")
        self.assertFalse(rp.can_fetch("https://site.com/category/feed/", "*"))
        self.assertTrue(rp.can_fetch("https://site.com/category/", "*"))

    def test_allow_css_wildcard(self):
        from protego import Protego
        rp = Protego.parse("User-agent: *\nDisallow: /\nAllow: /*.css\n")
        self.assertTrue(rp.can_fetch("https://site.com/assets/style.css", "*"))
        self.assertFalse(rp.can_fetch("https://site.com/assets/script.js", "*"))

    def test_crawl_delay(self):
        from protego import Protego
        rp = Protego.parse("User-agent: *\nCrawl-delay: 5\n")
        self.assertEqual(rp.crawl_delay("*"), 5.0)
        rp2 = Protego.parse("User-agent: *\nDisallow:\n")
        self.assertIsNone(rp2.crawl_delay("*"))


class TestPageParser(unittest.TestCase):
    HTML = """
    <html><head>
      <title> Тестовая  страница </title>
      <meta name="description" content="Описание страницы">
      <meta name="robots" content="index, follow">
      <link rel="canonical" href="/page">
      <link rel="alternate" hreflang="en" href="/en/page">
    </head><body>
      <h1>Заголовок</h1><h2>Раздел</h2>
      <p>""" + ("текст " * 100) + """</p>
      <a href="/inner" rel="nofollow">Внутренняя</a>
      <a href="https://external.org/x">Внешняя</a>
      <img src="http://insecure.com/i.jpg" alt="">
    </body></html>
    """

    def test_parse_page(self):
        p = page_parser.parse_page("https://example.com/page", self.HTML)
        self.assertEqual(p["title"]["text"], "Тестовая страница")
        self.assertEqual(p["meta_description"]["text"], "Описание страницы")
        self.assertEqual(len(p["h1"]), 1)
        self.assertEqual(p["indexability"]["canonical"], "https://example.com/page")
        self.assertEqual(p["indexability"]["meta_robots"], "index, follow")
        self.assertEqual(p["hreflang"][0]["lang"], "en")
        self.assertIn("https://example.com/inner", p["outlinks_internal"])
        self.assertIn("https://external.org/x", p["outlinks_external"])
        self.assertEqual(p["anchors"][0]["rel"], "nofollow")
        self.assertEqual(len(p["mixed_content"]), 1)
        self.assertEqual(len(p["images"]), 1)
        self.assertGreater(p["word_count"], 50)
        self.assertIsNotNone(p["content_hash"])
        self.assertGreater(p["text_html_ratio"], 0)

    def test_length_px(self):
        p = page_parser.parse_page("https://e.com/", "<html><head><title>ABCD</title></head><body></body></html>")
        self.assertEqual(p["title"]["length_px"], 30)  # 4 * 7.5


if __name__ == "__main__":
    unittest.main()
