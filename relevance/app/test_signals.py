"""Smoke-tests for signals.py (Wave 1 competitor signals).

Запуск:
    cd relevance && python -m app.test_signals

Никаких сетевых вызовов; используем синтетический HTML, покрывающий все
извлекатели. Смысл: гарантировать, что все 9 сигналов возвращают
ожидаемые типы и значения, а агрегатор корректно медианит/доли считает.
"""

from __future__ import annotations

import sys
import datetime as _dt

from .signals import (
    compute_top_signals_aggregate,
    extract_competitor_signals,
)


def _today_minus(days: int) -> str:
    # ISO 8601 с двоеточием в TZ-offset — это эталонный формат, который
    # принимают и JSON-LD, и наш _parse_date (после _DATE_FORMATS он также
    # успешно дойдёт до date.fromisoformat fallback).
    return (_dt.date.today() - _dt.timedelta(days=days)).strftime("%Y-%m-%dT12:00:00+00:00")


SAMPLE_HTML_A = f"""
<!doctype html>
<html lang="ru">
<head>
    <title>Лучшие гайды по выбору насоса в 2025 году (топ-10)</title>
    <link rel="canonical" href="https://example.ru/guide/nasos">
    <link rel="alternate" hreflang="ru" href="https://example.ru/guide/nasos">
    <meta name="description" content="Подробный гайд по выбору насоса. Лучшие модели, сравнение, советы.">
    <meta property="og:title" content="Лучшие гайды по выбору насоса">
    <meta property="og:description" content="...">
    <meta property="og:image" content="https://example.ru/img.jpg">
    <meta property="og:url" content="https://example.ru/">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="x">
    <meta name="twitter:description" content="x">
    <meta name="twitter:image" content="x">
    <meta name="author" content="Иван Иванов">
    <meta property="article:published_time" content="{_today_minus(400)}">
    <meta property="article:modified_time" content="{_today_minus(30)}">
    <link rel="sitemap" type="application/xml" href="/sitemap.xml">
    <script type="application/ld+json">
    {{
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": "Лучшие гайды по выбору насоса",
      "datePublished": "{_today_minus(400)}",
      "dateModified": "{_today_minus(30)}",
      "author": {{"@type": "Person", "name": "Иван Иванов"}}
    }}
    </script>
    <script type="application/ld+json">
    {{
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": []
    }}
    </script>
    <script>
      ym(123456, "init", {{}});
    </script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=GA-X"></script>
</head>
<body>
    <header><nav><a href="/about">О нас</a></nav></header>
    <main>
        <h1>Лучшие гайды по выбору насоса в 2025 году</h1>
        <p>Это полный обзор лучших гайдов по выбору насоса. Здесь мы рассмотрим
        самые популярные модели и поможем выбрать насос правильно. Этот гайд
        обновлён в 2025 году и содержит актуальные рекомендации для покупателей.</p>

        <div class="toc"><a href="#types">Типы насосов</a></div>

        <h2 id="types">Типы насосов: какие бывают и для чего нужны</h2>
        <p>Существует несколько типов насосов: центробежные, вибрационные,
        винтовые. Каждый тип имеет свои особенности, преимущества и недостатки.</p>

        <h2>Как выбрать насос для дома</h2>
        <p>Чтобы выбрать насос, нужно учесть глубину скважины, требуемый напор
        и расход воды. Подробнее читайте на <a href="https://ru.wikipedia.org/wiki/Насос">Википедии</a>
        и в стандарте <a href="https://gost.ru/portal/gost/">ГОСТ</a>.</p>

        <h3>Расчёт мощности</h3>
        <p>Формула простая: мощность = производительность × напор × коэффициент.</p>

        <figure><img src="/pump.jpg" alt="Центробежный насос для скважины"></figure>
        <table><tr><th>Тип</th><th>Цена</th></tr><tr><td>Центробежный</td><td>10000</td></tr></table>

        <p>Внутренние ссылки: <a href="/catalog">каталог</a>, <a href="/contacts">контакты</a>,
        и <a href="/guide/nasos-2">подробнее о выборе насоса</a>.</p>

        <h2>Часто задаваемые вопросы</h2>
        <p>...</p>
        <p>Заключение: выбор насоса — ответственное решение.</p>
    </main>
    <footer>© 2025</footer>
</body>
</html>
"""

