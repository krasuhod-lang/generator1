"""Тесты порогов LinguaForensic (§11), рерайта (§12) и M10 (§13)."""

from app.llm import extract_first_json, parse_numbered_list
from app.modules.m8_detector import load_skill, strategy_for_score
from app.modules.m9_rewriter import _strip_changes_json, _volume_ok
from app.modules.m10_formatter import audit_aio, build_schema, lsi_coverage


def test_strategy_thresholds():
    assert strategy_for_score(10) == "accept"
    assert strategy_for_score(20) == "accept"
    assert strategy_for_score(21) == "light"
    assert strategy_for_score(35) == "light"
    assert strategy_for_score(36) == "medium"
    assert strategy_for_score(55) == "medium"
    assert strategy_for_score(56) == "deep"
    assert strategy_for_score(75) == "deep"
    assert strategy_for_score(76) == "full"


def test_load_skill_fallback():
    # Файла AI-detect-v-3-6.md в CI нет — используется упрощённый system prompt
    skill = load_skill()
    assert "LinguaForensic" in skill
    assert "robotness_score" in skill


def test_volume_ok():
    original = "слово " * 100
    assert _volume_ok(original, "слово " * 100)
    assert _volume_ok(original, "слово " * 110)
    assert not _volume_ok(original, "слово " * 200)
    assert not _volume_ok(original, "")


def test_strip_changes_json():
    raw = 'Переписанный текст: Хороший длинный текст статьи.\n\n{"changes": ["F2"]}'
    assert _strip_changes_json(raw) == "Хороший длинный текст статьи."


def test_audit_aio_counts_snippets():
    good_answer = " ".join(["слово"] * 50)
    article = (
        "## Как выбрать котёл?\n\n" + good_answer + "\n\n"
        "## Почему котёл шумит?\n\nКороткий ответ.\n\n"
        "## Технические характеристики\n\nЛюбой текст.\n"
    )
    audit = audit_aio(article)
    assert audit["aio_snippets_count"] == 1
    assert len(audit["issues"]) == 1
    assert audit["issues"][0]["h2"] == "Почему котёл шумит?"


def test_lsi_coverage():
    claims = ["мощность котла зависит от площади", "двухконтурный котёл греет воду"]
    article = "Мощность котла подбирается по площади дома."
    pct = lsi_coverage(article, claims)
    assert 0 < pct < 100


def test_build_schema_by_format():
    assert build_schema({}, "HOW-TO")["@type"] == "HowTo"
    assert build_schema({}, "FAQ")["@type"] == "FAQPage"
    assert build_schema({}, "DEEP-DIVE")["@type"] == "Article"
    assert build_schema({"schema_type": "Product"}, "FAQ")["@type"] == "Product"


def test_extract_first_json():
    assert extract_first_json('мусор ```json\n{"a": 1}\n``` хвост') == {"a": 1}
    assert extract_first_json('[{"b": 2}] и пояснение') == [{"b": 2}]
    assert extract_first_json("нет json") is None
    assert extract_first_json("") is None


def test_parse_numbered_list():
    text = "1. Первый тезис\n2) Второй тезис\n- Третий\nпросто строка"
    assert parse_numbered_list(text) == ["Первый тезис", "Второй тезис", "Третий"]
