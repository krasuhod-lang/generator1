"""Tests for parsing-completeness upgrades (§2 плана усиления «Релевантность»):

* JSON-LD content extraction (description / FAQ answers / offers / howto)
  как отдельная зона `jsonld` — в основной корпус не входит;
* SPA-state fallback (`__NEXT_DATA__` / `window.__INITIAL_STATE__`);
* closed `<details>` → hidden с причиной `details_collapsed`;
* «partial»-валидация (большой HTML, крошечный текст).
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.parser import (  # noqa: E402
    extract_jsonld_text,
    extract_spa_state_blocks,
    extract_with_diagnostics,
)


PASSED = 0
FAILED = 0


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print(f"  ✓ {name}")
    else:
        FAILED += 1
        print(f"  ✗ {name} {detail}")


# ── JSON-LD ───────────────────────────────────────────────────────────────────

def test_jsonld_faq():
    html = (
        '<html><body><main><p>Основной текст страницы про ремонт квартир,'
        ' достаточно длинный для парсера и корпуса.</p></main>'
        '<script type="application/ld+json">'
        + json.dumps({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [{
                "@type": "Question",
                "name": "Сколько стоит ремонт квартиры?",
                "acceptedAnswer": {"@type": "Answer",
                                   "text": "Стоимость ремонта от 5000 руб за метр."},
            }],
        }, ensure_ascii=False)
        + '</script></body></html>'
    )
    pr = extract_with_diagnostics(html)
    check("jsonld: вопрос FAQ извлечён", "Сколько стоит ремонт" in pr.jsonld_text)
    check("jsonld: ответ FAQ извлечён", "5000 руб" in pr.jsonld_text)
    check("jsonld_chars в диагностике", pr.diagnostics.jsonld_chars > 0)
    check("jsonld: НЕ в основном корпусе", "Сколько стоит ремонт" not in pr.text)
    if pr.zoned_blocks is not None:
        check("jsonld: зона в zoned_blocks",
              any(zb["zone"] == "jsonld" for zb in pr.zoned_blocks))


def test_jsonld_product_offer():
    txt = extract_jsonld_text(
        '<script type="application/ld+json">'
        + json.dumps({
            "@type": "Product",
            "name": "Кондиционер БК-2300",
            "description": "Мощный кондиционер для комнаты до 25 метров.",
            "brand": {"@type": "Organization", "name": "ACME Holdings"},
        }, ensure_ascii=False)
        + '</script>'
    )
    check("jsonld: имя товара извлечено", "Кондиционер БК-2300" in txt)
    check("jsonld: description извлечён", "до 25 метров" in txt)
    check("jsonld: имя организации отфильтровано", "ACME Holdings" not in txt)


def test_jsonld_broken_json():
    check("jsonld: битый JSON не роняет парсер",
          extract_jsonld_text('<script type="application/ld+json">{oops</script>') == "")


# ── SPA state ─────────────────────────────────────────────────────────────────

def test_next_data_fallback():
    state = {"props": {"pageProps": {"article": {
        "body": "Это длинный текст статьи про выбор кондиционера для квартиры летом.",
        "url": "https://example.com/x",
        "slug": "vybor-kondicionera",
    }}}}
    html = (
        '<html><body><div id="root"></div>'
        '<script id="__NEXT_DATA__" type="application/json">'
        + json.dumps(state, ensure_ascii=False) + '</script></body></html>'
    )
    pr = extract_with_diagnostics(html)
    check("__NEXT_DATA__: текст извлечён", "кондиционера" in pr.text)
    check("__NEXT_DATA__: spa_state_chars > 0", pr.diagnostics.spa_state_chars > 0)
    check("__NEXT_DATA__: url/slug отфильтрованы",
          "example.com" not in pr.text and "vybor-kondicionera" not in pr.text)
    check("__NEXT_DATA__: empty_reason снят", pr.diagnostics.empty_reason is None)
    check("__NEXT_DATA__: method помечен spa_state",
          "spa_state" in pr.diagnostics.method)


def test_initial_state_fallback():
    html = (
        '<html><body><div id="app"></div><script>'
        'window.__INITIAL_STATE__ = {"page":{"text":'
        '"Полное описание услуги по установке пластиковых окон в частном доме."}};'
        'somethingElse();</script></body></html>'
    )
    pr = extract_with_diagnostics(html)
    check("__INITIAL_STATE__: текст извлечён", "пластиковых окон" in pr.text)


def test_spa_state_not_used_when_dom_rich():
    body = "".join(
        f"<p>Абзац номер {i} с содержательным текстом про услуги и цены компании.</p>"
        for i in range(30)
    )
    html = (
        f'<html><body><main>{body}</main>'
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props":{"junk":"Технический сервисный текст который не должен попасть в корпус."}}'
        '</script></body></html>'
    )
    pr = extract_with_diagnostics(html)
    check("rich DOM: state-блоб не подмешан", "Технический сервисный" not in pr.text)


def test_spa_state_blocks_direct():
    blocks = extract_spa_state_blocks(
        '<script>window.__NUXT__ = {"data":[{"description":'
        '"Описание из NUXT-состояния достаточно длинное для попадания в блоки."}]};</script>'
    )
    check("__NUXT__: блок извлечён", any("NUXT-состояния" in b for b in blocks))


# ── details / hidden ──────────────────────────────────────────────────────────

def test_details_collapsed_hidden():
    html = (
        '<html><body><main>'
        '<p>Видимый текст основного контента страницы, достаточно длинный.</p>'
        '<details><summary>Подробнее об услуге</summary>'
        '<p>Скрытый SEO текст внутри аккордеона details.</p></details>'
        '</main></body></html>'
    )
    pr = extract_with_diagnostics(html)
    if pr.zoned_blocks is None:
        print("  (full-DOM mode выключен — details-тесты пропущены)")
        return
    check("details: контент скрыт из корпуса", "Скрытый SEO" not in pr.text)
    check("details: summary остаётся видимым", "Подробнее об услуге" in pr.text)
    check("details: hidden_reason=details_collapsed",
          pr.diagnostics.hidden_reasons.get("details_collapsed", 0) > 0)
    check("details: блок в zoned_blocks с пометкой hidden",
          any(zb["is_hidden"] and zb["hidden_reason"] == "details_collapsed"
              for zb in pr.zoned_blocks))


def test_details_open_visible():
    html = (
        '<html><body><main>'
        '<p>Видимый текст основного контента страницы, достаточно длинный.</p>'
        '<details open><summary>Подробнее</summary>'
        '<p>Открытый текст внутри развёрнутого аккордеона details.</p></details>'
        '</main></body></html>'
    )
    pr = extract_with_diagnostics(html)
    check("details[open]: контент видим", "развёрнутого аккордеона" in pr.text)


# ── partial validation ────────────────────────────────────────────────────────

def test_partial_flag():
    html = ('<html><body>' + '<div class="wrap">' * 5000
            + '<p>Мало текста тут.</p>' + '</div>' * 5000 + '</body></html>')
    pr = extract_with_diagnostics(html)
    check("partial: помечен", pr.diagnostics.is_partial)
    check("partial: причина заполнена", bool(pr.diagnostics.partial_reason))


def test_partial_not_flagged_on_normal_page():
    body = "".join(
        f"<p>Абзац номер {i} с содержательным текстом про услуги и цены компании.</p>"
        for i in range(100)
    )
    pr = extract_with_diagnostics(f"<html><body><main>{body}</main></body></html>")
    check("partial: обычная страница не помечена", not pr.diagnostics.is_partial)


if __name__ == "__main__":
    for fn in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        print(f"\n{fn.__name__}:")
        fn()
    print(f"\n{'='*50}\npassed={PASSED} failed={FAILED}")
    sys.exit(1 if FAILED else 0)
