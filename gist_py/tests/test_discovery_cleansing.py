"""Тесты M-1, M1.5 и новых formatter-хелперов."""

from app.modules.m_minus_1_discovery import classify_topic_score
from app.modules.m1_5_cleansing import cleanse_pages
from app.modules.m10_formatter import build_slug, count_multimodal_placeholders


def test_classify_topic_score_four_branches():
    assert classify_topic_score(90, 10) == "void"
    assert classify_topic_score(75, 50) == "lack"
    assert classify_topic_score(55, 50) == "balance"
    assert classify_topic_score(35, 80) == "abundance"


def test_cleanse_pages_strips_boilerplate():
    pages = [
        {
            "url": "https://example.com/1",
            "body_text": """
Меню
Главная > Раздел
Как выбрать котёл для дома
Читайте также: рейтинг моделей
Мощность котла считают по площади и теплопотерям здания.
Подписывайтесь на нас
© 2026 Example
""",
        }
    ]
    cleaned = cleanse_pages(pages, "как выбрать котёл")
    text = cleaned[0]["body_text"].lower()
    assert "мощность котла" in text
    assert "читайте также" not in text
    assert "подписывайтесь" not in text
    assert "©" not in text


def test_build_slug_cyrillic_no_digits():
    slug = build_slug("Как выбрать газовый котёл 2026: 7 ошибок")
    assert slug == "vybrat-gazovyy-kotel-oshibok"
    assert "2026" not in slug
    assert "/" not in slug


def test_count_multimodal_placeholders():
    counts = count_multimodal_placeholders(
        "Текст [IMAGE: схема котла] и [VIDEO: как выбрать котёл]"
    )
    assert counts == {"images": 1, "videos": 1}
