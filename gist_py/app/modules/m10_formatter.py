"""M10 SEO Formatter — финальная упаковка: мета, AIO-проверка, LSI, Schema.org.

Правила: каждый вопросительный H2 → первый абзац 40–60 слов, самодостаточный
ответ; сохранить LSI-покрытие и интент.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Dict, List, Optional

from .. import prompts
from ..config import CONFIG
from ..llm import LLMClient

logger = logging.getLogger("gist_py.m10")

_QUESTION_RE = re.compile(
    r"^(?:что|как|почему|зачем|когда|где|какой|какая|какие|каков|можно ли|"
    r"нужно ли|стоит ли|сколько|чем|кто)\b|\?\s*$",
    re.IGNORECASE,
)


def split_sections(article_text: str) -> List[Dict]:
    """Разбить Markdown-статью на секции по H2."""
    sections: List[Dict] = []
    current: Optional[Dict] = None
    for line in (article_text or "").splitlines():
        if line.startswith("## ") and not line.startswith("###"):
            if current:
                sections.append(current)
            current = {"h2": line[3:].strip(), "lines": []}
        elif current is not None:
            current["lines"].append(line)
    if current:
        sections.append(current)
    for sec in sections:
        body = "\n".join(sec.pop("lines")).strip()
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
        sec["body"] = body
        sec["first_paragraph"] = paragraphs[0] if paragraphs else ""
    return sections


def audit_aio(article_text: str) -> Dict:
    """Детерминированная AIO-проверка: вопросительные H2 и объём 1-го абзаца."""
    min_w, max_w = CONFIG["aio_snippet_min_words"], CONFIG["aio_snippet_max_words"]
    issues: List[Dict] = []
    snippets = 0
    for sec in split_sections(article_text):
        if not _QUESTION_RE.search(sec["h2"]):
            continue
        wc = len(sec["first_paragraph"].split())
        if min_w <= wc <= max_w:
            snippets += 1
        else:
            issues.append({"h2": sec["h2"], "first_paragraph_words": wc})
    return {"aio_snippets_count": snippets, "issues": issues}


def lsi_coverage(article_text: str, top10_claims: List[str]) -> float:
    """Доля LSI-терминов из ТОП-10, встречающихся в статье (в %)."""
    text_words = {
        w for w in re.findall(r"[а-яёa-z0-9]{4,}", (article_text or "").lower())
    }
    terms = {
        w
        for claim in top10_claims
        for w in re.findall(r"[а-яёa-z0-9]{4,}", claim.lower())
    }
    if not terms:
        return 0.0
    return round(len(terms & text_words) / len(terms) * 100, 2)


def build_schema(outline: Dict, content_format: str) -> Dict:
    """Schema.org разметка по рекомендации архитектора / формату контента."""
    schema_type = outline.get("schema_type") or {
        "HOW-TO": "HowTo",
        "FAQ": "FAQPage",
        "LIST": "ItemList",
    }.get(content_format, "Article")
    return {
        "@context": "https://schema.org",
        "@type": schema_type,
        "headline": outline.get("h1", ""),
        "description": outline.get("meta_description", ""),
    }


def format_article(
    article_text: str,
    outline: Dict,
    content_format: str,
    top10_claims: List[str],
    llm: Optional[LLMClient] = None,
) -> Dict:
    """Полный проход M10: AIO-фикс через LLM + мета + schema + метрики."""
    llm = llm or LLMClient()
    audit = audit_aio(article_text)
    final_text = article_text
    if audit["issues"]:
        try:
            fixed = llm.complete(
                prompts.render(prompts.G3_AIO_CHECK, article_text=article_text),
                temperature=0.4,
            )
            fixed = re.sub(r"```(?:markdown|json)?[\s\S]*?```\s*$", "", fixed).strip()
            if fixed and len(fixed.split()) >= len(article_text.split()) * 0.7:
                final_text = fixed
                audit = audit_aio(final_text)
        except Exception as exc:
            logger.warning("G3-AIO-CHECK не удался: %s", exc)
    schema = build_schema(outline, content_format)
    return {
        "content": final_text,
        "meta": {
            "title": outline.get("meta_title", ""),
            "description": outline.get("meta_description", ""),
            "h1": outline.get("h1", ""),
        },
        "schema": schema,
        "schema_json_ld": json.dumps(schema, ensure_ascii=False),
        "aio_snippets_count": audit["aio_snippets_count"],
        "aio_issues": audit["issues"],
        "lsi_coverage_pct": lsi_coverage(final_text, top10_claims),
    }
