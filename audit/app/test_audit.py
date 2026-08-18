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
        "title": {"text": "З" * 75, "length_chars": 75},
        "meta_description": {"text": "О" * 185, "length_chars": 185},
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
        self.assertIn("title_too_long", self.codes(_page(title={"text": "x" * 90, "length_chars": 90})))
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

    def test_external_canonical_skips_content_issues(self):
        # ТЗ 3: canonical на другой URL → контентные ошибки не считаются
        p = _page(url="https://e.com/?cat=1",
                  title={"text": "", "length_chars": 0},
                  meta_description={"text": "", "length_chars": 0}, h1=[],
                  text_html_ratio=0.01,
                  indexability={"meta_robots": None, "canonical": "https://e.com/main/",
                                "robots_txt_blocked": False, "x_robots_tag": None})
        self.assertEqual(issues.page_issues(p), [])

    def test_self_canonical_keeps_issues(self):
        p = _page(url="https://e.com/page",
                  title={"text": "", "length_chars": 0},
                  indexability={"meta_robots": None, "canonical": "https://e.com/page/",
                                "robots_txt_blocked": False, "x_robots_tag": None})
        self.assertIn("missing_title", {i["code"] for i in issues.page_issues(p)})


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

    def test_export_graph_filters_blocked_and_canonical(self):
        # ТЗ 7: robots_blocked и canonical-дубли не попадают в экспорт графа
        import networkx as nx
        from . import crawler
        g = nx.DiGraph()
        g.add_edge("https://e.com/", "https://e.com/a")
        g.add_node("https://e.com/?s=x", robots_blocked=True)
        g.add_edge("https://e.com/", "https://e.com/?s=x")
        pages = {
            "https://e.com/":  _page(url="https://e.com/", crawl_depth=0, issues=[]),
            "https://e.com/a": _page(url="https://e.com/a", crawl_depth=1, issues=[]),
            "https://e.com/?cat=1": _page(
                url="https://e.com/?cat=1", crawl_depth=1, issues=[],
                indexability={"meta_robots": None, "canonical": "https://e.com/",
                              "robots_txt_blocked": False, "x_robots_tag": None}),
            "https://e.com/hidden": _page(
                url="https://e.com/hidden", crawl_depth=1, issues=[],
                indexability={"meta_robots": "noindex,follow", "canonical": None,
                              "robots_txt_blocked": False, "x_robots_tag": None}),
        }
        out = crawler._export_graph(g, pages)
        ids = {n["id"] for n in out["nodes"]}
        self.assertEqual(ids, {"https://e.com/", "https://e.com/a"})


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


class TestParseTimeout(unittest.TestCase):
    """ТЗ 5: парсинг HTML в пуле потоков с таймаутом."""

    def test_parse_page_async_ok(self):
        import asyncio
        out = asyncio.run(page_parser.parse_page_async(
            "https://e.com/", "<html><head><title>t</title></head><body>x</body></html>"))
        self.assertIsNotNone(out)
        self.assertTrue(out["parsed"])
        self.assertEqual(out["title"]["text"], "t")


class TestFetcherTimeouts(unittest.TestCase):
    """ТЗ 6: гранулярный ClientTimeout + fetch_status."""

    def test_granular_timeout(self):
        from . import fetcher
        self.assertEqual(fetcher.FETCH_TIMEOUT.connect, 10)
        self.assertEqual(fetcher.FETCH_TIMEOUT.sock_read, 20)
        self.assertGreaterEqual(fetcher.FETCH_TIMEOUT.total, 20)

    def test_fetch_result_default_status(self):
        from . import fetcher
        self.assertEqual(fetcher.FetchResult("https://e.com/").fetch_status, "ok")


