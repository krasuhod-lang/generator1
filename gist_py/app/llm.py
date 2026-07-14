"""LLM-адаптер с graceful DSPy-фолбэком (паттерн aegis_py/projects_dspy.py).

* Если установлен `dspy-ai` — модули пайплайна работают как dspy.Module
  (через dspy.LM), промпты можно оптимизировать MIPROv2.
* Если DSPy нет — используется прямой OpenAI-совместимый HTTP-вызов
  (GIST_LLM_API_BASE + GIST_LLM_API_KEY), тот же интерфейс.
* Если нет ни того ни другого (тесты/CI) — LLMClient.complete кидает
  LLMUnavailable, а детерминированные части пайплайна продолжают работать.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, List, Optional

import requests

from .config import CONFIG

logger = logging.getLogger("gist_py.llm")

try:  # DSPy опционален — тяжёлая зависимость
    import dspy  # type: ignore

    DSPY_AVAILABLE = True
except Exception:  # pragma: no cover
    dspy = None  # type: ignore
    DSPY_AVAILABLE = False


class LLMUnavailable(RuntimeError):
    """LLM недоступен (нет dspy и нет API-ключа)."""


class LLMClient:
    """Единая точка вызова LLM для всех модулей M0–M10."""

    def __init__(self, model: Optional[str] = None):
        self.model = model or CONFIG["llm_model"]
        self.api_base = os.environ.get("GIST_LLM_API_BASE", "")
        self.api_key = os.environ.get("GIST_LLM_API_KEY", "")
        self._dspy_lm = None
        if DSPY_AVAILABLE and self.api_key:
            try:
                self._dspy_lm = dspy.LM(
                    self.model, api_base=self.api_base or None, api_key=self.api_key
                )
                dspy.configure(lm=self._dspy_lm)
            except Exception as exc:  # pragma: no cover
                logger.warning("dspy.LM init failed, falling back to HTTP: %s", exc)

    @property
    def available(self) -> bool:
        return bool(self._dspy_lm or (self.api_base and self.api_key))

    def complete(self, prompt: str, system: str = "", temperature: float = 0.4) -> str:
        """Выполнить один вызов LLM и вернуть текст ответа."""
        if self._dspy_lm is not None:
            messages = []
            if system:
                messages.append({"role": "system", "content": system})
            messages.append({"role": "user", "content": prompt})
            out = self._dspy_lm(messages=messages, temperature=temperature)
            return out[0] if isinstance(out, list) else str(out)
        if self.api_base and self.api_key:
            return self._http_complete(prompt, system, temperature)
        raise LLMUnavailable(
            "Нет доступного LLM: установите dspy-ai или задайте "
            "GIST_LLM_API_BASE + GIST_LLM_API_KEY"
        )

    def _http_complete(self, prompt: str, system: str, temperature: float) -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        resp = requests.post(
            self.api_base.rstrip("/") + "/chat/completions",
            headers={"Authorization": "Bearer " + self.api_key},
            json={"model": self.model, "messages": messages, "temperature": temperature},
            timeout=180,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


def extract_first_json(text: str) -> Optional[Any]:
    """Вырезать первый сбалансированный JSON-объект/массив из ответа LLM.

    LLM часто оборачивает JSON в ```json ...``` или добавляет пояснения —
    сканируем скобки с учётом строк (аналог extractFirstJsonObject в Node).
    """
    if not text:
        return None
    text = re.sub(r"```(?:json)?", "", text)
    # Берём тот опенер, который встречается раньше — сохраняем тип (объект/массив)
    candidates = sorted(
        (
            (text.find(op), op, cl)
            for op, cl in (("{", "}"), ("[", "]"))
            if text.find(op) != -1
        ),
    )
    for start, opener, closer in candidates:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
    return None


def parse_numbered_list(text: str) -> List[str]:
    """Разобрать нумерованный/маркированный список из ответа LLM."""
    items: List[str] = []
    for line in (text or "").splitlines():
        m = re.match(r"^\s*(?:\d+[.)]|[-*•])\s+(.+)$", line)
        if m:
            item = m.group(1).strip()
            if item:
                items.append(item)
    return items
