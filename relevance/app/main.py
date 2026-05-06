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
import statistics
import time
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from .bm25_calc import compute_vocabulary_bm25
from .cocoons import compute_cocoons
from .comparison import compute_comparison, per_competitor_table
from .ngrams import compute_ngrams
from .normalizer import normalize_document
from .parser import ParseDiagnostics, ParseResult, extract_with_diagnostics

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
    # Если true — корпус ТОПа дополнительно анализируется ещё раз ТОЛЬКО
    # по anchor-text (тексту внутри `<a>` основного контента) — получаем
    # «анкорный профиль ниши» как доп. секцию ответа.
    include_anchor_zone: bool = Field(default=False)
    # Если true — дополнительно собираем «теговую зону» (header/footer/nav/
    # aside + class-хинты типа .menu/.navbar/.site-header/.footer) и
    # считаем по ней отдельный BM25-словарь tag_zone_vocabulary. Это
    # «сквозное меню» сайта — что конкуренты выводят в шапке/подвале.
    include_tag_zone: bool = Field(default=False)
    # Если true — собираем заголовки h2..h6 каждого документа и в ответе
    # вернём headings_per_doc + headings_intersection (фразы, встретившиеся
    # у ≥ headings_intersection_min_share_pct % сайтов). Используется для
    # рекомендаций «какие разделы стоит завести в статье».
    include_headings: bool = Field(default=False)
    headings_intersection_min_share_pct: float = Field(default=20.0, ge=1.0, le=100.0)
    # Если true — в diagnostics каждого документа добавляется превью
    # очищенного парсером текста (до preview_chars символов). Нужно для
    # UI-кнопки «что собрал парсер».
    include_parsed_preview: bool = Field(default=False)
    parsed_preview_chars: int = Field(default=20000, ge=500, le=200000)


class AnchorDocumentIn(BaseModel):
    """Опциональный «наш сайт» — обрабатывается так же, как ТОП-документ,
    но НЕ участвует в IDF/медианах конкурентов (иначе бы размыл статистику).
    Возвращается в ответе отдельным блоком our_document_metrics."""
    url: str
    html: str


class AnalyzeRequest(BaseModel):
    query: str
    documents: List[DocumentIn]
    our_document: Optional[AnchorDocumentIn] = None
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
    df_share_pct: float = 0.0
    median_count: float
    type: str
    pos_pattern: str


class ProcessedDocument(BaseModel):
    """Лёгкое представление документа после парсинга и нормализации.
    Используется как payload для последующего расчёта коконов."""
    url: str
    lemmas: List[str]
    pos_seq: List[List[str]]  # список пар [lemma, pos], сериализуется компактнее, чем dict
    # Леммы «теговой зоны» (шапка/подвал/меню), если include_tag_zone=true.
    # Используются для сравнения нашего сайта с конкурентами по сквозному меню.
    tag_zone_lemmas: List[str] = Field(default_factory=list)


class AnalyzeStats(BaseModel):
    doc_count: int
    parsed_doc_count: int
    total_tokens: int
    avg_doc_length: float
    vocab_size: int
    ngrams_count: int
    duration_ms: int
    # Новые медианы по корпусу — для сравнения «наш сайт vs ТОП».
    median_text_chars: float = 0.0
    median_html_chars: float = 0.0
    median_text_html_ratio: float = 0.0


class DocumentDiagnostics(BaseModel):
    """Метрики одного документа — попадают в ответе под ключом
    `document_diagnostics`. Помогают оператору сразу видеть, какие
    страницы скачались, но дали мусор / SPA / WAF-заглушку."""
    url: str
    method: str
    text_chars: int
    word_count: int = 0
    html_chars: int
    text_html_ratio: float
    block_count: int
    anchor_text_chars: int
    link_density: float
    empty_reason: Optional[str] = None
    lemma_count: int = 0
    candidates: Dict[str, int] = Field(default_factory=dict)
    # Превью того, что вытащил парсер (для UI-кнопки «что собрал парсер»).
    # Включается опцией include_parsed_preview=true. Может быть None.
    parsed_preview: Optional[str] = None
    # Сколько символов теговой зоны (header/footer/nav) у этого документа
    # — чтобы пользователь видел, насколько «жирная» шапка/подвал.
    tag_zone_chars: int = 0
    # Заголовки h2..h6 (если include_headings=true).
    headings: Optional[List[Dict]] = None


