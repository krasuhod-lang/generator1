"""M1.5 SERP Cleansing & Classification — очистка SERP и GIST-1 ядро.

Модуль удаляет навигационный шум из текстов конкурентов и опционально
классифицирует обязательное/избыточное ядро и семантические лакуны.
"""

from __future__ import annotations

import html
import logging
import re
from collections import Counter
from typing import Dict, List, Optional

from .. import prompts
from ..llm import LLMClient, extract_first_json

logger = logging.getLogger("gist_py.m1_5")

CLASS_KEYS = ("mandatory_core", "redundant_core", "weak_template", "semantic_gaps")
BOILERPLATE_RE = re.compile(
    r"(читайте также|подписывайтесь|подписаться|copyright|©|cookie|cookies|"
    r"навигац|меню|breadcrumb|хлебн(ые|ых) крошк|реклама|advert|"
    r"политика конфиденциальности|пользовательское соглашение|войти|регистрация|"
    r"share|поделиться|комментарии|все права защищены)",
    re.IGNORECASE,
)
TAG_DROP_RE = re.compile(r"<\s*(script|style|nav|footer|header|aside|form)[^>]*>[\s\S]*?<\s*/\s*\s*>", re.I)
TAG_RE = re.compile(r"<[^>]+>")


def _to_text(page: Dict) -> str:
    text = page.get("body_text") or page.get("html") or ""
    text = str(text)
    if "<" in text and ">" in text:
        text = TAG_DROP_RE.sub("\n", text)
        text = re.sub(r"<\s*(p|div|br|li|h[1-6]|tr|td|th)[^>]*>", "\n", text, flags=re.I)
        text = TAG_RE.sub(" ", text)
    return html.unescape(text)


def _line_is_noise(line: str, repeated_short: bool = False) -> bool:
    clean = re.sub(r"\s+", " ", line).strip()
    if not clean:
        return True
    words = re.findall(r"[а-яёa-z0-9]+", clean.lower())
    if BOILERPLATE_RE.search(clean):
        return True
    if len(words) <= 2 and len(clean) < 28:
        return True
    if repeated_short and len(words) <= 6:
        return True
    letters = sum(ch.isalpha() for ch in clean)
    if letters < 8 and len(clean) < 40:
        return True
    return False


def _clean_text(text: str, repeated_lines: set[str]) -> str:
    kept: List[str] = []
    for raw in re.split(r"[\r\n]+", text):
        line = re.sub(r"\s+", " ", raw).strip()
        key = line.lower()
        if _line_is_noise(line, key in repeated_lines):
            continue
        kept.append(line)
    if not kept:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        kept = [p for p in paragraphs if not BOILERPLATE_RE.search(p)]
    return "\n".join(kept).strip()


def cleanse_pages(pages: List[Dict], query: str, llm=None) -> List[Dict]:
    """Очистить `body_text/html` от меню, футера, рекламы и служебных строк."""
    raw_texts = [_to_text(page) for page in pages or []]
    line_counts: Counter[str] = Counter()
    for text in raw_texts:
        seen = {re.sub(r"\s+", " ", ln).strip().lower() for ln in text.splitlines()}
        line_counts.update(k for k in seen if k)
    repeated = {line for line, count in line_counts.items() if count > 1 and len(line.split()) <= 8}
    cleaned: List[Dict] = []
    for page, text in zip(pages or [], raw_texts):
        item = dict(page)
        item["raw_body_text"] = item.get("body_text", "")
        item["body_text"] = _clean_text(text, repeated)
        item["word_count"] = len(item["body_text"].split())
        cleaned.append(item)
    return cleaned


def _empty_classification(skipped: bool = False) -> Dict:
    data = {key: [] for key in CLASS_KEYS}
    if skipped:
        data["llm_skipped"] = True
    return data


def classify_core(pages: List[Dict], query: str, llm: Optional[LLMClient] = None) -> Dict:
    """Классифицировать ядро SERP по методологии GIST-1."""
    llm = llm or LLMClient()
    corpus = "\n\n".join(
        f"URL: {p.get('url','')}\n{(p.get('body_text') or '')[:6000]}"
        for p in (pages or [])[:10]
    )
    try:
        raw = llm.complete(
            prompts.render(prompts.G1_5_CLEANSE, query=query, pages_corpus=corpus),
            temperature=0.2,
        )
        parsed = extract_first_json(raw)
        if not isinstance(parsed, dict):
            return _empty_classification(True)
        out = _empty_classification(False)
        for key in CLASS_KEYS:
            value = parsed.get(key) or []
            out[key] = value if isinstance(value, list) else [str(value)]
        return out
    except Exception as exc:
        logger.warning("M1.5 классификация ядра пропущена: %s", exc)
        return _empty_classification(True)


def run_cleansing(pages: List[Dict], query: str, llm: Optional[LLMClient] = None) -> Dict:
    """Выполнить очистку страниц и GIST-1 классификацию ядра."""
    cleaned = cleanse_pages(pages, query, llm)
    return {"pages": cleaned, "core_classification": classify_core(cleaned, query, llm)}
