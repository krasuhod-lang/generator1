"""GA4 Reporting API v1 wrapper для RL/PPO feedback-loop.

Принцип: Sunday cron вызывает /ga4/fetch с массивом URL-путей самых
свежих опубликованных статей. Для каждой возвращаем sessions /
engagementRate / averageSessionDuration. Node-сервис (ga4Client.js)
поверх этих значений строит PPO-веса.

Env:
    AEGIS_GA4_PROPERTY_ID (обязателен)
    GOOGLE_APPLICATION_CREDENTIALS (путь к JSON service account)
    или AEGIS_GA4_SA_JSON (inline JSON)
"""

import json
import os
import tempfile
from typing import Any, Dict, List, Optional

_REASON = None
try:  # pragma: no cover
    from google.analytics.data_v1beta import BetaAnalyticsDataClient  # type: ignore
    from google.analytics.data_v1beta.types import (  # type: ignore
        DateRange, Dimension, Metric, RunReportRequest, FilterExpression, Filter,
    )
    _GA4_OK = True
except Exception as e:  # pragma: no cover
    BetaAnalyticsDataClient = None  # type: ignore
    _GA4_OK = False
    _REASON = f"ga4_missing: {e.__class__.__name__}"


def _resolve_credentials_path() -> Optional[str]:
    """Возвращает путь к JSON service account.

    Если задан AEGIS_GA4_SA_JSON (inline) — пишем во временный файл и
    возвращаем путь (GOOGLE_APPLICATION_CREDENTIALS ожидает именно путь).
    """
    p = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if p and os.path.exists(p):
        return p
    inline = os.environ.get("AEGIS_GA4_SA_JSON", "").strip()
    if not inline:
        return None
    try:
        json.loads(inline)  # validate
    except Exception:
        return None
    fd, tmp = tempfile.mkstemp(prefix="aegis_ga4_", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(inline)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = tmp
    return tmp


def is_available() -> bool:
    return _GA4_OK and bool(os.environ.get("AEGIS_GA4_PROPERTY_ID"))


def unavailable_reason() -> Optional[str]:
    if not _GA4_OK:
        return _REASON
    if not os.environ.get("AEGIS_GA4_PROPERTY_ID"):
        return "AEGIS_GA4_PROPERTY_ID not set"
    return None


def fetch_page_metrics(property_id: str, page_paths: List[str], date_range: str) -> Dict[str, Any]:
    _resolve_credentials_path()
    client = BetaAnalyticsDataClient()  # type: ignore[union-attr]

    # Один запрос с InListFilter по pagePath.
    req = RunReportRequest(  # type: ignore[union-attr]
        property=f"properties/{property_id}",
        date_ranges=[DateRange(start_date=date_range, end_date="today")],  # type: ignore[union-attr]
        dimensions=[Dimension(name="pagePath")],  # type: ignore[union-attr]
        metrics=[
            Metric(name="sessions"),  # type: ignore[union-attr]
            Metric(name="averageSessionDuration"),  # type: ignore[union-attr]
            Metric(name="engagementRate"),  # type: ignore[union-attr]
        ],
        dimension_filter=FilterExpression(  # type: ignore[union-attr]
            filter=Filter(  # type: ignore[union-attr]
                field_name="pagePath",
                in_list_filter=Filter.InListFilter(values=page_paths),  # type: ignore[union-attr]
            )
        ),
    )
    resp = client.run_report(req)
    items = []
    for row in resp.rows:
        path = row.dimension_values[0].value
        sessions = float(row.metric_values[0].value or 0)
        dur = float(row.metric_values[1].value or 0)
        eng = float(row.metric_values[2].value or 0)
        items.append({
            "pagePath": path,
            "sessions": sessions,
            "avgSessionDurationSec": dur,
            "engagementRate": eng,
        })
    return {"items": items, "property_id": property_id, "date_range": date_range}