class OurDocumentMetrics(BaseModel):
    """Метрики нашего документа отдельно (не участвует в IDF корпуса)."""
    url: str
    diagnostics: DocumentDiagnostics
    lemmas: List[str] = Field(default_factory=list)
    comparison: Optional[dict] = None
    competitor_table: Optional[List[dict]] = None


class AnchorZoneRow(BaseModel):
    lemma: str
    df: int
    median_count: float
    bm25_score: float
    tf_idf_score: float = 0.0
    status: str


# Алиас типа для строки tag_zone-словаря — структура совпадает с anchor.
TagZoneRow = AnchorZoneRow


class HeadingIntersectionRow(BaseModel):
    """Заголовок, встретившийся у нескольких конкурентов. Используется
    для рекомендаций «какие разделы стоит завести в статье»."""
    text: str          # канонический текст (lower, схлопнутые пробелы)
    sample: str        # один из реальных вариантов (для UI — c регистром)
    df: int            # на скольких сайтах встретился
    df_share_pct: float
    levels: List[str]  # на каких уровнях встречался: ['h2','h3', ...]


class AnalyzeResponse(BaseModel):
    stats: AnalyzeStats
    vocabulary: List[VocabRow]
    ngrams: List[NgramRow]
    processed_documents: Optional[List[ProcessedDocument]] = None
    document_diagnostics: Optional[List[DocumentDiagnostics]] = None
    anchor_zone_vocabulary: Optional[List[AnchorZoneRow]] = None
    tag_zone_vocabulary: Optional[List[TagZoneRow]] = None
    headings_intersection: Optional[List[HeadingIntersectionRow]] = None
    our_document: Optional[OurDocumentMetrics] = None


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
        "analyze: query=%r docs=%d our=%s",
        payload.query[:80], len(payload.documents),
        bool(payload.our_document),
    )

    # Шаг 1. Парсим каждый документ → текст + диагностика + анкор-текст.
    parse_results = []   # list of (doc, ParseResult)
    for d in payload.documents:
        try:
            pr = extract_with_diagnostics(d.html)
        except Exception as e:  # pragma: no cover — readability/lxml краевые случаи
            logger.warning("parser failed for %s: %s", d.url, e)
            pr = ParseResult(blocks=[], diagnostics=ParseDiagnostics(empty_reason="parser_exception"), anchor_text="")
        parse_results.append((d, pr))

    # Шаг 2. Нормализуем — леммы + (lemma, pos) для n-грамм.
    doc_lemmas: List[List[str]] = []
    doc_seqs = []
    anchor_lemmas: List[List[str]] = []
    tag_zone_lemmas: List[List[str]] = []
    diagnostics: List[DocumentDiagnostics] = []
    text_chars_list: List[int] = []
    html_chars_list: List[int] = []

    for d, pr in parse_results:
        lemmas, seq = normalize_document(pr.text)
        doc_lemmas.append(lemmas)
        doc_seqs.append(seq)

        # Anchor-zone: отдельный мини-корпус из текста <a> того же документа.
        if opts.include_anchor_zone:
            a_lemmas, _ = normalize_document(pr.anchor_text)
            anchor_lemmas.append(a_lemmas)

        # Tag-zone (header/footer/nav/menu) — отдельный мини-корпус по
        # «сквозной» зоне сайта (см. extract_tag_zone_text в parser.py).
        if opts.include_tag_zone:
            tz_lemmas, _ = normalize_document(pr.tag_zone_text)
            tag_zone_lemmas.append(tz_lemmas)

        diag = pr.diagnostics
        text_chars_list.append(diag.text_chars)
        html_chars_list.append(diag.html_chars)

        # Превью текста (для UI-кнопки «что собрал парсер») — по запросу.
        parsed_preview: Optional[str] = None
        if opts.include_parsed_preview:
            full = pr.text or ""
            parsed_preview = full[: opts.parsed_preview_chars]

        diagnostics.append(DocumentDiagnostics(
            url=d.url,
            method=diag.method,
            text_chars=diag.text_chars,
            word_count=diag.word_count,
            html_chars=diag.html_chars,
            text_html_ratio=diag.text_html_ratio,
            block_count=diag.block_count,
            anchor_text_chars=diag.anchor_text_chars,
            link_density=diag.link_density,
            empty_reason=diag.empty_reason,
            lemma_count=len(lemmas),
            candidates=diag.candidates,
            parsed_preview=parsed_preview,
            tag_zone_chars=len(pr.tag_zone_text or ""),
            headings=(pr.headings if opts.include_headings else None),
        ))

    parsed_doc_count = sum(1 for d in doc_lemmas if d)
    total_tokens = sum(len(d) for d in doc_lemmas)
    avg_len = (total_tokens / parsed_doc_count) if parsed_doc_count else 0.0

    median_text_chars = float(statistics.median(text_chars_list)) if text_chars_list else 0.0
    median_html_chars = float(statistics.median(html_chars_list)) if html_chars_list else 0.0
    ratios = [
        (t / max(h, 1))
        for t, h in zip(text_chars_list, html_chars_list)
        if t > 0
    ]
    median_text_html_ratio = float(statistics.median(ratios)) if ratios else 0.0

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

    # Шаг 4b. Anchor-zone vocabulary (опционально) — отдельный BM25 корпус
    # на текстах внутри `<a>` основного контента. Это «анкорный профиль» ниши.
    anchor_zone_vocab: Optional[List[AnchorZoneRow]] = None
    if opts.include_anchor_zone:
        a_corpus = [a for a in anchor_lemmas if a]
        if a_corpus:
            a_vocab = compute_vocabulary_bm25(
                a_corpus,
                # Анкоров мало — снижаем порог, иначе всё уйдёт в null.
                min_df=max(1, opts.min_term_df - 1),
                max_terms=min(1000, opts.max_terms),
            )
            anchor_zone_vocab = [AnchorZoneRow(**v) for v in a_vocab]

    # Шаг 4c. Tag-zone vocabulary (опционально) — отдельный BM25 по
    # «теговой зоне» (header/footer/nav/aside + class/id-хинты). Заказчик:
    # «надо учитывать сквозное меню».
    tag_zone_vocab: Optional[List[TagZoneRow]] = None
    if opts.include_tag_zone:
        tz_corpus = [a for a in tag_zone_lemmas if a]
        if tz_corpus:
            tz_vocab = compute_vocabulary_bm25(
                tz_corpus,
                # Tag-zone обычно короткая — снижаем min_df.
                min_df=max(1, opts.min_term_df - 1),
                max_terms=min(1000, opts.max_terms),
            )
            tag_zone_vocab = [TagZoneRow(**v) for v in tz_vocab]

    # Шаг 4d. Headings intersection (опционально) — какие h2..h6 фразы
    # встречаются у нескольких сайтов. Используется для рекомендаций
    # «какие разделы стоит завести в статье».
    headings_intersection: Optional[List[HeadingIntersectionRow]] = None
    if opts.include_headings:
        # Нормализация: lower, схлопываем пробелы; считаем df по канон-форме.
        from collections import defaultdict
        bucket: Dict[str, dict] = defaultdict(lambda: {
            "df_set": set(),     # уникальные хосты, чтобы 5 заголовков с
                                  # одного сайта не давали df=5
            "samples": [],
            "levels": set(),
        })
        for d, pr in parse_results:
            host = ""
            try:
                from urllib.parse import urlparse
                host = urlparse(d.url).hostname or d.url
            except Exception:
                host = d.url
            seen_in_doc = set()
            for h in (pr.headings or []):
                raw = (h.get("text") or "").strip()
                canon = " ".join(raw.lower().split())
                if not canon or canon in seen_in_doc:
                    continue
                seen_in_doc.add(canon)
                b = bucket[canon]
                b["df_set"].add(host)
                if len(b["samples"]) < 3:
                    b["samples"].append(raw)
                lvl = h.get("level")
                if lvl:
                    b["levels"].add(str(lvl).lower())
        n_docs_h = len(parse_results) or 1
        threshold_share = float(opts.headings_intersection_min_share_pct)
        rows: List[dict] = []
        for canon, b in bucket.items():
            df = len(b["df_set"])
            share = 100.0 * df / n_docs_h
            if share < threshold_share:
                continue
            rows.append({
                "text":   canon,
                "sample": (b["samples"][0] if b["samples"] else canon),
                "df":     df,
                "df_share_pct": round(share, 1),
                "levels": sorted(b["levels"]),
            })
        # Сортируем: чем больше df, тем выше; затем по длине (длинные ≈ информативнее).
        rows.sort(key=lambda r: (r["df"], len(r["text"])), reverse=True)
        headings_intersection = [HeadingIntersectionRow(**r) for r in rows[:200]]

    # Шаг 5. Наш документ — обрабатываем тем же стеком, но не подмешиваем
    # его в IDF/медианы корпуса (иначе бы исказил статистику).
    our_metrics: Optional[OurDocumentMetrics] = None
    if payload.our_document:
        try:
            our_pr = extract_with_diagnostics(payload.our_document.html)
        except Exception as e:
            logger.warning("our_document parser failed: %s", e)
            our_pr = ParseResult(blocks=[], diagnostics=ParseDiagnostics(empty_reason="parser_exception"), anchor_text="")
        our_lemmas, _our_seq = normalize_document(our_pr.text)
        our_diag = DocumentDiagnostics(
            url=payload.our_document.url,
            method=our_pr.diagnostics.method,
            text_chars=our_pr.diagnostics.text_chars,
            word_count=our_pr.diagnostics.word_count,
            html_chars=our_pr.diagnostics.html_chars,
            text_html_ratio=our_pr.diagnostics.text_html_ratio,
            block_count=our_pr.diagnostics.block_count,
            anchor_text_chars=our_pr.diagnostics.anchor_text_chars,
            link_density=our_pr.diagnostics.link_density,
            empty_reason=our_pr.diagnostics.empty_reason,
            lemma_count=len(our_lemmas),
            candidates=our_pr.diagnostics.candidates,
        )
        comparison = None
        comp_table = None
        corpus = [d for d in doc_lemmas if d]
        if our_lemmas and corpus and vocabulary:
            try:
                comparison = compute_comparison(
                    our_lemmas=our_lemmas,
                    vocabulary=vocabulary,
                    ngrams=ngrams,
                    corpus_lemmas=corpus,
                    our_text_chars=our_pr.diagnostics.text_chars,
                    our_html_chars=our_pr.diagnostics.html_chars,
                    median_text_chars=median_text_chars,
                    median_html_chars=median_html_chars,
                )
                comp_table = per_competitor_table(
                    competitors=[
                        {"url": d.url, "lemmas": doc_lemmas[i]}
                        for i, (d, _) in enumerate(parse_results)
                        if doc_lemmas[i]
                    ],
                    vocabulary=vocabulary,
                    corpus_lemmas=corpus,
                    our_doc={"url": payload.our_document.url, "lemmas": our_lemmas},
                    text_chars_by_url={
                        d.url: parse_results[i][1].diagnostics.text_chars
                        for i, (d, _) in enumerate(parse_results)
                        if doc_lemmas[i]
                    },
                    word_count_by_url={
                        d.url: parse_results[i][1].diagnostics.word_count
                        for i, (d, _) in enumerate(parse_results)
                        if doc_lemmas[i]
                    },
                    our_text_chars=our_pr.diagnostics.text_chars,
                    our_word_count=our_pr.diagnostics.word_count,
                )
            except Exception as e:
                logger.warning("comparison failed: %s", e)
                comparison = {"error": str(e)[:300]}
        our_metrics = OurDocumentMetrics(
            url=payload.our_document.url,
            diagnostics=our_diag,
            lemmas=our_lemmas,
            comparison=comparison,
            competitor_table=comp_table,
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
        # Если include_tag_zone=true — индексом доступно tag_zone_lemmas[i].
        for i, (d, lemmas, seq) in enumerate(zip(payload.documents, doc_lemmas, doc_seqs)):
            if not lemmas:
                continue
            tz = []
            if opts.include_tag_zone and i < len(tag_zone_lemmas):
                tz = tag_zone_lemmas[i] or []
            processed_out.append(ProcessedDocument(
                url=d.url,
                lemmas=lemmas,
                pos_seq=[[lemma, pos] for (lemma, pos) in seq],
                tag_zone_lemmas=tz,
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
            median_text_chars=round(median_text_chars, 1),
            median_html_chars=round(median_html_chars, 1),
            median_text_html_ratio=round(median_text_html_ratio, 4),
        ),
        vocabulary=[VocabRow(**v) for v in vocabulary],
        ngrams=[NgramRow(**n) for n in ngrams],
        processed_documents=processed_out,
        document_diagnostics=diagnostics,
        anchor_zone_vocabulary=anchor_zone_vocab,
        tag_zone_vocabulary=tag_zone_vocab,
        headings_intersection=headings_intersection,
        our_document=our_metrics,
    )


# ── /compare ────────────────────────────────────────────────────────────────
class CompareRequest(BaseModel):
    """Standalone-расчёт сравнения для уже посчитанного отчёта.

    Используется, когда отчёт ТОПа уже сохранён, а пользователь хочет
    сравнить с другим URL без повторного парсинга 20 страниц.
    """
    our_lemmas: List[str]
    our_url: str = ""
    our_text_chars: int = 0
    our_html_chars: int = 0
    our_word_count: int = 0
    our_serp_position: Optional[int] = None
    median_text_chars: float = 0.0
    median_html_chars: float = 0.0
    vocabulary: List[VocabRow]
    ngrams: List[NgramRow] = Field(default_factory=list)
    corpus_lemmas: List[List[str]]
    competitor_urls: Optional[List[str]] = None
    # Параллельные competitor_urls списки метрик/позиций для прозрачности
    # в сравнительной таблице. Если длина не совпадает — поля игнорируем.
    competitor_text_chars: Optional[List[int]] = None
    competitor_word_counts: Optional[List[int]] = None
    competitor_serp_positions: Optional[List[Optional[int]]] = None


class CompareResponse(BaseModel):
    summary: dict
    per_term: List[dict]
    per_phrase: List[dict]
    directives: List[dict]
    competitor_table: Optional[List[dict]] = None


@app.post("/compare", response_model=CompareResponse, dependencies=[Depends(verify_internal_token)])
def compare(payload: CompareRequest) -> CompareResponse:
    """Чистый расчёт сравнения (без парсинга и нормализации).

    Принимает уже нормализованные леммы — нашего документа и каждого
    конкурента. Это даёт минимальный latency и позволяет переиспользовать
    кэш processed_documents (тот же, что для коконов)."""
    if not payload.vocabulary:
        raise HTTPException(status_code=400, detail="vocabulary is empty")
    if not payload.corpus_lemmas:
        raise HTTPException(status_code=400, detail="corpus_lemmas is empty")

    vocab_dicts = [v.model_dump() if hasattr(v, "model_dump") else dict(v) for v in payload.vocabulary]
    ngram_dicts = [n.model_dump() if hasattr(n, "model_dump") else dict(n) for n in payload.ngrams]

    started = time.perf_counter()
    cmp = compute_comparison(
        our_lemmas=payload.our_lemmas,
        vocabulary=vocab_dicts,
        ngrams=ngram_dicts,
        corpus_lemmas=payload.corpus_lemmas,
        our_text_chars=payload.our_text_chars,
        our_html_chars=payload.our_html_chars,
        median_text_chars=payload.median_text_chars,
        median_html_chars=payload.median_html_chars,
    )

    comp_table = None
    urls = payload.competitor_urls or []
    if urls and len(urls) == len(payload.corpus_lemmas):
        n = len(urls)

        def _aligned(arr: Optional[List]) -> Dict[str, object]:
            if not arr or len(arr) != n:
                return {}
            return {urls[i]: arr[i] for i in range(n)}

        text_chars_by_url = {k: int(v or 0) for k, v in _aligned(payload.competitor_text_chars).items()}
        word_count_by_url = {k: int(v or 0) for k, v in _aligned(payload.competitor_word_counts).items()}
        serp_position_by_url = {
            k: (int(v) if v is not None else None)
            for k, v in _aligned(payload.competitor_serp_positions).items()
        }

        comp_table = per_competitor_table(
            competitors=[{"url": u, "lemmas": l} for u, l in zip(urls, payload.corpus_lemmas)],
            vocabulary=vocab_dicts,
            corpus_lemmas=payload.corpus_lemmas,
            our_doc={"url": payload.our_url, "lemmas": payload.our_lemmas},
            text_chars_by_url=text_chars_by_url,
            word_count_by_url=word_count_by_url,
            serp_position_by_url=serp_position_by_url,
            our_text_chars=int(payload.our_text_chars or 0),
            our_word_count=int(payload.our_word_count or 0),
            our_serp_position=payload.our_serp_position,
        )

    logger.info(
        "compare done in %dms: lsi=%.1f%% bm25=%.3f cos=%.3f",
        int((time.perf_counter() - started) * 1000),
        cmp["summary"]["lsi_coverage_pct"],
        cmp["summary"]["bm25_score"],
        cmp["summary"]["tf_idf_cosine"],
    )

    return CompareResponse(
        summary=cmp["summary"],
        per_term=cmp["per_term"],
        per_phrase=cmp["per_phrase"],
        directives=cmp["directives"],
        competitor_table=comp_table,
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
