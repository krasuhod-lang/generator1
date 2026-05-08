"""Smoke tests for relevance.evidence (Phase 1 / P0-2 grounding).

Запуск:
    cd relevance && python -m app.test_evidence

Без сети, без БД — проверяем чистую функцию extract_evidence_for_document
и хелперы. CI это же запустит командой выше.
"""

from __future__ import annotations

import sys

from .evidence import (
    DEFAULT_MAX_CHARS_PER_URL,
    DEFAULT_TOP_K,
    HARD_TOP_K_LIMIT,
    MAX_PARAGRAPH_CHARS,
    MIN_PARAGRAPH_CHARS,
    _candidate_paragraphs,
    _normalize_query_to_lemmas,
    _split_paragraph,
    extract_evidence_for_document,
)


# ── Sample HTMLs ────────────────────────────────────────────────────────────

SAMPLE_HTML_RELEVANT = """
<html><head><title>Выбор циркуляционного насоса для отопления — гид 2026</title></head>
<body>
<header><nav>Меню магазина · Корзина · О нас</nav></header>
<main>
<article>
  <h1>Как выбрать циркуляционный насос для системы отопления</h1>

  <p>Циркуляционный насос — ключевой элемент отопительной системы.
     От его правильного подбора зависит равномерность нагрева радиаторов
     и расход электроэнергии. В этом гиде разберём подбор насоса для
     частного дома и квартиры — с примерами расчёта производительности.</p>

  <h2>Параметры подбора циркуляционного насоса</h2>
  <p>Главные параметры — производительность (м³/ч) и напор (м водяного
     столба). Производительность подбирают по теплопотерям дома: на 10 кВт
     мощности котла приходится примерно 0.86 м³/ч. Напор — по сумме
     гидравлических сопротивлений контура, обычно 2–6 метров для типового
     коттеджа.</p>

  <h2>Чем энергоэффективные модели отличаются от классических</h2>
  <p>Современные циркуляционные насосы с электронным управлением (модели
     класса A) потребляют в 3–4 раза меньше энергии, чем трёхскоростные
     асинхронные. Срок окупаемости — 2–3 отопительных сезона. Дополнительно
     снижается уровень шума за счёт плавного регулирования оборотов.</p>

  <h2>Установка и обслуживание</h2>
  <p>Насос монтируют на обратной магистрали перед котлом — там температура
     ниже, что продлевает срок службы подшипников. Перед запуском обязательно
     удалите воздух из ротора через сервисный винт. Раз в сезон проверяйте
     отсутствие протечек и шумов.</p>
</article>
</main>
<footer>© 2026 Магазин отопления. Возврат и доставка.</footer>
</body></html>
"""

SAMPLE_HTML_EMPTY = "<html><body><div id='root'></div></body></html>"

SAMPLE_HTML_TINY = """
<html><body><p>Слишком коротко.</p></body></html>
"""


# ── Test runner ─────────────────────────────────────────────────────────────

def _assert(cond, msg):
    if not cond:
        print(f"  ❌ {msg}")
        return 1
    print(f"  ✓ {msg}")
    return 0


