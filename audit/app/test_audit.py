"""Тесты чистых функций аудита: issues.py + page_parser.py.

Запуск: python -m pytest app/test_audit.py  (или python -m unittest)
"""

import unittest

from . import issues, page_parser
from .urls import normalize_url


async def _allow_robots(*_args, **_kwargs):
    return True, None


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


class TestAccessDetection(unittest.TestCase):
    def test_short_valid_html_is_not_blocked(self):
        from .fetcher import looks_blocked
        html = "<html><head><title>Контакты</title></head><body><p>Телефон: +7 000 000-00-00</p></body></html>"
        self.assertFalse(looks_blocked(html, 200))

    def test_cloudflare_library_marker_alone_is_not_blocked(self):
        from .fetcher import looks_blocked
        html = "<html><body><h1>Наша компания</h1><script src=\"/cloudflare.js\"></script></body></html>"
        self.assertFalse(looks_blocked(html, 200))

    def test_captcha_word_in_normal_article_is_not_blocked(self):
        from .fetcher import looks_blocked
        html = "<html><body><h1>Безопасность</h1><p>Мы рассказываем, что такое CAPTCHA и как её использовать в формах.</p></body></html>"
        self.assertFalse(looks_blocked(html, 200))

    def test_captcha_challenge_is_blocked(self):
        from .fetcher import looks_blocked, challenge_fingerprint
        html = "<html><head><title>Checking your browser</title></head><body><div class=\"cf-challenge\">Please verify you are human</div></body></html>"
        self.assertTrue(looks_blocked(html, 200))
        self.assertIn("cf-challenge", challenge_fingerprint(html, 200)["strong_markers"])


class TestClientCoverage(unittest.TestCase):
    def test_python_repr_client_segments_are_readable(self):
        from . import parsers
        value = "[{'segment': 'Поставщики', 'service': 'Тендерное сопровождение'}, {'segment': 'Заказчики', 'service': 'Закупки'}]"
        self.assertEqual(parsers._coerce_to_list(value), [
            'Поставщики — Тендерное сопровождение',
            'Заказчики — Закупки',
        ])

    def test_partial_evidence_coverage_is_not_marked_found(self):
        from . import parsers
        result = {
            'client_segments': ['Поставщики — тендеры', 'Заказчики — закупки'],
            'works_with': 'B2B: поставщики и заказчики',
            'evidence': [],
            'field_status': {},
        }
        evidence = [{
            'field': 'client_segments',
            'url': 'https://example.com/',
            'quote': 'Мы работаем с поставщиками и помогаем участвовать в тендерах.',
            'evidence_type': 'body_text',
        }]
        parsers._finalize_client_fields(result, extract_clients=True, audience_evidence=evidence)
        self.assertEqual(result['field_status']['client_segments'], 'partial')
        self.assertEqual(result['evidence_coverage']['verified_segments'], 1)
        self.assertEqual(result['evidence_coverage']['total_segments'], 2)

    def test_title_only_evidence_has_lower_confidence(self):
        from . import parsers
        evidence = parsers._extract_audience_evidence([{
            'url': 'https://example.com/',
            'text': 'Участие в тендерах для поставщиков',
            'html': '<html><head><title>Участие в тендерах для поставщиков</title></head><body></body></html>',
        }])
        self.assertEqual(evidence[0]['evidence_type'], 'title_only')
        self.assertLess(evidence[0]['confidence'], 0.8)


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

    def test_empty_headings_are_not_counted(self):
        self.assertNotIn("multiple_h1", self.codes(_page(h1=[{"text": ""}, {"text": "Главный заголовок"}])))

    def test_low_ratio_requires_meaningful_content(self):
        self.assertNotIn("low_text_ratio", self.codes(_page(
            text_html_ratio=0.01, clean_text_len=80, content_size_bytes=200000)))
        self.assertIn("low_text_ratio", self.codes(_page(
            text_html_ratio=0.01, clean_text_len=500, content_size_bytes=200000)))

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
        self.assertIn("low_text_ratio", self.codes(_page(
            text_html_ratio=0.05, clean_text_len=500, content_size_bytes=200000)))

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

    def test_orphan_is_not_claimed_when_crawl_is_incomplete(self):
        p = _page(url="https://e.com/a")
        iss = issues.site_issues(
            {"https://e.com/a": p},
            {"https://e.com/a", "https://e.com/not-yet-crawled"},
            orphan_check_complete=False,
        )
        self.assertNotIn("orphan_page", {i["code"] for i in iss})

    def test_canonical_conflict(self):
        p = _page(url="https://e.com/a")
        p["indexability"]["canonical"] = "https://other.com/page"
        iss = issues.site_issues({"https://e.com/a": p}, set())
        self.assertIn("canonical_conflict", {i["code"] for i in iss})

    def test_summarize_health_score_uses_unique_pages_and_keeps_occurrences(self):
        iss = ([{"code": "5xx_error", "severity": "critical", "page_url": "https://e.com/a"}] * 5
               + [{"code": "missing_h1", "severity": "high", "page_url": "https://e.com/b"}] * 3
               + [{"code": "missing_description", "severity": "medium", "page_url": "https://e.com/c"}] * 4
               + [{"code": "title_too_short", "severity": "low", "page_url": "https://e.com/d"}] * 10)
        s = issues.summarize(iss, 100)
        # Штраф: (10 + 5 + 2 + 0.5) / 100 * 100 = 17.5 → 82.
        self.assertEqual(s["health_score"], 82)
        self.assertEqual(s["issues_critical"], 1)
        self.assertEqual(s["total_affected_pages"], 4)
        self.assertEqual(s["total_issue_occurrences"], 22)
        self.assertEqual(s["issue_groups"][0]["affected_pages"], 1)
        self.assertEqual(s["issue_groups"][0]["occurrences"], 5)

    def test_health_score_floor_zero(self):
        s = issues.summarize([
            {"code": "5xx_error", "severity": "critical", "page_url": f"https://e.com/{i}"}
            for i in range(50)
        ], 10)
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


