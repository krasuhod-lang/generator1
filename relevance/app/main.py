"""FastAPI entrypoint for the Relevance Analyzer microservice.

POST /analyze
    body: { query, documents: [{url, html}], options? }
    auth: header X-Internal-Token must equal env RELEVANCE_INTERNAL_TOKEN
          (если переменная не задана — auth выключен, но в продакшене
          docker-compose всегда её прокидывает).

GET /health
    public, для healthcheck Docker / диагностики из Node-бэкенда.
"""

from __future__ import annotations

import logging
import os
import time
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from .bm25_calc import compute_vocabulary_bm25
from .cocoons import compute_cocoons
from .ngrams import compute_ngrams
from .normalizer import normalize_document
from .parser import extract_full_text

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("relevance")

APP_VERSION = "1.0.0"

app = FastAPI(
    title="Relevance Analyzer",
    version=APP_VERSION,
    description="Stateless calculator: HTML → BM25 vocabulary + n-grams.",
)


# ─── Auth ──────────────────────────────────────────────────────────────────────
def verify_internal_token(
    x_internal_token: Optional[str] = Header(default=None, alias="X-Internal-Token"),
) -> None:
    """Сверяет заголовок X-Internal-Token с env RELEVANCE_INTERNAL_TOKEN.
    Если переменная не задана — авторизация выключена (dev mode); в проде
    docker-compose обязан прокинуть ту же строку, что в Node-бэкенде.
    """
    expected = os.environ.get("RELEVANCE_INTERNAL_TOKEN", "").strip()
    if not expected:
        return
    if not x_internal_token or x_internal_token.strip() != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Token",
        )


# ─── Schemas ───────────────────────────────────────────────────────────────────
class DocumentIn(BaseModel):
    url: str
    html: str


class AnalyzeOptions(BaseModel):
    min_term_df: int = Field(default=2, ge=1, le=20)
    min_ngram_df: int = Field(default=3, ge=1, le=20)
    # Поднято с 500 до 5000 — заказчик: «не все LSI слова учитываются».
    # Теперь словарь не обрезается на сколько-нибудь содержательных корпусах.
    max_terms: int = Field(default=5000, ge=10, le=20000)
    # Поднято с 200 до 2000 — заказчик: «n-грамм надо собирать от 30 штук,
    # чем больше тем лучше».
    max_ngrams_per_type: int = Field(default=2000, ge=10, le=10000)
    # PR 2: если true — в ответе вернутся processed_documents (леммы +
    # POS-последовательности по каждому документу). Node-бэкенд кладёт
    # их в Redis с TTL, чтобы потом считать коконы без повторного парсинга.
    return_processed: bool = Field(default=False)


class AnalyzeRequest(BaseModel):
    query: str
    documents: List[DocumentIn]
    options: Optional[AnalyzeOptions] = None


class VocabRow(BaseModel):
    lemma: str
    df: int
    median_count: float
    bm25_score: float
    tf_idf_score: float = 0.0
    status: str


class NgramRow(BaseModel):
    phrase: str
    df: int
    median_count: float
    type: str
    pos_pattern: str


class ProcessedDocument(BaseModel):
    """Лёгкое представление документа после парсинга и нормализации.
    Используется как payload для последующего расчёта коконов."""
    url: str
    lemmas: List[str]
    pos_seq: List[List[str]]  # список пар [lemma, pos], сериализуется компактнее, чем dict


class AnalyzeStats(BaseModel):
    doc_count: int
    parsed_doc_count: int
    total_tokens: int
    avg_doc_length: float
    vocab_size: int
    ngrams_count: int
    duration_ms: int


class AnalyzeResponse(BaseModel):
    stats: AnalyzeStats
    vocabulary: List[VocabRow]
    ngrams: List[NgramRow]
    processed_documents: Optional[List[ProcessedDocument]] = None


# ── Cocoons (PR 2) ────────────────────────────────────────────────────────────
class ProcessedDocumentIn(BaseModel):
    url: str
    lemmas: List[str]


class CocoonsOptions(BaseModel):
    n_topics: int = Field(default=8, ge=2, le=32)
    top_terms: int = Field(default=12, ge=3, le=50)
    top_documents: int = Field(default=5, ge=1, le=20)


class CocoonsRequest(BaseModel):
    documents: List[ProcessedDocumentIn]
    options: Optional[CocoonsOptions] = None


class CocoonTerm(BaseModel):
    lemma: str
    weight: float


class CocoonDocument(BaseModel):
    url: str
    score: float


class CocoonTopic(BaseModel):
    id: int
    label: str
    explained_variance: float
    terms: List[CocoonTerm]
    top_documents: List[CocoonDocument]