def main() -> int:
    failures = 0

    print("\n=== Test 1: _normalize_query_to_lemmas ===")
    lemmas = _normalize_query_to_lemmas("выбор циркуляционного насоса")
    failures += _assert(isinstance(lemmas, list) and lemmas, f"lemmas non-empty ({lemmas})")
    failures += _assert("насос" in lemmas, f"contains lemma 'насос' ({lemmas})")
    failures += _assert("циркуляционный" in lemmas, f"contains lemma 'циркуляционный' ({lemmas})")
    failures += _assert(_normalize_query_to_lemmas("") == [], "empty query → []")
    failures += _assert(_normalize_query_to_lemmas("   ") == [], "whitespace query → []")

    print("\n=== Test 2: _split_paragraph ===")
    short = "Короткий параграф." * 2
    failures += _assert(_split_paragraph(short) == [short], "short paragraph kept as-is")
    long_text = ("Это первое предложение. " * 60).strip()
    parts = _split_paragraph(long_text)
    failures += _assert(len(parts) >= 2, f"long paragraph split into ≥2 ({len(parts)})")
    failures += _assert(all(len(p) <= MAX_PARAGRAPH_CHARS for p in parts),
                        f"all parts ≤ MAX_PARAGRAPH_CHARS ({[len(p) for p in parts]})")
    # Объединение всех кусков должно покрывать исходный текст без потерь смысла
    failures += _assert("первое предложение" in " ".join(parts), "split preserves content")
    failures += _assert(_split_paragraph("") == [], "empty → []")
    failures += _assert(_split_paragraph("   ") == [], "whitespace-only → []")

    print("\n=== Test 3: _candidate_paragraphs filtering ===")
    blocks = [
        "x" * 30,                           # too short — drop
        "Это нормальный параграф длиной более минимума, должен попасть в выдачу. " * 2,
        "x" * 30,                           # too short — drop
        "Это нормальный параграф длиной более минимума, должен попасть в выдачу. " * 2,  # dup
        "Другой контентный кусок. Достаточно длинный для прохождения порога MIN_PARAGRAPH_CHARS.",
    ]
    cand = _candidate_paragraphs(blocks)
    failures += _assert(len(cand) == 2, f"filtered to 2 unique long paragraphs (got {len(cand)})")
    failures += _assert(all(len(c) >= MIN_PARAGRAPH_CHARS for c in cand),
                        f"all candidates ≥ MIN_PARAGRAPH_CHARS")

    print("\n=== Test 4: extract_evidence_for_document on relevant HTML ===")
    query_lemmas = _normalize_query_to_lemmas("выбор циркуляционного насоса")
    ev = extract_evidence_for_document(
        html=SAMPLE_HTML_RELEVANT,
        query_lemmas=query_lemmas,
        top_k=3,
        max_chars=2000,
    )
    failures += _assert(ev["empty_reason"] is None, f"no empty_reason ({ev['empty_reason']})")
    failures += _assert(ev["text_chars"] > 200, f"text_chars > 200 ({ev['text_chars']})")
    failures += _assert(len(ev["snippets"]) >= 1, f"≥1 snippet ({len(ev['snippets'])})")
    failures += _assert(len(ev["snippets"]) <= 3, f"≤ top_k=3 snippets ({len(ev['snippets'])})")
    # Top-сниппет должен содержать целевые термины
    top = ev["snippets"][0]["text"].lower()
    failures += _assert("насос" in top, f"top snippet mentions 'насос' ({top[:80]!r})")
    # Сумма символов уважает квоту
    total_chars = sum(len(s["text"]) for s in ev["snippets"])
    failures += _assert(total_chars <= 2000, f"sum chars within max_chars=2000 ({total_chars})")
    # H1 распарсен
    failures += _assert("насос" in (ev["h1"] or "").lower(), f"h1 parsed ({ev['h1']!r})")
    # Scores отсортированы убыванию
    scores = [s["score"] for s in ev["snippets"]]
    failures += _assert(scores == sorted(scores, reverse=True),
                        f"snippets sorted by score desc ({scores})")
    # Position не дублируется
    positions = [s["position"] for s in ev["snippets"]]
    failures += _assert(len(positions) == len(set(positions)),
                        f"positions unique ({positions})")

    print("\n=== Test 5: extract_evidence_for_document on empty SPA HTML ===")
    ev_empty = extract_evidence_for_document(
        html=SAMPLE_HTML_EMPTY, query_lemmas=query_lemmas, top_k=5, max_chars=1500,
    )
    failures += _assert(ev_empty["snippets"] == [], "empty HTML → no snippets")
    failures += _assert(
        ev_empty["empty_reason"] in ("rendered_by_js", "tiny_html", "noise_only"),
        f"empty_reason categorized ({ev_empty['empty_reason']})",
    )

    print("\n=== Test 6: extract_evidence_for_document with empty query lemmas ===")
    ev_no_q = extract_evidence_for_document(
        html=SAMPLE_HTML_RELEVANT, query_lemmas=[], top_k=2, max_chars=1500,
    )
    # Без запроса берём первые параграфы документа (по позиции)
    failures += _assert(len(ev_no_q["snippets"]) >= 1, f"fallback returns snippets ({len(ev_no_q['snippets'])})")
    failures += _assert(
        ev_no_q["snippets"] == sorted(ev_no_q["snippets"], key=lambda s: s["position"]),
        "fallback ordering = document order",
    )

    print("\n=== Test 7: top_k clamping ===")
    ev_huge = extract_evidence_for_document(
        html=SAMPLE_HTML_RELEVANT, query_lemmas=query_lemmas,
        top_k=HARD_TOP_K_LIMIT * 100,  # клиент попросил безумно много
        max_chars=200_000,
    )
    failures += _assert(len(ev_huge["snippets"]) <= HARD_TOP_K_LIMIT,
                        f"top_k clamped to HARD_TOP_K_LIMIT ({len(ev_huge['snippets'])})")

    print("\n=== Test 8: defaults sanity ===")
    failures += _assert(DEFAULT_TOP_K >= 1 and DEFAULT_TOP_K <= HARD_TOP_K_LIMIT,
                        f"DEFAULT_TOP_K within bounds ({DEFAULT_TOP_K})")
    failures += _assert(DEFAULT_MAX_CHARS_PER_URL >= 200,
                        f"DEFAULT_MAX_CHARS_PER_URL ≥ 200 ({DEFAULT_MAX_CHARS_PER_URL})")
    failures += _assert(MIN_PARAGRAPH_CHARS < MAX_PARAGRAPH_CHARS,
                        "MIN_PARAGRAPH_CHARS < MAX_PARAGRAPH_CHARS")

    print("\n" + ("─" * 60))
    if failures:
        print(f"❌ {failures} assertion(s) failed")
        return 1
    print("✅ All evidence tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
