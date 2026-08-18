"""Конфигурация pipeline_py.

Все параметры переопределяются через переменные окружения ``PIPELINE_*``,
чтобы менять поведение без правки кода. Значения по умолчанию соответствуют
ТЗ (таймаут fetch ≤ 20 000 мс, до 3 попыток и т.п.).
"""

from __future__ import annotations

import os


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


def _s(name: str, default: str) -> str:
    val = os.environ.get(name)
    return val if val not in (None, "") else default


CONFIG = {
    # --- Слой 1: очередь URL -------------------------------------------------
    # Путь к SQLite-файлу очереди (персистентность/возобновление после сбоя).
    "queue_db_path": _s("PIPELINE_QUEUE_DB", "pipeline_queue.sqlite3"),
    # Имя колонки с URL во входном CSV/Excel/Google Sheets.
    "url_column": _s("PIPELINE_URL_COLUMN", "url"),
    # Максимум попыток обработки одной задачи (1 основная + retry).
    "max_retries": _i("PIPELINE_MAX_RETRIES", 3),

    # --- Слой 2: fetcher -----------------------------------------------------
    # Базовый URL сервиса relevance_fetcher (endpoint /fetch_html).
    "fetcher_url": _s("PIPELINE_FETCHER_URL", "http://relevance_fetcher:8001"),
    "fetcher_internal_token": _s("PIPELINE_FETCHER_TOKEN", ""),
    "fetch_timeout_ms": _i("PIPELINE_FETCH_TIMEOUT_MS", 20000),
    # use_js_render по умолчанию (Mode B — Playwright). False => Mode A curl_cffi.
    "fetch_use_js_render": _b("PIPELINE_FETCH_JS", False),
    # auto_escalate: если Mode A не смог — сервис сам пробует Mode B.
    "fetch_auto_escalate": _b("PIPELINE_FETCH_AUTO_ESCALATE", True),

    # --- Слой 3: очиститель HTML --------------------------------------------
    # Минимальная длина текста, ниже которой очистка считается неуспешной.
    "clean_min_text_len": _i("PIPELINE_CLEAN_MIN_TEXT", 40),

    # --- Слой 7: хранилище ---------------------------------------------------
    "output_path": _s("PIPELINE_OUTPUT", "pipeline_output.xlsx"),

    # --- Слой 8: журналирование ---------------------------------------------
    "log_level": _s("PIPELINE_LOG_LEVEL", "INFO"),
}
