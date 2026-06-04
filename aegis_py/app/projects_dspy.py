"""projects_dspy — DSPy-сигнатуры для усиления промптов модуля «Анализ GSC».

Покрывает 6 LLM-слоёв расширения (п.6 ТЗ — «использовать DSPY для усиления
промтов»):

    LinkRecommend    — рекомендации по покупке ссылок (анкор + тема + цель)
    BlogTopicSuggest — темы статей для блога (+ title/description)
    EatRecommend     — план улучшения E-E-A-T по шаблонам страниц
    GeoAeoBoost      — рекомендации для попадания в нейровыдачу (AI Overviews)
    MetaUplift       — усиление title/description страницы
    SchemaSuggest    — что добавить/поправить в микроразметке

Архитектура GRACEFUL:
    * Если `dspy-ai` установлен — определяем настоящие dspy.Signature и можем
      их компилировать/оптимизировать на исторических примерах.
    * Если `dspy-ai` НЕ установлен — модуль всё равно импортируется и отдаёт
      статически усиленные инструкции (few-shot demos захардкожены), так что
      node-сторона (dspyClient.js) получает рабочий prompt-суффикс без DSPy.

Node вызывает это через FastAPI-эндпоинт POST /dspy/prompt/{signature}.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

try:  # DSPy опционален — тяжёлая зависимость.
    import dspy  # type: ignore

    _DSPY_AVAILABLE = True
except Exception:  # pragma: no cover - окружение без dspy-ai
    dspy = None  # type: ignore
    _DSPY_AVAILABLE = False


# ── Базовые инструкции по сигнатурам (работают и без dspy-ai) ──────────────
# Каждая запись: instructions (усиленный системный суффикс) + demos (few-shot
# примеры удачных формулировок, эталоны для node-side подмешивания в промпт).
_SIGNATURES: Dict[str, Dict[str, Any]] = {
    "LinkRecommend": {
        "instructions": (
            "Выдавай НЕ МЕНЕЕ 5 рекомендаций на покупку ссылок. Каждая = "
            "{анкор, тип_анкора, тема_статьи_донора, целевой_URL_нашего_сайта, "
            "почему}. Анкоры разнообразь: бренд / коммерческий / безанкорный / "
            "LSI. Приоритет — коммерческим целевым страницам без бэклинков и "
            "запросам в striking distance. Не предлагай покупать ссылки на одну "
            "страницу более 30% от общего объёма."
        ),
        "demos": [
            "анкор «купить котёл в Москве» → статья «Как выбрать газовый котёл» "
            "на тематическом доноре → /catalog/gazovye-kotly (коммерческая цель "
            "в striking distance, поз. 8)",
            "безанкорный (URL) → обзор отопительного оборудования → главная "
            "(разбавляем переоптимизированный анкор-профиль)",
        ],
    },
    "BlogTopicSuggest": {
        "instructions": (
            "Выдавай НЕ МЕНЕЕ 5 тем статей для блога. Каждая = {тема, H1, title "
            "(50–60 симв), description (140–155 симв), интент целевого URL, "
            "опорные запросы из GSC}. Бери темы из инфо-запросов в striking "
            "distance и непокрытых инфо-запросов. Title/description — под CTR, "
            "без переспама."
        ),
        "demos": [
            "тема «Чем отличается конденсационный котёл от обычного» — закрывает "
            "инфо-запросы с показами без кликов, ведёт на /catalog/kotly",
        ],
    },
    "EatRecommend": {
        "instructions": (
            "Для каждого шаблона страницы оцени E-E-A-T (Experience, Expertise, "
            "Authoritativeness, Trust) и дай конкретный план: какие блоки "
            "добавить (автор+регалии, кейсы, отзывы, сертификаты, контакты, "
            "юр.инфо, гарантии). Приоритизируй по влиянию на доверие и конверсию."
        ),
        "demos": [
            "шаблон product: нет блока автора/эксперта и отзывов → добавить "
            "карточку эксперта с регалиями + агрегированный рейтинг + UGC-отзывы",
        ],
    },
    "GeoAeoBoost": {
        "instructions": (
            "Дай рекомендации для попадания в нейровыдачу (AI Overviews / SGE / "
            "Perplexity). Для каждого приоритетного запроса: AEO-формат ответа "
            "(TL;DR 40–80 слов в начале, нумерованные списки, явные сущности, "
            "prompt-friendly заголовки-вопросы), нужные JSON-LD типы (FAQPage/"
            "HowTo/Speakable/Article), hreflang при гео-спросе, sameAs/mentions "
            "для связей сущностей."
        ),
        "demos": [
            "запрос «как обслуживать котёл» → H2-вопрос + TL;DR-ответ 60 слов + "
            "HowTo JSON-LD + Speakable → шанс цитирования в AI Overview",
        ],
    },
    "MetaUplift": {
        "instructions": (
            "Усиль title (50–60 симв) и description (140–155 симв): главный ключ "
            "в первых словах title, выгода/срок/цена, бренд в середине/конце, "
            "CTA в конце description, без переспама и обрыва на полуслове. Покажи "
            "diff «было → стало» с обоснованием."
        ),
        "demos": [
            "было: «Котлы» (5 симв, нет выгоды) → стало: «Газовые котлы | Цена от "
            "12 000 ₽ | Доставка за 1 день» (55 симв)",
        ],
    },
    "SchemaSuggest": {
        "instructions": (
            "Проведи аудит микроразметки по шаблону: какие JSON-LD типы есть, "
            "каких не хватает для этого типа страницы, какие поля битые/пустые. "
            "Предложи готовые JSON-LD сниппеты (Product/Offer/FAQPage/Article/"
            "BreadcrumbList/Organization) с приоритетом типов для AI Overviews."
        ),
        "demos": [
            "шаблон product без Offer.price/availability → добавить Offer с "
            "price, priceCurrency, availability + AggregateRating",
        ],
    },
}


def available_signatures() -> List[str]:
    return list(_SIGNATURES.keys())


def is_dspy_available() -> bool:
    return _DSPY_AVAILABLE


if _DSPY_AVAILABLE:  # pragma: no cover - требует установленного dspy-ai

    class LinkRecommend(dspy.Signature):  # type: ignore
        """Рекомендации на покупку ссылок: анкор + тема статьи донора + цель."""

        link_profile = dspy.InputField(desc="Анкор-облако, доноры, голые страницы")
        commercial_gaps = dspy.InputField(desc="Коммерческие цели без бэклинков")
        recommendations = dspy.OutputField(desc="≥5 рекомендаций {anchor,topic,target,why}")

    class BlogTopicSuggest(dspy.Signature):  # type: ignore
        """Темы статей для блога с готовыми title/description."""

        content_gaps = dspy.InputField(desc="Инфо-запросы striking distance / непокрытые")
        topics = dspy.OutputField(desc="≥5 тем {topic,h1,title,description,intent,queries}")

    class EatRecommend(dspy.Signature):  # type: ignore
        """План улучшения E-E-A-T по шаблонам страниц."""

        templates = dspy.InputField(desc="Шаблоны с блоками и E-E-A-T score")
        plan = dspy.OutputField(desc="План улучшений по каждому шаблону")

    class GeoAeoBoost(dspy.Signature):  # type: ignore
        """Рекомендации для нейровыдачи (AI Overviews / SGE)."""

        ai_visibility = dspy.InputField(desc="SERP-фичи, schema-покрытие, гео-спрос")
        recommendations = dspy.OutputField(desc="AEO-формат + schema + hreflang")

    class MetaUplift(dspy.Signature):  # type: ignore
        """Усиление title/description страницы."""

        current_meta = dspy.InputField(desc="Текущие title/description + GSC-сигналы")
        improved = dspy.OutputField(desc="Улучшенные title/description + diff")

    class SchemaSuggest(dspy.Signature):  # type: ignore
        """Аудит и рекомендации по микроразметке."""

        schema_inventory = dspy.InputField(desc="Найденные типы + битые поля по шаблону")
        suggestions = dspy.OutputField(desc="Что добавить/поправить + JSON-LD сниппеты")

    _DSPY_SIGNATURE_CLASSES = {
        "LinkRecommend": LinkRecommend,
        "BlogTopicSuggest": BlogTopicSuggest,
        "EatRecommend": EatRecommend,
        "GeoAeoBoost": GeoAeoBoost,
        "MetaUplift": MetaUplift,
        "SchemaSuggest": SchemaSuggest,
    }
else:
    _DSPY_SIGNATURE_CLASSES = {}


def build_prompt(signature: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Возвращает усиленные инструкции + few-shot demos для сигнатуры.

    Работает и без dspy-ai (статические эталоны). context резервируется под
    будущую контекстную оптимизацию (ниша, прошлые outcomes); сейчас отдаём
    стабильный усиленный промпт.
    """
    sig = _SIGNATURES.get(signature)
    if sig is None:
        return {
            "ok": False,
            "reason": "unknown_signature",
            "available": available_signatures(),
        }
    return {
        "ok": True,
        "signature": signature,
        "instructions": sig["instructions"],
        "demos": list(sig.get("demos", [])),
        "optimized": False,  # true только после реальной MIPROv2-компиляции
        "dspy_available": _DSPY_AVAILABLE,
        "context_keys": sorted((context or {}).keys()),
    }
