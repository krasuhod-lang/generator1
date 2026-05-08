"""SERP-evidence extractor.

Поверх уже существующего стека (parser.py + normalizer.py + bm25_calc.py)
строит «evidence-снимок» по ТОПу выдачи Яндекса:

    POST /evidence
        body: { query, documents:[{url, html, published_at?}], options? }

    Ответ:
        { evidence: [
            {
              url, h1, published_at,
              text_chars, parsed_method, empty_reason,
              snippets: [
                { text, score, position }   # top-K параграфов BM25-ранжированных по query
              ]
            }, ...
          ],
          stats: { doc_count, snippet_count, duration_ms }
        }

Используется генератором инфо-статей как «фактологическая база» для writer'а
(Phase 1 / P0-2 grounding) и в дальнейшем — fact-check / антиплагиат.

Принципы:
  * Чистый CPU-расчёт. Ничего не сетевое. Контейнер уже умеет всё, что нужно
    (lxml, bs4, pymorphy3, rank_bm25).
  * Параграфы = блоки текста, которые `parser.extract_with_diagnostics`
    уже выделил как «контентные» (heavy_bs4 / trafilatura / readability).
    Это даёт нам тот же результат, который видит пользователь в обычном
    /analyze, без дублирования логики.
  * Скоринг = BM25Okapi по корпусу из параграфов одного документа против
    запроса в виде леммы-токенов.  Документ = много коротких документов
    (для BM25); это стандартный приём (paragraph-level retrieval), который
    даёт более точные сниппеты, чем ранжирование документов целиком.
  * Если у документа < 2 пригодных параграфов — берём всё, что есть.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

from rank_bm25 import BM25Okapi

from .normalizer import normalize_document, tokenize, lemmatize_with_pos
from .parser import extract_with_diagnostics, _make_soup


# ── Параметры по умолчанию (env override на стороне Node-бэкенда) ────────

DEFAULT_TOP_K = 5
DEFAULT_MAX_CHARS_PER_URL = 2000
MIN_PARAGRAPH_CHARS = 80          # короче — обычно подпись, breadcrumb, кнопка
MAX_PARAGRAPH_CHARS = 1200        # длиннее — режем, чтобы 1 сниппет не съел квоту
HARD_TOP_K_LIMIT = 20             # защита от пользователя, выставившего top_k=10000
HARD_MAX_CHARS_LIMIT = 20_000     # на один документ; выше — нет смысла для writer-context


# ── Внутренние структуры ─────────────────────────────────────────────────

@dataclass
class Snippet:
    text: str
    score: float
    position: int   # порядковый номер параграфа в документе (для прозрачности)

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "score": round(float(self.score), 4),
            "position": int(self.position),
        }


# ── Хелперы ──────────────────────────────────────────────────────────────

_WS_RE = re.compile(r"\s+")


def _normalize_query_to_lemmas(query: str) -> List[str]:
    """Запрос → список лемм (тот же стек, что и для документов).

    BM25 для русского без лемматизации почти бесполезен — «насос» и «насосы»
    были бы разными term'ами.
    """
    if not query:
        return []
    lemmas: List[str] = []
    for tok in tokenize(query):
        lemma, _pos = lemmatize_with_pos(tok)
        if lemma:
            lemmas.append(lemma)
    return lemmas


def _split_paragraph(block: str) -> List[str]:
    """Длинный блок (часто <li> или цельный <p> с обзором) разрезаем на
    более короткие куски по предложениям, чтобы BM25 мог различать их."""
    text = _WS_RE.sub(" ", block).strip()
    if not text:
        return []
    if len(text) <= MAX_PARAGRAPH_CHARS:
        return [text]
    # Жадная упаковка по границам предложений (.!?…) — лучше, чем рубить
    # по середине слова.
    parts: List[str] = []
    cur = []
    cur_len = 0
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        if cur_len + len(s) + 1 > MAX_PARAGRAPH_CHARS and cur:
            parts.append(" ".join(cur))
            cur = [s]
            cur_len = len(s)
        else:
            cur.append(s)
            cur_len += len(s) + 1
    if cur:
        parts.append(" ".join(cur))
    return parts or [text[:MAX_PARAGRAPH_CHARS]]


def _candidate_paragraphs(blocks: List[str]) -> List[str]:
    """Из текстовых блоков парсера готовим список параграфов-кандидатов.

    Отбрасываем слишком короткие, режем слишком длинные, схлопываем
    дубликаты (часто появляются после readability-fallback).
    """
    seen: set = set()
    out: List[str] = []
    for b in blocks or []:
        for piece in _split_paragraph(b):
            if len(piece) < MIN_PARAGRAPH_CHARS:
                continue
            key = piece[:200].lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(piece)
    return out


def _score_paragraphs(query_lemmas: List[str], paragraphs: List[str]) -> List[float]:
    """BM25Okapi(paragraphs).get_scores(query_lemmas) → выравненный список scores.

    Каждый параграф = «документ» в терминах BM25. Это paragraph-level
    retrieval — стандартный приём в RAG-системах.
    """
    if not paragraphs or not query_lemmas:
        return [0.0] * len(paragraphs)

    para_lemmas: List[List[str]] = []
    for p in paragraphs:
        lemmas, _seq = normalize_document(p)
        # Если параграф вообще без лемм (только цифры/пунктуация) — не падаем,
        # просто получит score=0.
        para_lemmas.append(lemmas or [""])

    bm25 = BM25Okapi(para_lemmas)
    raw = bm25.get_scores(query_lemmas)
    # numpy-array → python floats (для JSON-сериализации в FastAPI)
    return [float(x) for x in raw]


def _select_topk(
    paragraphs: List[str],
    scores: List[float],
    top_k: int,
    max_chars: int,
) -> List[Snippet]:
    """Берём top-K по убыванию score, но обрезаем по суммарной квоте символов.

    Сниппеты идут в writer-промт; для 5–10 URL это десятки тысяч токенов,
    поэтому квота критична. Если все scores=0 (например query.lemmas пуст)
    — берём первые параграфы по порядку (они обычно intro/lead).
    """
    if not paragraphs:
        return []
    indexed = list(enumerate(paragraphs))
    if any(s > 0 for s in scores):
        # Сортировка по убыванию score; при равенстве — по позиции (раньше = лучше).
        indexed.sort(key=lambda it: (-scores[it[0]], it[0]))
    # else: оставляем порядок документа.

    out: List[Snippet] = []
    used = 0
    for orig_idx, text in indexed:
        if len(out) >= top_k:
            break
        if used + len(text) > max_chars and out:
            # Уже что-то набрали — нет смысла пихать ещё, даже если top_k
            # позволяет: writer-промт раздуется без пользы.
            break
        out.append(Snippet(text=text, score=scores[orig_idx], position=orig_idx))
        used += len(text)
    return out


# ── Public API ──────────────────────────────────────────────────────────

def extract_evidence_for_document(
    *,
    html: str,
    query_lemmas: List[str],
    top_k: int = DEFAULT_TOP_K,
    max_chars: int = DEFAULT_MAX_CHARS_PER_URL,
) -> dict:
    """Возвращает evidence-блок одного документа.

    Все параметры — keyword-only, чтобы не путаться при вызове из main.py.
    Не выбрасывает исключений: при сбое парсера возвращает empty-структуру
    с empty_reason, чтобы вызывающий код мог это залогировать, но не упасть.
    """
    top_k = max(1, min(int(top_k or DEFAULT_TOP_K), HARD_TOP_K_LIMIT))
    max_chars = max(200, min(int(max_chars or DEFAULT_MAX_CHARS_PER_URL), HARD_MAX_CHARS_LIMIT))

    try:
        pr = extract_with_diagnostics(html or "")
    except Exception as exc:  # pragma: no cover — парсер по контракту не падает, но защитимся
        return {
            "h1": "",
            "text_chars": 0,
            "parsed_method": "none",
            "empty_reason": f"parser_exception:{type(exc).__name__}",
            "snippets": [],
        }

    h1 = ""
    try:
        soup = _make_soup(html or "")
        h1_tag = soup.find("h1") if soup else None
        if h1_tag is not None:
            raw = h1_tag.get_text(separator=" ", strip=True)
            h1 = _WS_RE.sub(" ", raw).strip()[:300]
    except Exception:  # pragma: no cover
        h1 = ""

    paragraphs = _candidate_paragraphs(pr.blocks)
    scores = _score_paragraphs(query_lemmas, paragraphs)
    snippets = _select_topk(paragraphs, scores, top_k=top_k, max_chars=max_chars)

    return {
        "h1": h1,
        "text_chars": int(pr.diagnostics.text_chars or 0),
        "parsed_method": pr.diagnostics.method or "none",
        "empty_reason": pr.diagnostics.empty_reason,
        "snippets": [s.to_dict() for s in snippets],
    }


__all__ = [
    "DEFAULT_TOP_K",
    "DEFAULT_MAX_CHARS_PER_URL",
    "MIN_PARAGRAPH_CHARS",
    "MAX_PARAGRAPH_CHARS",
    "HARD_TOP_K_LIMIT",
    "HARD_MAX_CHARS_LIMIT",
    "extract_evidence_for_document",
    "_normalize_query_to_lemmas",
    "_candidate_paragraphs",
    "_split_paragraph",
]