class TestAiResponseNormalizer(unittest.TestCase):
    def test_dict_response(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({
            "contacts": "8 800",
            "about": "Компания",
            "services": ["SEO"],
            "focus": "Маркетинг",
            "client_segments": ["стоматологии — SEO"],
            "works_with": "B2B: медицина",
        })
        self.assertEqual(out["source_type"], "json")
        self.assertEqual(out["parse_status"], "ok")
        self.assertEqual(out["fields"]["contacts_summary"], "8 800")
        self.assertEqual(out["fields"]["services_list"], ["SEO"])

    def test_json_string_response(self):
        import json
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response(json.dumps({
            "about_summary": "Агентство",
            "client_segments": ["клиники — лидогенерация"],
            "works_with": "B2B: клиники",
        }, ensure_ascii=False))
        self.assertEqual(out["source_type"], "json")
        self.assertEqual(out["parse_status"], "partial")
        self.assertEqual(out["fields"]["about_summary"], "Агентство")

    def test_double_serialized_json_response(self):
        import json
        from .ai_response_normalizer import normalize_llm_response

        inner = json.dumps({"services_list": ["SEO"], "works_with": "B2B"}, ensure_ascii=False)
        out = normalize_llm_response(json.dumps(inner, ensure_ascii=False))
        self.assertEqual(out["fields"]["services_list"], ["SEO"])
        self.assertEqual(out["fields"]["works_with"], "B2B")

    def test_fenced_json_response(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response('```json\n{"main_focus":"SEO","services_list":["аудит"]}\n```')
        self.assertEqual(out["fields"]["main_focus"], "SEO")
        self.assertEqual(out["fields"]["services_list"], ["аудит"])

    def test_openai_choices_response(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({
            "choices": [{"message": {"content": '{"about_summary":"О компании"}'}}],
        })
        self.assertEqual(out["source_type"], "openai_response")
        self.assertEqual(out["fields"]["about_summary"], "О компании")

    def test_dspy_prediction_attrs(self):
        from .ai_response_normalizer import normalize_llm_response

        class Prediction:
            contacts_summary = ""
            about_summary = "Описание"
            services_list = '["SEO", "PPC"]'
            main_focus = "Продвижение"
            client_segments = "стоматологии — SEO\nмедцентры — PPC"
            works_with = "B2B: медицина"

        out = normalize_llm_response(Prediction())
        self.assertEqual(out["source_type"], "dspy_prediction")
        self.assertEqual(out["fields"]["services_list"], ["SEO", "PPC"])
        self.assertEqual(out["fields"]["client_segments"], ["стоматологии — SEO", "медцентры — PPC"])

    def test_dspy_structured_result_string(self):
        from .ai_response_normalizer import normalize_llm_response

        raw = '{"about_summary":"Агентство","services_list":["SEO"],"client_segments":["клиники — SEO"],"works_with":"B2B: клиники"}'
        out = normalize_llm_response({"structured_result": raw})
        self.assertEqual(out["source_type"], "json")
        self.assertEqual(out["fields"]["services_list"], ["SEO"])
        self.assertEqual(out["fields"]["works_with"], "B2B: клиники")

    def test_dspy_structured_result_prediction_attribute(self):
        from .ai_response_normalizer import normalize_llm_response

        class Prediction:
            structured_result = '{"client_segments":["заводы — оборудование"],"works_with":"B2B: производство"}'

        out = normalize_llm_response(Prediction())
        self.assertEqual(out["source_type"], "dspy_prediction")
        self.assertEqual(out["fields"]["client_segments"], ["заводы — оборудование"])

    def test_string_mapping_never_calls_items(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({"structured_result": "Не удалось определить"})
        self.assertEqual(out["parse_status"], "invalid")
        self.assertEqual(out["fields"], {})

    def test_lm_history_outputs_string(self):
        import json
        from .ai_response_normalizer import normalize_lm_history

        raw = json.dumps({"about_summary": "Из history", "works_with": "B2B"}, ensure_ascii=False)

        class LM:
            history = [{"outputs": raw}]

        out = normalize_lm_history(LM())
        self.assertEqual(out["source_type"], "history")
        self.assertEqual(out["fields"]["about_summary"], "Из history")

    def test_raw_json_repair_normalizes_provider_list_response(self):
        from . import parsers

        class LM:
            def __call__(self, **_kwargs):
                return ['{"about_summary":"Компания","works_with":"B2B: подрядчики",'
                        '"client_segments":["подрядчики — сопровождение"]}']

        fields = parsers._run_raw_json_repair(LM(), "Факты сайта")
        self.assertEqual(fields["about_summary"], "Компания")
        self.assertEqual(fields["client_segments"], ["подрядчики — сопровождение"])

    def test_latest_lm_fields_recovers_structured_result_wrapper(self):
        import json
        from . import parsers

        nested = json.dumps({
            "about_summary": "Тендерное сопровождение",
            "services_list": ["сопровождение закупок"],
            "client_segments": ["компании — участие в закупках"],
            "works_with": "B2B: коммерческие компании",
        }, ensure_ascii=False)
        raw = json.dumps({"structured_result": nested}, ensure_ascii=False)

        class LM:
            history = [{"outputs": [raw]}]

        fields = parsers._latest_lm_fields(LM())
        self.assertEqual(fields["services_list"], ["сопровождение закупок"])
        self.assertEqual(fields["works_with"], "B2B: коммерческие компании")

    def test_labeled_text_ru(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response("""
        О компании: Производитель оборудования
        Список услуг:
        - проектирование
        - монтаж
        Категории клиентов: заводы — оборудование
        С кем работает: B2B: промышленные предприятия
        """)
        self.assertEqual(out["source_type"], "labeled_text")
        self.assertEqual(out["fields"]["services_list"], ["проектирование", "монтаж"])
        self.assertEqual(out["fields"]["works_with"], "B2B: промышленные предприятия")

    def test_client_segment_dicts_become_readable_segments(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({
            "client_segments": [
                {"segment": "Поставщики", "service": "тендерное сопровождение"},
                {"category": "Заказчики", "solution": "создание тендеров"},
            ],
        })
        self.assertEqual(
            out["fields"]["client_segments"],
            ["Поставщики — тендерное сопровождение", "Заказчики — создание тендеров"],
        )
        self.assertFalse(any("dict item converted" in warning for warning in out["warnings"]))

    def test_client_segments_shapes(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({
            "client_segments": ("стоматологии — SEO", "", {"segment": "клиники"}),
            "works_with": None,
        })
        self.assertIn("стоматологии — SEO", out["fields"]["client_segments"])
        self.assertIn("клиники", out["fields"]["client_segments"])
        self.assertFalse(any("dict item converted" in w for w in out["warnings"]))
        self.assertEqual(out["fields"]["works_with"], "")

    def test_unknown_type_no_items_error(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response(42)
        self.assertEqual(out["parse_status"], "invalid")
        self.assertIn("unsupported scalar", " ".join(out["warnings"]))

    def test_corrupted_response_is_invalid(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response("{not json")
        self.assertEqual(out["parse_status"], "invalid")
        self.assertEqual(out["fields"], {})

    def test_deduplicates_and_drops_empty_items(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({"services_list": [" SEO ", "", "seo", "PPC"]})
        self.assertEqual(out["fields"]["services_list"], ["SEO", "PPC"])

    def test_partial_response_status(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({"about_summary": "Только описание"})
        self.assertEqual(out["parse_status"], "partial")
        self.assertEqual(out["fields"]["about_summary"], "Только описание")

    def test_sentinel_values_are_preserved_as_text(self):
        from .ai_response_normalizer import normalize_llm_response

        msg = "Не определено — на сайте нет явных данных о категориях клиентов"
        out = normalize_llm_response({"client_segments": [msg], "works_with": msg})
        self.assertEqual(out["fields"]["client_segments"], [msg])
        self.assertEqual(out["fields"]["works_with"], msg)

    def test_brand_only_segment_is_dropped(self):
        from .ai_response_normalizer import normalize_llm_response

        out = normalize_llm_response({"client_segments": ["REHAU", "оконные компании — поставки"]})
        self.assertEqual(out["fields"]["client_segments"], ["оконные компании — поставки"])
        self.assertTrue(any("dropped non-category" in w for w in out["warnings"]))


class TestParsersClientSegmentation(unittest.TestCase):
    """Client segmentation: новые поля client_segments/works_with и расширенный краул."""

    def test_signature_has_direct_structured_contract(self):
        from . import parsers
        fields = parsers.ExtractCompanyServicesDirect.output_fields
        for name in ('contacts_summary', 'about_summary', 'services_list', 'main_focus', 'client_segments', 'works_with'):
            self.assertIn(name, fields)
        self.assertNotIn('structured_result', fields)
        instructions = parsers.ExtractCompanyServicesDirect.__doc__
        self.assertIn('client_segments', instructions)
        self.assertIn('works_with', instructions)

    def test_link_patterns_include_client_pages(self):
        from . import parsers
        for p in ("/clients", "/клиенты", "/cases", "/кейсы", "/portfolio",
                  "/projects", "/partners", "/reviews", "/отзывы"):
            self.assertIn(p, parsers.LINK_PATTERNS)

    def test_subpage_cap_is_constant(self):
        from . import parsers
        self.assertIsInstance(parsers.MAX_SUBPAGES, int)
        self.assertGreaterEqual(parsers.MAX_SUBPAGES, 5)

    def test_sitemap_discovery_returns_relevant_same_domain_links(self):
        import asyncio
        from unittest import mock
        from . import parsers

        sitemap_xml = """<?xml version="1.0"?><urlset>
              <url><loc>https://example.com/clients</loc></url>
              <url><loc>https://example.com/tenders</loc></url>
              <url><loc>https://other.example.org/secret</loc></url>
            </urlset>"""

        class _Response:
            status = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def text(self, **_kwargs):
                return sitemap_xml

        class _Session:
            def get(self, *_args, **_kwargs):
                return _Response()

        async def _allow(*_args, **_kwargs):
            return True, None

        with mock.patch.object(parsers, "_robots_allowed", _allow):
            out = asyncio.run(parsers._discover_sitemap_links(
                _Session(), "https://example.com/", "example.com"))

        urls = [url for url, _score in out]
        self.assertIn("https://example.com/clients", urls)
        self.assertIn("https://example.com/tenders", urls)
        self.assertNotIn("https://other.example.org/secret", urls)

    def test_empty_content_yields_fetch_error_sentinel_segments(self):
        # При пустом контенте LLM не вызывается, а клиентские поля получают
        # понятный fetch_error fallback вместо пустых значений.
        import asyncio
        from unittest import mock
        from . import parsers

        class _Res:
            html = ""

        async def _fake_fetch(session, url):
            return _Res()

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
             mock.patch.object(parsers, "_redis", None):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=True, extract_about=True,
                extract_services=True, deepseek_api_key="x", extract_clients=True))

        self.assertEqual(out["client_segments"], ["Не определено — сайт недоступен или не удалось получить его содержимое"])
        self.assertEqual(out["works_with"], "Не определено — анализ невозможен из-за ошибки доступа к сайту")
        self.assertEqual(out["field_status"]["client_segments"], "fetch_error")
        self.assertEqual(out["field_status"]["works_with"], "fetch_error")
        self.assertEqual(out["status"], "fetch_error")

    def test_blocked_fetch_is_explicit_and_does_not_call_llm(self):
        import asyncio
        from unittest import mock
        from . import parsers

        class _Blocked:
            html = '<html><title>captcha</title><body>checking your browser</body></html>'
            fetch_status = 'blocked'
            error = 'captcha_or_antibot'
            status_code = 403
            method = 'aiohttp'
            final_url = 'https://example.com/'

        async def _fake_fetch(_session, _url):
            return _Blocked()

        with mock.patch.object(parsers, 'fetch_page', _fake_fetch), \
             mock.patch.object(parsers, '_robots_allowed', _allow_robots), \
             mock.patch.object(parsers, '_redis', None), \
             mock.patch.object(parsers.dspy, 'LM', side_effect=AssertionError('LLM must not run for blocked site')):
            out = asyncio.run(parsers.parse_url_dspy(
                'https://example.com/', extract_contacts=True, extract_about=False,
                extract_services=False, deepseek_api_key='x', extract_clients=True,
                task_id='run-1', item_id='item-1'))

        self.assertEqual(out['status'], 'blocked')
        self.assertEqual(out['error_code'], 'captcha_or_antibot')
        self.assertEqual(out['execution']['run_id'], 'run-1')
        self.assertEqual(out['execution']['item_id'], 'item-1')
        self.assertEqual(out['field_status']['client_segments'], 'blocked')
        self.assertIn('заблокирован', out['client_segments'][0].lower())

    def test_robots_disallow_is_explicit_and_fresh(self):
        import asyncio
        from unittest import mock
        from . import parsers

        async def _must_not_fetch(_session, _url):
            raise AssertionError('page fetch must not run after robots disallow')

        async def _deny_robots(*_args, **_kwargs):
            return False, 'robots_disallow'

        with mock.patch.object(parsers, 'fetch_page', _must_not_fetch), \
             mock.patch.object(parsers, '_robots_allowed', _deny_robots), \
             mock.patch.object(parsers, '_redis', None):
            out = asyncio.run(parsers.parse_url_dspy(
                'https://example.com/', extract_contacts=False, extract_about=False,
                extract_services=False, deepseek_api_key='x', extract_clients=True,
                task_id='run-2', item_id='item-2'))

        self.assertEqual(out['status'], 'blocked')
        self.assertEqual(out['error_code'], 'robots_disallow')
        self.assertEqual(out['execution']['result_source'], 'fresh')

    def test_cache_is_opt_in_and_not_read_for_new_run(self):
        import asyncio
        from unittest import mock
        from . import parsers

        calls = []
        class _Redis:
            async def get(self, _key):
                calls.append('get')
                return b'{"status":"llm_error"}'
            async def set(self, *_args, **_kwargs):
                calls.append('set')

        class _Res:
            html = '<html><head><title>Fresh</title></head><body>' + ('Company services. ' * 30) + '</body></html>'
            fetch_status = 'ok'
            error = None
            status_code = 200
            method = 'aiohttp'
            final_url = 'https://example.com/'

        async def _fake_fetch(_session, _url):
            return _Res()

        with mock.patch.object(parsers, 'fetch_page', _fake_fetch), \
             mock.patch.object(parsers, '_robots_allowed', _allow_robots), \
             mock.patch.object(parsers, '_redis', _Redis()), \
             mock.patch.object(parsers, 'PARSER_CACHE_ENABLED', False), \
             mock.patch.object(parsers.dspy, 'LM', side_effect=AssertionError('LLM should not be called without requested fields')):
            out = asyncio.run(parsers.parse_url_dspy(
                'https://example.com/', extract_contacts=False, extract_about=False,
                extract_services=False, deepseek_api_key='x', extract_clients=False,
                task_id='run-3', item_id='item-3'))

        self.assertEqual(calls, [])
        self.assertEqual(out['execution']['result_source'], 'fresh')

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
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers, "DEEPSEEK_API_KEY", "env-deepseek-key"), \
             mock.patch.object(parsers.dspy, "LM", _fake_lm), \
             mock.patch.object(parsers.dspy, "settings", mock.MagicMock()), \
             mock.patch.object(parsers.dspy, "Predict", lambda sig: _Pred()):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=False, extract_about=True,
                extract_services=True, deepseek_api_key="", extract_clients=True))

        self.assertEqual(captured.get("api_key"), "env-deepseek-key")
        self.assertEqual(out["status"], "partial")
        self.assertEqual(out["field_status"]["about"], "found")
        self.assertEqual(out["field_status"]["services"], "found")

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
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers, "DEEPSEEK_API_KEY", ""), \
             mock.patch.object(parsers.dspy, "LM", side_effect=AssertionError("LM should not be called")):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=False, extract_about=True,
                extract_services=True, deepseek_api_key="", extract_clients=True))

        self.assertEqual(out["status"], "partial")
        self.assertEqual(out["ai_status"], "failed")
        self.assertEqual(out["data_status"], "partial")
        self.assertEqual(out["field_status"]["client_segments"], "llm_error")
        self.assertEqual(out["client_segments"], ["Не удалось определить — ошибка анализа ИИ"])

    def test_available_site_without_client_signals_uses_not_found_sentinel(self):
        import asyncio
        from unittest import mock
        from . import parsers

        html = (
            "<html><head><title>Главная</title></head><body>"
            "<p>" + ("Компания оказывает SEO и контекстную рекламу для продвижения сайтов. " * 8) + "</p>"
            "</body></html>"
        )

        class _Res:
            def __init__(self, html):
                self.html = html

        async def _fake_fetch(session, url):
            return _Res(html)

        class _Pred:
            def __call__(self, website_text=""):
                class _Out:
                    contacts_summary = ""
                    about_summary = "Маркетинговое агентство."
                    services_list = '["SEO"]'
                    main_focus = "Продвижение сайтов"
                    client_segments = "[]"
                    works_with = ""
                return _Out()

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers.dspy, "LM", lambda *a, **k: object()), \
             mock.patch.object(parsers.dspy, "settings", mock.MagicMock()), \
             mock.patch.object(parsers.dspy, "Predict", lambda sig: _Pred()):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=False, extract_about=True,
                extract_services=True, deepseek_api_key="x", extract_clients=True))

        self.assertEqual(out["client_segments"], ["Не определено — на сайте нет явных данных о категориях клиентов"])
        self.assertEqual(out["works_with"], "Не определено — на сайте нет явных указаний, с кем работает компания")
        self.assertEqual(out["field_status"]["client_segments"], "not_found")
        self.assertEqual(out["field_status"]["works_with"], "not_found")
        self.assertEqual(out["evidence"], [])
        self.assertEqual(out["status"], "partial")

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
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
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
        self.assertEqual(out["field_status"]["client_segments"], "found")
        self.assertEqual(out["field_status"]["works_with"], "not_found")
        self.assertTrue(out["evidence"])
        self.assertEqual(out["status"], "partial")

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
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers.dspy, "LM", lambda *a, **k: _LM()), \
             mock.patch.object(parsers.dspy, "settings", mock.MagicMock()), \
             mock.patch.object(parsers.dspy, "Predict", lambda sig: _Pred()):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=True, extract_about=True,
                extract_services=True, deepseek_api_key="x", extract_clients=True))

        self.assertEqual(out["status"], "partial")
        self.assertEqual(out["contacts"], "Телефон не найден")
        self.assertEqual(out["about"], "Агентство интернет-маркетинга.")
        self.assertEqual(out["services"], ["SEO", "контекстная реклама"])
        self.assertEqual(out["focus"], "Продвижение сайтов")
        self.assertEqual(out["client_segments"], ["Не определено — на сайте нет явных данных о категориях клиентов"])
        self.assertEqual(out["works_with"], "Не определено — на сайте нет явных указаний, с кем работает компания")
        self.assertEqual(out["field_status"]["client_segments"], "not_found")

    def test_lm_history_outputs_can_be_raw_string(self):
        import json
        from . import parsers

        raw_output = json.dumps({
            "about_summary": "Агентство интернет-маркетинга.",
            "client_segments": ["B2B-компании — SEO"],
            "works_with": "B2B: компании услуг",
        }, ensure_ascii=False)

        class _LM:
            history = [{"outputs": raw_output}]

        fields = parsers._latest_lm_fields(_LM())
        self.assertEqual(fields["about_summary"], "Агентство интернет-маркетинга.")
        self.assertEqual(fields["client_segments"], ["B2B-компании — SEO"])
        self.assertEqual(fields["works_with"], "B2B: компании услуг")

    def test_generic_spider_reaches_second_depth_audience_page(self):
        # Парсер должен вести себя как ограниченный паук: идти не только по
        # client/about/service URL, но и по обычным внутренним страницам.
        import asyncio
        from unittest import mock
        from . import parsers

        main_html = (
            "<html><head><title>Главная</title></head><body>"
            "<p>" + ("Главная страница агентства с описанием услуг. " * 8) + "</p>"
            "<a href='/foo'>Подробнее</a></body></html>"
        )
        foo_html = (
            "<html><head><title>Раздел</title></head><body>"
            "<p>" + ("Промежуточная страница с обзором направлений. " * 8) + "</p>"
            "<a href='/bar'>Следующая страница</a></body></html>"
        )
        bar_html = (
            "<html><head><title>Аудитория</title></head><body>"
            "<p>" + ("Работаем с клиниками и медицинскими центрами: привлекаем пациентов и заявки. " * 8) + "</p>"
            "</body></html>"
        )
        pages = {
            "https://example.com/": main_html,
            "https://example.com/foo": foo_html,
            "https://example.com/bar": bar_html,
        }
        fetched = []

        class _Res:
            def __init__(self, html):
                self.html = html

        async def _fake_fetch(session, url):
            fetched.append(url)
            return _Res(pages.get(url, ""))

        captured = {}

        class _Pred:
            def __call__(self, website_text=""):
                captured["website_text"] = website_text

                class _Out:
                    contacts_summary = ""
                    about_summary = "Агентство для медицинского маркетинга."
                    services_list = '["привлечение пациентов"]'
                    main_focus = "Маркетинг клиник"
                    client_segments = '["клиники и медицинские центры — привлечение пациентов"]'
                    works_with = "B2B: медицинские организации"
                return _Out()

        with mock.patch.object(parsers, "fetch_page", _fake_fetch), \
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
             mock.patch.object(parsers, "_redis", None), \
             mock.patch.object(parsers, "MAX_SUBPAGES", 3), \
             mock.patch.object(parsers, "PARSER_MAX_DEPTH", 2), \
             mock.patch.object(parsers.dspy, "LM", lambda *a, **k: object()), \
             mock.patch.object(parsers.dspy, "settings", mock.MagicMock()), \
             mock.patch.object(parsers.dspy, "Predict", lambda sig: _Pred()):
            out = asyncio.run(parsers.parse_url_dspy(
                "https://example.com/", extract_contacts=False, extract_about=True,
                extract_services=True, deepseek_api_key="x", extract_clients=True))

        self.assertIn("https://example.com/foo", fetched)
        self.assertIn("https://example.com/bar", fetched)
        self.assertIn("медицинскими центрами", captured.get("website_text", ""))
        self.assertEqual(out["client_segments"], ["клиники и медицинские центры — привлечение пациентов"])
        self.assertEqual(out["works_with"], "B2B: медицинские организации")
        self.assertEqual(out["field_status"]["client_segments"], "found")
        self.assertTrue(any(ev["url"] == "https://example.com/bar" for ev in out["evidence"]))

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
             mock.patch.object(parsers, "_robots_allowed", _allow_robots), \
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


