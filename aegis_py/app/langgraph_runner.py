"""LangGraph runner (writer → critic → refiner) для Python-пайплайнов."""

import re
from typing import Any, Callable, Dict, Optional

_REASON = None
try:  # pragma: no cover
    from langgraph.graph import StateGraph, END  # type: ignore
    _LG_OK = True
except Exception as e:  # pragma: no cover
    StateGraph = None  # type: ignore
    END = None  # type: ignore
    _LG_OK = False
    _REASON = f"langgraph_missing: {e.__class__.__name__}"


def is_available() -> bool:
    return _LG_OK


def unavailable_reason() -> Optional[str]:
    return _REASON


def run(
    user_prompt: str,
    niche: Optional[str],
    max_iters: int,
    bio_predictor: Optional[Callable[..., Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Символический writer→critic→refiner цикл без внешних LLM-вызовов."""
    max_iters = max(0, int(max_iters or 0))
    trace = []
    bio_score = None
    bio_gate = "pass"
    if bio_predictor is not None:
        try:
            bio = bio_predictor(text=user_prompt, threshold_fast_reject=0.35)
            bio_score = bio.get("score")
            bio_gate = bio.get("gate") or "pass"
            trace.append({"iter": 0, "node": "bio_filter", "score": bio_score, "gate": bio_gate})
            if bio_gate == "fast_reject":
                trace.append({"iter": 0, "node": "stop", "reason": "bio_fast_reject"})
                return {
                    "user_prompt": user_prompt,
                    "niche": niche,
                    "iterations": 0,
                    "bio_score": bio_score,
                    "bio_gate": bio_gate,
                    "passed": False,
                    "final_score": 0.0,
                    "trace": trace,
                    "article_html": "",
                    "note": "Rejected by bio-filter before writer stage",
                }
        except Exception:
            trace.append({"iter": 0, "node": "bio_filter", "error": "predict_failed"})

    article_html = _writer(user_prompt, niche=niche)
    passed = False
    final_score = 0.0
    iterations = 0

    for i in range(max_iters + 1):
        trace.append(
            {
                "iter": i,
                "node": "writer",
                "chars": len(article_html),
                "h2_count": _count_tag(article_html, "h2"),
            }
        )
        critic = _critic(article_html, user_prompt=user_prompt)
        final_score = critic["score"]
        iterations = i + 1
        trace.append(
            {
                "iter": i,
                "node": "critic",
                "score": critic["score"],
                "issues": critic["issues"],
                "metrics": critic["metrics"],
            }
        )
        if critic["passed"]:
            passed = True
            break
        if i >= max_iters:
            break
        article_html = _refiner(article_html, critic=critic, user_prompt=user_prompt)
        trace.append({"iter": i + 1, "node": "refiner", "applied": critic["issues"]})

    return {
        "user_prompt": user_prompt,
        "niche": niche,
        "iterations": iterations,
        "bio_score": bio_score,
        "bio_gate": bio_gate,
        "passed": passed,
        "final_score": final_score,
        "trace": trace,
        "article_html": article_html,
        "note": "Symbolic LangGraph cycle completed",
    }


def _writer(user_prompt: str, niche: Optional[str] = None) -> str:
    title = (user_prompt or "").strip().split("\n", 1)[0].strip() or "SEO article draft"
    title = re.sub(r"\s+", " ", title)[:120]
    niche_line = f"<p><strong>Ниша:</strong> {niche}</p>" if niche else ""
    return (
        f"<h1>{title}</h1>"
        f"{niche_line}"
        "<p>Краткое введение по теме и ключевым целям пользователя.</p>"
        "<h2>Основные тезисы</h2>"
        "<p>Практические ориентиры, риски и ожидаемый результат.</p>"
    )


def _critic(article_html: str, user_prompt: str) -> Dict[str, Any]:
    text = _collapse_ws(_strip_html_tags(article_html or ""))
    words = [w for w in text.split(" ") if w]
    word_count = len(words)
    h2_count = _count_tag(article_html, "h2")
    has_conclusion = "заключ" in text.lower() or "итог" in text.lower()

    score_len = min(35.0, (word_count / 220.0) * 35.0)
    score_structure = min(30.0, h2_count * 12.0)
    score_conclusion = 20.0 if has_conclusion else 0.0
    score_prompt_overlap = min(15.0, _prompt_overlap(user_prompt, text) * 15.0)

    score = round(score_len + score_structure + score_conclusion + score_prompt_overlap, 2)
    issues = []
    if word_count < 180:
        issues.append("expand_content")
    if h2_count < 2:
        issues.append("add_h2_sections")
    if not has_conclusion:
        issues.append("add_conclusion")
    if _prompt_overlap(user_prompt, text) < 0.2:
        issues.append("improve_prompt_alignment")
    return {
        "score": score,
        "passed": score >= 80.0,
        "issues": issues,
        "metrics": {
            "word_count": word_count,
            "h2_count": h2_count,
            "has_conclusion": has_conclusion,
        },
    }


def _refiner(article_html: str, critic: Dict[str, Any], user_prompt: str) -> str:
    refined = article_html or ""
    issues = set(critic.get("issues") or [])

    if "add_h2_sections" in issues:
        refined += (
            "<h2>Пошаговый план внедрения</h2>"
            "<p>Шаг 1: аудит. Шаг 2: приоритизация. Шаг 3: контроль результата.</p>"
        )
    if "expand_content" in issues:
        refined += (
            "<h2>Разбор ошибок и анти-паттернов</h2>"
            "<p>Частые ошибки: неверная семантика, переоптимизация и отсутствие метрик.</p>"
            "<p>Для контроля используйте недельный мониторинг CTR, позиций и конверсий.</p>"
        )
    if "improve_prompt_alignment" in issues:
        refined += f"<p><em>Уточнение по запросу:</em> {user_prompt[:180]}</p>"
    if "add_conclusion" in issues:
        refined += "<h2>Заключение</h2><p>Итог: внедряйте изменения итеративно и измеряйте эффект.</p>"
    return refined


def _count_tag(html: str, tag: str) -> int:
    if not html:
        return 0
    text = html.lower()
    needle = f"<{(tag or '').lower()}"
    if not needle or needle == "<":
        return 0
    count = 0
    i = 0
    n = len(text)
    while i < n:
        pos = text.find(needle, i)
        if pos == -1:
            break
        next_idx = pos + len(needle)
        if next_idx >= n or not text[next_idx].isalnum():
            count += 1
        i = pos + len(needle)
    return count


def _prompt_overlap(prompt: str, text: str) -> float:
    p = _keywords(prompt)
    t = _keywords(text)
    if not p:
        return 1.0
    if not t:
        return 0.0
    common = len(p & t)
    return max(0.0, min(1.0, common / max(1, len(p))))


def _keywords(s: str) -> set:
    tokens = re.findall(r"[a-zA-Zа-яА-ЯёЁ0-9]{4,}", (s or "").lower())
    return set(tokens[:80])


def _strip_html_tags(s: str) -> str:
    out = []
    in_tag = False
    for ch in s:
        if ch == "<":
            in_tag = True
            out.append(" ")
            continue
        if ch == ">":
            in_tag = False
            continue
        if not in_tag:
            out.append(ch)
    return "".join(out)


def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split())
