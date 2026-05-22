"""Smoke-тесты для shannon entropy. Не требуют тяжёлых deps."""

import math

from aegis_py.app.shannon import shannon_entropy, is_low_entropy, filter_low_entropy_blocks


def test_empty():
    assert shannon_entropy("") == 0.0
    assert shannon_entropy(None) == 0.0  # type: ignore[arg-type]


def test_single_char_low():
    # 'aaaa...' даёт H=0 (один уникальный символ).
    assert shannon_entropy("a" * 100) == 0.0


def test_uniform_two_chars():
    # 50/50 a/b → H = 1 bit
    H = shannon_entropy("ab" * 100)
    assert abs(H - 1.0) < 1e-9


def test_uniform_eight_chars():
    # 8 равно представленных символов → log2(8) = 3
    text = "abcdefgh" * 100
    assert abs(shannon_entropy(text) - 3.0) < 1e-9


def test_russian_text_above_threshold():
    text = "Семантическое ядро и анализ конкурентов это основа продвижения сайта"
    H = shannon_entropy(text * 5)
    # для нормального русского обычно ~4.0–4.6.
    assert H > 3.5


def test_low_entropy_garbage():
    # Повторяющийся «aaabbb» — H около 1, должен попасть в low.
    text = "aaabbb" * 30  # длина 180 ≥ min_len по умолчанию
    assert is_low_entropy(text, min_h=3.5, min_len=80)


def test_short_skip():
    # Короткий текст — не отбраковываем.
    assert is_low_entropy("aa", min_h=3.5, min_len=80) is False


def test_filter_blocks_stats():
    blocks = [
        {"text": "qqqqqq" * 30, "id": 1},   # low
        {"text": "Семантика и LSI это будущее" * 5, "id": 2},  # high
    ]
    res = filter_low_entropy_blocks(blocks, min_h=3.0, min_len=80)
    assert res["stats"]["kept_count"] == 1
    assert res["stats"]["dropped_count"] == 1
    assert any(d["id"] == 1 for d in res["dropped"])
    assert any(k["id"] == 2 for k in res["kept"])