class TestParserPartialLifecycle(unittest.TestCase):
    def test_evidence_is_deduplicated_and_supports_multiple_fields(self):
        from . import parsers
        evidence = parsers._client_evidence_for_segments(
            ['Поставщики — тендеры', 'Заказчики — закупки'],
            'B2B: поставщики и заказчики',
            [{
                'field': 'client_segments',
                'url': 'https://example.com/',
                'quote': 'Работаем с поставщиками и заказчиками, сопровождаем тендеры и закупки.',
                'evidence_type': 'body_text',
            }],
        )
        self.assertEqual(len(evidence), 1)
        self.assertEqual(len(evidence[0]['supports_segments']), 2)
        self.assertTrue(evidence[0]['supports_works_with'])

    def test_deterministic_fallback_preserves_crawled_data(self):
        from . import parsers
        result = parsers._base_result('https://example.com/', 'Example')
        result['stats']['pages_scanned'] = 2
        parsers._apply_deterministic_fallback(
            result,
            [{
                'url': 'https://example.com/',
                'text': 'Компания оказывает услуги тендерного сопровождения. Телефон: +7 (900) 123-45-67.',
            }],
            extract_contacts=True,
            extract_about=True,
            extract_services=True,
        )
        self.assertIn('+7 (900) 123-45-67', result['contacts'])
        self.assertTrue(result['about'])
        self.assertTrue(result['services'])
        self.assertEqual(result['data_status'], 'partial')
        self.assertTrue(result['stats']['deterministic_fallback_used'])

    def test_subpage_failure_reasons_are_aggregated(self):
        from . import parsers
        stats = {'subpage_error_counts': {}, 'subpage_errors': []}
        class Res:
            status_code = 403
            fetch_status = 'blocked'
            error = 'forbidden_403'
            method = 'aiohttp'
            final_url = 'https://example.com/private'
        parsers._record_subpage_failure(stats, 'https://example.com/private', Res())
        parsers._record_subpage_failure(stats, 'https://example.com/private-2', Res())
        self.assertEqual(stats['subpage_error_counts']['forbidden_403'], 2)
        self.assertEqual(len(stats['subpage_errors']), 2)


