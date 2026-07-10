"""Тесты чистых функций аудита: issues.py + page_parser.py.

Запуск: python -m pytest app/test_audit.py  (или python -m unittest)
"""

import unittest

from . import issues, page_parser


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
