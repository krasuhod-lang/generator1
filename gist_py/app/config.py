"""Конфигурация GIST-пайплайна.

Все пороги из ТЗ собраны здесь, чтобы их можно было менять без правки кода
модулей. Переопределяются через переменные окружения GIST_*.
"""

from __future__ import annotations

import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _b(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in {"0", "false", "no", "off", ""}


CONFIG = {
    # M1 Competitor Scraper
    "serp_top_n": _i("GIST_SERP_TOP_N", 10),
    "min_word_count": _i("GIST_MIN_WORD_COUNT", 300),
    # Стоп-лист агрегаторов-монстров (домены исключаются из анализа ТОПа)
    "domain_stoplist": [
        d.strip()
        for d in os.environ.get(
            "GIST_DOMAIN_STOPLIST",
            "wikipedia.org,youtube.com,avito.ru,ozon.ru,wildberries.ru,"
            "market.yandex.ru,aliexpress.ru,pinterest.com,facebook.com,"
            "vk.com,instagram.com,tiktok.com,dzen.ru,otzovik.com,irecommend.ru",
        ).split(",")
        if d.strip()
    ],
    # M2 Noise Extractor — дедупликация claims
    "dedup_cosine_threshold": _f("GIST_DEDUP_COSINE", 0.85),
    # GIST Score (M3/§6)
    "gist_score_min": _f("GIST_SCORE_MIN", 30.0),
    "gist_score_target_low": _f("GIST_SCORE_TARGET_LOW", 40.0),
    "gist_score_target_high": _f("GIST_SCORE_TARGET_HIGH", 65.0),
    # M4 Content Architect — правило баланса 40/60
    "base_blocks_share": _f("GIST_BASE_SHARE", 0.4),
    "expert_blocks_share": _f("GIST_EXPERT_SHARE", 0.6),
    # M8/M9 LinguaForensic — пороги robotness (§11)
    "robotness_accept": _f("GIST_ROBOTNESS_ACCEPT", 20.0),
    "robotness_light_max": _f("GIST_ROBOTNESS_LIGHT_MAX", 35.0),
    "robotness_medium_max": _f("GIST_ROBOTNESS_MEDIUM_MAX", 55.0),
    "robotness_deep_max": _f("GIST_ROBOTNESS_DEEP_MAX", 75.0),
    # Stop criteria (§15)
    "robotness_stop": _f("GIST_ROBOTNESS_STOP", 25.0),
    "max_rewrite_iterations": _i("GIST_MAX_REWRITES", 3),
    "fact_preservation_max_retries": _i("GIST_FACT_RETRIES", 2),
    # M-1 Topic Discovery
    "topic_score_go_states": [
        s.strip()
        for s in os.environ.get("GIST_TOPIC_SCORE_GO_STATES", "void,lack").split(",")
        if s.strip()
    ],
    # M1.5 SERP Cleansing
    "cleansing_enabled": _b("GIST_CLEANSING_ENABLED", True),
    # AIO-snippet: 40–60 слов
    "aio_snippet_min_words": _i("GIST_AIO_MIN_WORDS", 40),
    "aio_snippet_max_words": _i("GIST_AIO_MAX_WORDS", 60),
    # AIO passage: самодостаточные пассажи 130–170 слов
    "aio_passage_min_words": _i("GIST_AIO_PASSAGE_MIN", 130),
    "aio_passage_max_words": _i("GIST_AIO_PASSAGE_MAX", 170),
    # Внешние сервисы
    "headless_fetcher_url": os.environ.get(
        "RELEVANCE_HEADLESS_FETCHER_URL", "http://relevance_fetcher:8001/fetch"
    ),
    # LinguaForensic v3.6 — путь к skill-файлу (system prompt детектора)
    "linguaforensic_skill_path": os.environ.get(
        "GIST_LINGUAFORENSIC_SKILL", "AI-detect-v-3-6.md"
    ),
    # LLM
    "llm_model": os.environ.get("GIST_LLM_MODEL", "gemini-3.1-pro-preview"),
}


# ── Секреты держим отдельно от CONFIG (не попадают в логи/дампы) ────────────

def serper_api_key() -> str:
    return os.environ.get("SERPER_API_KEY", "")


def serpapi_api_key() -> str:
    return os.environ.get("SERPAPI_API_KEY", "")


def internal_token() -> str:
    return os.environ.get("GIST_INTERNAL_TOKEN", "")


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "")
