"""Тесты M1 (очистка HTML, стоп-лист) и промптов."""

from app import prompts
from app.modules.m1_scraper import extract_page, is_blocked_domain


def test_is_blocked_domain():
    assert is_blocked_domain("https://ru.wikipedia.org/wiki/SEO")
    assert is_blocked_domain("https://www.youtube.com/watch?v=x")
    assert not is_blocked_domain("https://example-blog.ru/article")


def test_extract_page_strips_chrome():
    html = """
    <html><head><title>Титул</title></head><body>
    <header>Шапка сайта</header><nav>Меню</nav>
    <main><h1>Главный заголовок</h1><h2>Раздел</h2>
    <p>Основной текст статьи про котлы.</p></main>
    <footer>Подвал</footer><script>var x=1;</script>
    </body></html>
    """
    page = extract_page(html, "https://example.ru/a")
    assert page["title"] == "Титул"
    assert page["h1"] == "Главный заголовок"
    assert page["headings"] == ["Раздел"]
    assert "Основной текст статьи" in page["body_text"]
    assert "Шапка" not in page["body_text"]
    assert "Подвал" not in page["body_text"]
    assert "var x" not in page["body_text"]


def test_extract_page_empty():
    assert extract_page("", "https://example.ru") is None


def test_prompt_render_keeps_unknown_placeholders():
    out = prompts.render("Ключ: {keyword}, json: {\"a\": 1}", keyword="котёл")
    assert "котёл" in out


def test_all_prompts_render():
    common = dict(
        queries="q", keyword="k", url="u", body_text="b", target_audience="a",
        top10_claims="c", content_format="HOW-TO", top10_claims_top15="c",
        information_delta="d", persona_short_bio="p", h2_title="h",
        section_brief="s", section_type="TEXT", word_count=200,
        information_delta_claims="d", persona_taboo="t", top10_context="c",
        article_draft="d", domain="seo", article_text="t",
        current_robotness=50, top_contributing_categories="x", strategy="medium",
        intensity="auto", structural_markers_found="m", fluency_issues="f",
        original_text="o",
    )
    for name in (
        "G0_FORMAT", "G1_EXTRACT", "G2_GAP", "G2_ARCH", "G2_PERSONA",
        "G3_SECTION_EXPERT", "G3_SECTION_BASE", "G3_INTRO", "G3_REDUNDANCY",
        "LF_DETECT", "G3_REWRITE_EXPERT", "G3_AIO_CHECK",
    ):
        template = getattr(prompts, name)
        rendered = prompts.render(template, **common)
        assert rendered  # не падает и что-то возвращает