class TestParsersClientSegmentation(unittest.TestCase):
    """Client segmentation: новые поля client_segments/works_with и расширенный краул."""

    def test_signature_has_client_fields(self):
        from . import parsers
        fields = parsers.ExtractCompanyServices.output_fields
        self.assertIn("client_segments", fields)
        self.assertIn("works_with", fields)

    def test_link_patterns_include_client_pages(self):
        from . import parsers
        for p in ("/clients", "/клиенты", "/cases", "/кейсы", "/portfolio",
                  "/projects", "/partners", "/reviews", "/отзывы"):
            self.assertIn(p, parsers.LINK_PATTERNS)

    def test_subpage_cap_is_constant(self):
        from . import parsers
        self.assertIsInstance(parsers.MAX_SUBPAGES, int)
        self.assertGreaterEqual(parsers.MAX_SUBPAGES, 5)

    def test_empty_content_yields_empty_segments(self):
        # При пустом контенте LLM не вызывается, а новые поля остаются пустыми.
        import asyncio
        from unittest import mock
        from . import parsers

        class _Res:
            html = ""

        async def _fake_fetch(session, url):
            return _Res()

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_redis", None):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=True, extract_about=True,
                extract_services=True, deepseek_api_key="x", extract_clients=True))

        self.assertEqual(out["client_segments"], [])
        self.assertEqual(out["works_with"], "")
        self.assertEqual(out["status"], "Ошибка: пустой контент")

    def test_coerce_to_list_formats(self):
        from . import parsers
        # JSON-массив
        self.assertEqual(parsers._coerce_to_list('["a", "b"]'), ["a", "b"])
        # Список через перевод строки с маркерами
        self.assertEqual(
            parsers._coerce_to_list("- стоматологии — SEO\n- госзаказчики — тендеры"),
            ["стоматологии — SEO", "госзаказчики — тендеры"])
        # Нумерованный список
        self.assertEqual(parsers._coerce_to_list("1. one\n2) two"), ["one", "two"])
        # Уже список
        self.assertEqual(parsers._coerce_to_list([" x ", "", "y"]), ["x", "y"])
        # Пустые значения
        self.assertEqual(parsers._coerce_to_list(""), [])
        self.assertEqual(parsers._coerce_to_list(None), [])

    def test_uses_env_api_key_when_request_key_empty(self):
        import asyncio
        from unittest import mock
        from . import parsers

        html = (
            "<html><head><title>Главная</title></head><body>"
            "<p>" + ("Компания оказывает услуги SEO и контекстной рекламы. " * 8) + "</p>"
            "</body></html>"
        )

        class _Res:
            def __init__(self, html):
                self.html = html

        async def _fake_fetch(session, url):
            return _Res(html)

        captured = {}

        class _Pred:
            def __call__(self, website_text=""):
                class _Out:
                    contacts_summary = ""
                    about_summary = "Агентство интернет-маркетинга."
                    services_list = '["SEO"]'
                    main_focus = "Продвижение сайтов"
                    client_segments = '["B2B-компании — SEO"]'
                    works_with = "B2B: компании услуг"
                return _Out()

        def _fake_lm(*args, **kwargs):
            captured["api_key"] = kwargs.get("api_key")
            return object()

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers, "DEEPSEEK_API_KEY", "env-deepseek-key"), \
             mock.patch.object(parsers.dspy, "LM", _fake_lm), \
             mock.patch.object(parsers.dspy, "settings", mock.MagicMock()), \
             mock.patch.object(parsers.dspy, "Predict", lambda sig: _Pred()):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=False, extract_about=True,
                extract_services=True, deepseek_api_key="", extract_clients=True))

        self.assertEqual(captured.get("api_key"), "env-deepseek-key")
        self.assertEqual(out["status"], "Успешно")

    def test_missing_api_key_returns_explicit_status(self):
        import asyncio
        from unittest import mock
        from . import parsers

        html = (
            "<html><head><title>Главная</title></head><body>"
            "<p>" + ("Компания оказывает услуги SEO и контекстной рекламы. " * 8) + "</p>"
            "</body></html>"
        )

        class _Res:
            def __init__(self, html):
                self.html = html

        async def _fake_fetch(session, url):
            return _Res(html)

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers, "DEEPSEEK_API_KEY", ""), \
             mock.patch.object(parsers.dspy, "LM", side_effect=AssertionError("LM should not be called")):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=False, extract_about=True,
                extract_services=True, deepseek_api_key="", extract_clients=True))

        self.assertEqual(out["status"], "Ошибка ИИ: не задан DEEPSEEK_API_KEY")

    def test_subpages_reach_website_text(self):
        # ГЛАВНЫЙ БАГФИКС: текст докачанных подстраниц (клиенты/кейсы) должен
        # реально попадать в website_text, передаваемый в LLM, а не теряться.
        import asyncio
        from unittest import mock
        from . import parsers

        main_html = (
            "<html><head><title>Главная</title></head><body>"
            "<p>" + ("Главная компания оказывает услуги маркетинга. " * 8) + "</p>"
            "<a href='/clients'>Клиенты</a></body></html>"
        )
        clients_html = (
            "<html><head><title>Клиенты</title></head><body>"
            "<p>" + ("Работаем со стоматологиями и автосервисами по всей стране. " * 8) + "</p>"
            "</body></html>"
        )
        pages = {
            "https://example.com/": main_html,
            "https://example.com/clients": clients_html,
        }

        class _Res:
            def __init__(self, html):
                self.html = html

        async def _fake_fetch(session, url):
            return _Res(pages.get(url, ""))

        captured = {}

        class _Pred:
            def __call__(self, website_text=""):
                captured["website_text"] = website_text

                class _Out:
                    contacts_summary = ""
                    about_summary = "О компании"
                    services_list = '["маркетинг"]'
                    main_focus = "маркетинг"
                    client_segments = '["стоматологии — маркетинг", "автосервисы — маркетинг"]'
                    works_with = "B2B: малый бизнес"
                return _Out()

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers.dspy, "LM", lambda *a, **k: object()), \
             mock.patch.object(parsers.dspy, "settings", mock.MagicMock()), \
             mock.patch.object(parsers.dspy, "Predict", lambda sig: _Pred()):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=False, extract_about=True,
                extract_services=True, deepseek_api_key="x", extract_clients=True))

        # Текст подстраницы клиентов дошёл до LLM.
        self.assertIn("стоматологиями", captured.get("website_text", ""))
        self.assertIn("Главная компания", captured.get("website_text", ""))
        # Строковый ответ модели нормализован в массив.
        self.assertEqual(out["services"], ["маркетинг"])
        self.assertEqual(out["client_segments"],
                         ["стоматологии — маркетинг", "автосервисы — маркетинг"])
        self.assertEqual(out["status"], "Успешно")

    def test_dspy_string_items_error_recovers_from_lm_history(self):
        # DSPy JSONAdapter может упасть с "'str' object has no attribute 'items'",
        # если модель вернула JSON как строку. Берём сырой ответ из lm.history.
        import asyncio
        import json
        from unittest import mock
        from . import parsers

        html = (
            "<html><head><title>Главная</title></head><body>"
            "<p>" + ("Компания оказывает услуги SEO и контекстной рекламы. " * 8) + "</p>"
            "</body></html>"
        )

        class _Res:
            def __init__(self, html):
                self.html = html

        async def _fake_fetch(session, url):
            return _Res(html)

        raw_output = json.dumps({
            "contacts_summary": "Телефон не найден",
            "about_summary": "Агентство интернет-маркетинга.",
            "services_list": ["SEO", "контекстная реклама"],
            "main_focus": "Продвижение сайтов",
            "client_segments": ["B2B-компании — SEO"],
            "works_with": "B2B: компании услуг",
        }, ensure_ascii=False)

        class _LM:
            history = [{"outputs": [raw_output]}]

        class _Pred:
            def __call__(self, website_text=""):
                raise AttributeError("'str' object has no attribute 'items'")

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers.dspy, "LM", lambda *a, **k: _LM()), \
             mock.patch.object(parsers.dspy, "settings", mock.MagicMock()), \
             mock.patch.object(parsers.dspy, "Predict", lambda sig: _Pred()):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=True, extract_about=True,
                extract_services=True, deepseek_api_key="x", extract_clients=True))

        self.assertEqual(out["status"], "Успешно")
        self.assertEqual(out["contacts"], "Телефон не найден")
        self.assertEqual(out["about"], "Агентство интернет-маркетинга.")
        self.assertEqual(out["services"], ["SEO", "контекстная реклама"])
        self.assertEqual(out["focus"], "Продвижение сайтов")
        self.assertEqual(out["client_segments"], ["B2B-компании — SEO"])
        self.assertEqual(out["works_with"], "B2B: компании услуг")

    def test_link_join_uses_urljoin(self):
        # Относительные ссылки склеиваются через urljoin (без обрезки пути базы),
        # protocol-relative и внешние домены отсекаются.
        import asyncio
        from unittest import mock
        from . import parsers

        main_html = (
            "<html><head><title>t</title></head><body>"
            "<p>" + ("Контент главной страницы для наполнения текста. " * 6) + "</p>"
            "<a href='/clients'>Клиенты</a>"
            "<a href='//example.com/cases'>Кейсы</a>"
            "<a href='https://other.com/clients'>Чужие клиенты</a>"
            "</body></html>"
        )
        fetched = []

        class _Res:
            def __init__(self, html):
                self.html = html

        async def _fake_fetch(session, url):
            fetched.append(url)
            return _Res(main_html if url == "https://example.com/ru" else "<html><body>sub</body></html>")

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_redis", None):
            asyncio.run(parsers.parse_url_dspy(
                "https://example.com/ru", extract_contacts=False, extract_about=False,
                extract_services=False, deepseek_api_key="x", extract_clients=False))

        # /clients склеен с корнем домена, а не с /ru → /ru/clients.
        self.assertIn("https://example.com/clients", fetched)
        # protocol-relative //example.com/cases → https-схема.
        self.assertIn("https://example.com/cases", fetched)
        # Чужой домен отсечён.
        self.assertNotIn("https://other.com/clients", fetched)


if __name__ == "__main__":
    unittest.main()