SAMPLE_HTML_B = f"""
<!doctype html>
<html><head>
<title>Насосы — каталог</title>
<meta property="article:modified_time" content="{_today_minus(700)}">
<script type="application/ld+json">
{{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}}
</script>
</head><body>
<h1>Насосы</h1>
<p>Короткий текст без структуры.</p>
<a href="/cat">тут</a>
</body></html>
"""

SAMPLE_HTML_C = "<html><head><title>Empty</title></head><body></body></html>"


def _assert(cond, msg):
    if not cond:
        print(f"  ❌ {msg}")
        return 1
    print(f"  ✓ {msg}")
    return 0


def main() -> int:
    failures = 0
    print("\n=== Test 1: extract_competitor_signals on rich HTML ===")
    sig = extract_competitor_signals(SAMPLE_HTML_A, "https://example.ru/guide/nasos-2025/", "выбор насоса")
    failures += _assert(sig.get("empty_reason") is None, "no empty_reason")
    tm = sig["title_meta"]
    failures += _assert("Лучшие" in tm["title"], "title parsed")
    failures += _assert(tm["title_has_year"] is True, "title_has_year detected")
    failures += _assert(tm["title_has_number"] is True, "title_has_number detected")
    failures += _assert(tm["title_has_parens"] is True, "title_has_parens detected")
    failures += _assert(len(tm["title_modifiers"]) >= 2, f"title_modifiers found ({tm['title_modifiers']})")
    failures += _assert(tm["title_chars"] > 0 and tm["title_pixels_est"] > 0, "title length/px")
    failures += _assert(tm["h1"].startswith("Лучшие"), "h1 parsed")
    failures += _assert(tm["title_query_token_coverage_pct"] >= 50.0,
                       f"title query coverage ≥50% ({tm['title_query_token_coverage_pct']})")

    types = {t["type"] for t in sig["schema_types"]}
    failures += _assert("Article" in types and "FAQPage" in types, f"schema types {types}")

    fr = sig["freshness"]
    failures += _assert(fr["age_modified_days"] is not None and fr["age_modified_days"] <= 35,
                       f"modified ~30 days ago ({fr['age_modified_days']})")
    failures += _assert(fr["is_fresh_90"] is True, "is_fresh_90")
    failures += _assert(fr["is_fresh_180"] is True, "is_fresh_180")

    uf = sig["url_factors"]
    failures += _assert(uf["depth_slashes"] == 2, f"depth_slashes=2 got {uf['depth_slashes']}")
    failures += _assert(uf["has_year"] is True, "url has_year")
    # Query tokens are Cyrillic ("выбор", "насоса"); slug uses translit ("nasos-2025"),
    # so slug_query_token_hits is expected = 0 — the signal is literal by design,
    # transliteration matching is Wave 2 (NER/normalization).
    failures += _assert(uf["slug_query_token_hits"] == 0,
                       f"translit slug — query token hits = 0 ({uf['slug_query_token_hits']})")

    tl = sig["trust_links"]
    failures += _assert(tl["trust_links"] >= 2, f"trust_links≥2 got {tl['trust_links']}")
    failures += _assert(tl["external_links"] >= 2, "external_links found")

    ab = sig["anchor_bank"]
    failures += _assert(ab["count"] >= 3, f"anchors collected: {ab['count']}")
    failures += _assert("generic" in ab["classes"], "anchor classes built")

    ux = sig["ux_profile"]
    failures += _assert(ux["h2_count"] >= 3, f"h2_count {ux['h2_count']}")
    failures += _assert(ux["paragraph_count"] >= 4, "paragraphs found")
    failures += _assert(ux["above_the_fold_chars"] > 0, "above-the-fold")
    failures += _assert(ux["has_toc"] is True, "TOC detected")
    failures += _assert(ux["has_faq_early"] is True, "FAQ detected")
    failures += _assert(ux["first_image_alt_chars"] > 0, "first image alt parsed")

    eo = sig["exact_occurrences"]
    failures += _assert(eo["total"] >= 1, f"query exact occurrences {eo['total']}")

    hh = sig["host_hygiene"]
    failures += _assert(hh["has_canonical"] is True, "canonical")
    failures += _assert(hh["has_hreflang"] is True, "hreflang")
    failures += _assert(hh["has_open_graph"] is True, "OG")
    failures += _assert(hh["has_twitter_cards"] is True, "Twitter Cards")
    failures += _assert(hh["has_sitemap_link"] is True, "sitemap link")
    failures += _assert(hh["has_yandex_metrika"] is True, "Yandex Metrika")
    failures += _assert(hh["has_google_analytics"] is True, "Google Analytics")
    failures += _assert(hh["has_author_signal"] is True, "author signal")

    failures += _assert(sig["effort_score"] > 10.0, f"effort_score positive: {sig['effort_score']}")

    print("\n=== Test 2: empty html / minimal html ===")
    sig_empty = extract_competitor_signals("", "", "")
    failures += _assert(sig_empty["empty_reason"] == "no_html", "empty_reason set on empty")
    sig_min = extract_competitor_signals(SAMPLE_HTML_C, "https://x.com/", "")
    failures += _assert(sig_min.get("empty_reason") is None, "minimal html parsed")
    failures += _assert(sig_min["ux_profile"]["h2_count"] == 0, "no h2 in minimal html")

    print("\n=== Test 3: aggregate over 3 docs ===")
    docs = [
        extract_competitor_signals(SAMPLE_HTML_A, "https://a.ru/p/nasos-2025/", "выбор насоса"),
        extract_competitor_signals(SAMPLE_HTML_B, "https://b.ru/cat", "выбор насоса"),
        extract_competitor_signals(SAMPLE_HTML_A, "https://c.ru/g/nasos/", "выбор насоса"),
    ]
    agg = compute_top_signals_aggregate(docs, "выбор насоса")
    failures += _assert(agg["doc_count"] == 3, f"doc_count=3 got {agg['doc_count']}")
    ta = agg["top_aggregate"]
    failures += _assert("title_template" in ta, "title_template present")
    failures += _assert("schema_profile" in ta, "schema_profile present")
    failures += _assert("FAQPage" in (ta["schema_profile"]["mandatory"] or []),
                       f"FAQPage mandatory (≥50%) got mandatory={ta['schema_profile']['mandatory']}")
    failures += _assert(ta["freshness_profile"]["median_age_modified_days"] is not None,
                       "freshness median computed")
    failures += _assert(ta["ux_profile"]["share_with_toc_pct"] > 0, "ToC share computed")
    failures += _assert(ta["slug_pattern"]["depth_slashes_median"] is not None, "slug median")
    failures += _assert(ta["trust_link_quota"]["trust_links_median"] is not None, "trust median")
    failures += _assert(len(ta["anchor_bank"]["top_anchors"]) > 0, "anchor bank built")
    failures += _assert(ta["exact_query_position_targets"]["total_median"] is not None,
                       "exact target median")
    failures += _assert(ta["host_hygiene_checklist"]["score_target"] >= 0,
                       "host hygiene score")

    alg = agg["algorithm_signals"]
    failures += _assert("google" in alg and "yandex" in alg, "algorithm_signals split")
    failures += _assert("title_match_quality" in alg["google"], "google: title_match_quality")
    failures += _assert("exact_form_density" in alg["yandex"], "yandex: exact_form_density")

    print("\n=== Test 4: empty per_url list ===")
    agg0 = compute_top_signals_aggregate([], "x")
    failures += _assert(agg0["doc_count"] == 0, "empty agg ok")
    failures += _assert(agg0["top_aggregate"] == {}, "empty top_aggregate")

    print("\n=== Summary ===")
    if failures:
        print(f"  ❌ {failures} assertion(s) failed")
        return 1
    print("  ✅ All signals smoke-tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
