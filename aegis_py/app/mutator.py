"""DeepSeek-V4-Pro mutator (Python-обвязка).

По решению владельца продукта — DeepSeek, НЕ Claude.

Минимальная функция: принимает старый код + DOM-снимок, спрашивает
DeepSeek-V4-Pro и возвращает unified-diff или abort JSON. Та же
семантика, что и backend/src/services/aegis/deepseekMutator.js — но в
Python (нужен для запусков из aegis_py-сценариев, например, для
batch-анализа после массового падения парсера).

Графейс-деградирует: если DEEPSEEK_API_KEY не задан → 503.
"""

import os
from typing import Any, Dict, Optional

_REASON = None
try:  # pragma: no cover
    import requests  # type: ignore
    _DEPS_OK = True
except Exception as e:  # pragma: no cover
    _DEPS_OK = False
    _REASON = f"requests_missing: {e.__class__.__name__}"

DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")

SYSTEM = (
    "Ты — senior software engineer (Python + Node.js). Чини HTML-парсеры. "
    "Отвечай ТОЛЬКО unified-diff в ```diff блоке или {\"abort\": true, "
    "\"reason\": \"...\"} JSON. Не вводи новые зависимости. Запрещены пути: "
    "backend/src/services/llm/, backend/src/services/metrics/, "
    "backend/src/services/aegis/, migrations/, brain_state/, "
    ".github/workflows/. При уверенности <70% → abort."
)


def is_available() -> bool:
    return _DEPS_OK and bool(DEEPSEEK_KEY)


def unavailable_reason() -> Optional[str]:
    if not _DEPS_OK:
        return _REASON
    if not DEEPSEEK_KEY:
        return "DEEPSEEK_API_KEY not set"
    return None


def analyze(file_path: str, old_code: str, error_context: str, dom_snippet: str) -> Dict[str, Any]:
    user = "\n".join([
        f"[FILE_PATH] {file_path}",
        "[ERROR_CONTEXT]",
        (error_context or "")[:4000],
        "",
        "[OLD_CODE]",
        "```",
        (old_code or "")[:12000],
        "```",
        "",
        "[NEW_DOM_SNIPPET]",
        (dom_snippet or "")[:6000],
        "",
        "[INSTRUCTION] Предложи минимальный diff или abort JSON.",
    ])
    r = requests.post(  # type: ignore[union-attr]
        f"{DEEPSEEK_BASE}/chat/completions",
        headers={
            "Authorization": f"Bearer {DEEPSEEK_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": DEEPSEEK_MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user",   "content": user},
            ],
            "temperature": 0.1,
            "max_tokens":  6000,
        },
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()
    raw = (data.get("choices", [{}])[0].get("message", {}).get("content") or "")
    return {
        "raw": raw,
        "model": DEEPSEEK_MODEL,
        "tokens": data.get("usage", {}),
    }