class CocoonsStats(BaseModel):
    doc_count: int
    n_topics_requested: int
    n_topics_actual: int
    vocab_size: int
    skipped_too_short: int
    total_explained_variance: float = 0.0
    duration_ms: int


class CocoonsResponse(BaseModel):
    topics: List[CocoonTopic]
    stats: CocoonsStats


# ─── Routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "version": APP_VERSION,
        "auth_required": bool(os.environ.get("RELEVANCE_INTERNAL_TOKEN", "").strip()),
    }


@app.post("/analyze", response_model=AnalyzeResponse, dependencies=[Depends(verify_internal_token)])
def analyze(payload: AnalyzeRequest) -> AnalyzeResponse:
    started = time.perf_counter()
    opts = payload.options or AnalyzeOptions()

    logger.info(
        "analyze: query=%r docs=%d", payload.query[:80], len(payload.documents),
    )

    # Шаг 1. Парсим каждый документ → текст.
    doc_texts: List[str] = []
    for d in payload.documents:
        try:
            doc_texts.append(extract_full_text(d.html))
        except Exception as e:  # pragma: no cover — readability/lxml краевые случаи
            logger.warning("parser failed for %s: %s", d.url, e)
            doc_texts.append("")

    # Шаг 2. Нормализуем — леммы + (lemma, pos) для n-грамм.
    doc_lemmas: List[List[str]] = []
    doc_seqs = []
    for txt in doc_texts:
        lemmas, seq = normalize_document(txt)
        doc_lemmas.append(lemmas)
        doc_seqs.append(seq)

    parsed_doc_count = sum(1 for d in doc_lemmas if d)
    total_tokens = sum(len(d) for d in doc_lemmas)
    avg_len = (total_tokens / parsed_doc_count) if parsed_doc_count else 0.0

    # Шаг 3. BM25 по словарю.
    vocabulary = compute_vocabulary_bm25(
        [d for d in doc_lemmas if d],
        min_df=opts.min_term_df,
        max_terms=opts.max_terms,
    )

    # Шаг 4. N-граммы.
    ngrams = compute_ngrams(
        [s for s, d in zip(doc_seqs, doc_lemmas) if d],
        min_df=opts.min_ngram_df,
        max_per_type=opts.max_ngrams_per_type,
    )

    duration_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "analyze done: parsed=%d/%d vocab=%d ngrams=%d in %dms",
        parsed_doc_count, len(payload.documents), len(vocabulary), len(ngrams), duration_ms,
    )

    processed_out: Optional[List[ProcessedDocument]] = None
    if opts.return_processed:
        # Сериализуем seq как [[lemma, pos], ...] — компактнее, чем dict.
        processed_out = []
        for d, lemmas, seq in zip(payload.documents, doc_lemmas, doc_seqs):
            if not lemmas:
                continue
            processed_out.append(ProcessedDocument(
                url=d.url,
                lemmas=lemmas,
                pos_seq=[[lemma, pos] for (lemma, pos) in seq],
            ))

    return AnalyzeResponse(
        stats=AnalyzeStats(
            doc_count=len(payload.documents),
            parsed_doc_count=parsed_doc_count,
            total_tokens=total_tokens,
            avg_doc_length=round(avg_len, 2),
            vocab_size=len(vocabulary),
            ngrams_count=len(ngrams),
            duration_ms=duration_ms,
        ),
        vocabulary=[VocabRow(**v) for v in vocabulary],
        ngrams=[NgramRow(**n) for n in ngrams],
        processed_documents=processed_out,
    )


@app.post("/cocoons", response_model=CocoonsResponse, dependencies=[Depends(verify_internal_token)])
def cocoons(payload: CocoonsRequest) -> CocoonsResponse:
    """Расчёт «семантических коконов» через Truncated SVD.

    Принимает уже processed-документы (сделанные предыдущим вызовом
    /analyze с return_processed=true и закэшированные в Redis на стороне
    Node-бэкенда) — это позволяет не парсить ТОП-20 повторно.
    """
    started = time.perf_counter()
    opts = payload.options or CocoonsOptions()

    logger.info("cocoons: docs=%d n_topics=%d", len(payload.documents), opts.n_topics)

    result = compute_cocoons(
        [{"url": d.url, "lemmas": d.lemmas} for d in payload.documents],
        n_topics=opts.n_topics,
        top_terms=opts.top_terms,
        top_documents=opts.top_documents,
    )

    duration_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "cocoons done: topics=%d (req=%d) vocab=%d in %dms",
        result["stats"]["n_topics_actual"], opts.n_topics,
        result["stats"]["vocab_size"], duration_ms,
    )

    stats = {**result["stats"], "duration_ms": duration_ms}
    return CocoonsResponse(
        topics=[CocoonTopic(**t) for t in result["topics"]],
        stats=CocoonsStats(**stats),
    )