class TestParserContextAndRecovery(unittest.TestCase):
    def test_page_aware_context_keeps_each_source_and_tail(self):
        from . import parsers
        context = parsers._build_llm_context([
            {'url': 'https://example.com/', 'text': 'Главная ' + ('A' * 9000) + ' контакты и услуги'},
            {'url': 'https://example.com/clients', 'text': 'Клиенты: поставщики и заказчики.'},
        ], max_chars=10000)
        self.assertIn('https://example.com/', context)
        self.assertIn('https://example.com/clients', context)
        self.assertIn('[page text truncated]', context)
        self.assertIn('контакты и услуги', context)


class TestProfessionalAuditSignals(unittest.TestCase):
    def test_parse_dom_signals_are_exposed(self):
        html = '''<html><head>
          <title>one</title><title>two</title>
          <meta name="description" content="one"><meta name="description" content="two">
          <link rel="canonical" href="/one"><link rel="canonical" href="/two">
        </head><body><h1>Heading</h1></body></html>'''
        page = page_parser.parse_page("https://example.com/one", html)
        self.assertEqual(page["title_count"], 2)
        self.assertEqual(page["meta_description_count"], 2)
        self.assertEqual(page["canonical_count"], 2)
        self.assertIsNone(page["html_lang"])
        self.assertFalse(page["has_viewport"])
        page.update({"url": "https://example.com/one", "status_code": 200, "response_time_ms": 100,
                     "content_size_bytes": 500, "indexability": page.pop("indexability")})
        page["parsed"] = True
        codes = {item["code"] for item in issues.page_issues(page)}
        self.assertTrue({"multiple_title", "multiple_description", "multiple_canonical",
                         "missing_lang", "missing_viewport"} <= codes)

    def test_non_html_and_parse_failure_are_explicit(self):
        non_html = _page(content_type="application/pdf", parsed=False, parse_status="non_html")
        self.assertIn("non_html_document", {i["code"] for i in issues.page_issues(non_html)})
        failed = _page(parsed=False, parse_status="timeout", error="parse_timeout")
        self.assertIn("parse_failure", {i["code"] for i in issues.page_issues(failed)})

    def test_all_4xx_are_reported(self):
        self.assertIn("4xx_error", {i["code"] for i in issues.page_issues(_page(status_code=403))})
        self.assertIn("4xx_error", {i["code"] for i in issues.page_issues(_page(status_code=410))})

    def test_robots_blocked_is_not_orphan(self):
        pages = {
            "https://e.com/": _page(url="https://e.com/"),
            "https://e.com/blocked": _page(url="https://e.com/blocked", robots_blocked=True,
                                               status_code=None, parsed=False),
        }
        site = issues.site_issues(pages, {"https://e.com/blocked"})
        self.assertNotIn("orphan_page", {item["code"] for item in site})


if __name__ == "__main__":
    unittest.main()
