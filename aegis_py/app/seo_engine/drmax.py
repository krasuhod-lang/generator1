"""Модуль 4 + 7: DrMax E-E-A-T сигналы и промпты DeepSeek v4.

build_drmax_signals() — инструкции райтеру (contentEffort, Semantic
Canonicalisation, Negative Capability, Zero-Fluff).

Промпты:
  • ENTITY_RESEARCH_PROMPT — извлечение «Якоря достоверности» из ТОП-20.
  • CRITIC_PROMPT          — строгий фактчекинг + Zero-Fluff аудит.
"""

from __future__ import annotations


def build_drmax_signals(keyword: str, is_commercial: bool = False) -> str:
    """Собрать блок E-E-A-T инструкций DrMax для заданного ключа."""
    base = f"""
## DrMax E-E-A-T для ключа: "{keyword}"

### 1. contentEffort (Следы реального опыта)
- Добавь 1–2 специфических практических ограничения (что реально может пойти не так).
- Используй конкретные числа ТОЛЬКО из ground_truth_context.
- Упомяни один неочевидный нюанс, которого нет у большинства ТОП-20.

### 2. Semantic Canonicalisation (для GSE/AI Overviews)
- ПЕРВОЕ предложение: "[Сущность] — это [определение]. [Контекст применения]."
- Цель: однозначная классификация страницы для Google AI Overviews и Яндекс Нейро.

### 3. Negative Capability (ОБЯЗАТЕЛЬНЫЙ БЛОК)
- Раздел "Когда [тема] НЕ подходит / Ограничения".
- 2–3 реальных сценария, где метод/продукт не рекомендуется.
- Располагать в середине или конце текста — НЕ в начале.

### 4. Zero-Fluff (СТРОГО)
ЗАПРЕЩЕНО: "В современном мире", "Актуальность темы", "Невозможно переоценить",
"Следует отметить", "Как известно", "Играет важную роль", "На сегодняшний день".
"""
    if is_commercial:
        base += (
            "\n### 5. Коммерческие факторы\n"
            "Цена, условия, CTA — только из ground_truth_context."
        )
    return base.strip()


# ── Промпт EntityResearchNode (DeepSeek v4) ──────────────────────────
ENTITY_RESEARCH_PROMPT = """РОЛЬ: SEO-аналитик данных. Извлеки "Якорь достоверности" из ТОП-20.
ЗАПРОС: {keyword}
ДАННЫЕ: {serp_content}

ЗАДАЧИ:
1. Все Named Entities + частота у конкурентов (доля 0.0–1.0).
2. ВЕРИФИЦИРОВАННЫЕ факты (≥2 источника из ТОП-20).
3. Уникальные сущности (частота < 30%) — Information Gain.
4. "Якорь достоверности" — структурированный текст с фактами для DraftingNode.
ЗАПРЕЩЕНО добавлять факты не из предоставленных данных.

ОТВЕТ JSON: {{"ground_truth":"...","entities":[...],"unique_entities":[...],"frequencies":{{}}}}"""


# ── Промпт CriticAndFactCheckNode (DeepSeek v4) ──────────────────────
CRITIC_PROMPT = """РОЛЬ: Строгий SEO-редактор и фактчекер.
ТЕКСТ: {draft}
GROUND TRUTH: {ground_truth}
ФАКТЫ ИЗ ТЕКСТА: {facts}
HYBRID SCORE: {score}/10 | FEEDBACK СКОРЕРА: {scorer_feedback}

ПРОВЕРКИ:
1. ФАКТЧЕКИНГ: каждый факт из списка — есть в ground_truth? Нет → hallucinations.
2. NEGATIVE CAPABILITY: присутствует блок ограничений? (да/нет)
3. CANONICALISATION: первое предложение содержит определение сущности? (да/нет)
4. ZERO-FLUFF: найди клише, перечисли конкретные фразы.
5. FEEDBACK: конкретные инструкции для следующей попытки ("Добавь X", "Убери Y").

ОТВЕТ JSON: {{"hallucinations":[...],"has_negative_capability":bool,"has_canonicalisation":bool,"fluff_found":[...],"feedback":"..."}}"""
