"""Персист метрик пайплайна в PostgreSQL (таблица article_tasks, §14).

Graceful: если psycopg2 не установлен или DATABASE_URL не задан — метрики
не пишутся напрямую (их персистит Node-бэкенд из ответа API), функции
возвращают False без исключений.
"""

from __future__ import annotations

import json
import logging
from typing import Dict, Optional

from .config import CONFIG

logger = logging.getLogger("gist_py.db")

try:  # pragma: no cover - опциональная зависимость
    import psycopg2  # type: ignore

    _PG_AVAILABLE = True
except Exception:
    psycopg2 = None  # type: ignore
    _PG_AVAILABLE = False

# Поля §14, которые пайплайн умеет записывать
_JSON_FIELDS = {
    "top10_claims_json",
    "information_delta_json",
    "persona_json",
    "top_ai_categories",
    "full_detection_report",
    "redundancy_report_json",
    "fluency_metrics_json",
    "outline_json",
    "meta_json",
}
_SCALAR_FIELDS = {
    "gist_score",
    "aio_trigger_group",
    "aio_trigger_rate",
    "content_format",
    "zero_click_risk",
    "robotness_score",
    "robotness_ci",
    "llm_family",
    "knockoff_s",
    "rewrite_iterations",
    "pipeline_stage",
    "lsi_coverage_pct",
    "aio_snippets_count",
    "schema_type",
    "status",
    "error_message",
    "final_content",
}


def available() -> bool:
    return _PG_AVAILABLE and bool(CONFIG["database_url"])


def save_task_metrics(task_id: Optional[str], metrics: Dict) -> bool:
    """UPDATE article_tasks SET ... WHERE id = task_id. Возвращает успех."""
    if not task_id or not available():
        return False
    sets, values = [], []
    for key, value in metrics.items():
        if key in _JSON_FIELDS:
            sets.append(f"{key} = %s::jsonb")
            values.append(json.dumps(value, ensure_ascii=False))
        elif key in _SCALAR_FIELDS:
            sets.append(f"{key} = %s")
            values.append(value)
    if not sets:
        return False
    sets.append("updated_at = now()")
    values.append(task_id)
    try:
        conn = psycopg2.connect(CONFIG["database_url"])
        try:
            with conn, conn.cursor() as cur:
                cur.execute(
                    f"UPDATE article_tasks SET {', '.join(sets)} WHERE id = %s",
                    values,
                )
        finally:
            conn.close()
        return True
    except Exception as exc:  # pragma: no cover
        logger.warning("Не удалось записать метрики article_tasks: %s", exc)
        return False
