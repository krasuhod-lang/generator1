'use strict';

/**
 * Pipeline отчёта релевантности.
 *
 * Шаги:
 *   1. status='fetching' → XMLStock SERP (переиспользуем существующий клиент
 *      из meta-tags pipeline) → берём top_n URL.
 *   2. fetchPages(urls) — параллельная загрузка HTML.
 *   3. status='analyzing' → POST документов в Python-микросервис.
 *   4. status='done' / 'error' → запись report в БД.
 *
 * Ошибки fail-fast только на критическом отсутствии хотя бы одного успешно
 * скачанного URL и на отказе Python-сервиса. Частичные сбои (5 из 20 URL не
 * открылись) — НЕ ошибка, идут в failed_urls.
 */

const db = require('../../config/db');
const { fetchYandexSerp } = require('../metaTags/xmlstockClient');
const { fetchPages, fetchOne } = require('./pageFetcher');
const { analyze, compare }     = require('./pythonClient');
const rawStorage          = require('./rawStorage');
const { splitBySerp }     = require('./aggregatorDomains');

/**
 * Возвращает «канонический» хост для дедупликации SERP по домену.
 * Срезаем `www.` и приводим к нижнему регистру. Если URL невалидный —
 * возвращаем пустую строку, такие записи в дедупе не участвуют.
 */
function _canonicalHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

const MIN_FETCHED_FOR_ANALYZE = (() => {
  const v = parseInt(process.env.RELEVANCE_MIN_FETCHED, 10);
  return Number.isFinite(v) && v >= 1 ? v : 5;
})();

async function _setStage(reportId, stage, extra = {}) {
  const sets = ['current_stage = $2'];
  const params = [reportId, stage];
  let i = 3;
  if (extra.status) {
    sets.push(`status = $${i}::relevance_report_status`);
    params.push(extra.status);
    i += 1;
  }
  if (extra.fetched_count != null) {
    sets.push(`fetched_count = $${i}`);
    params.push(extra.fetched_count);
    i += 1;
  }
  if (extra.serp != null) {
    sets.push(`serp = $${i}::jsonb`);
    params.push(JSON.stringify(extra.serp));
    i += 1;
  }
  if (extra.failed_urls != null) {
    sets.push(`failed_urls = $${i}::jsonb`);
    params.push(JSON.stringify(extra.failed_urls));
    i += 1;
  }
  if (extra.started) {
    sets.push('started_at = NOW()');
  }
  await db.query(
    `UPDATE relevance_reports SET ${sets.join(', ')} WHERE id = $1`,
    params,
  );
}

async function _finishOk(reportId, report, durationMs, rawMeta, dbProcessed, extras = {}) {
  await db.query(
    `UPDATE relevance_reports
       SET status='done',
           current_stage='done',
           report = $2::jsonb,
           completed_at = NOW(),
           duration_ms = $3,
           raw_storage = $4,
           raw_expires_at = $5,
           raw_processed = $6::jsonb,
           our_report = $7::jsonb,
           comparison = $8::jsonb
     WHERE id = $1`,
    [
      reportId,
      JSON.stringify(report),
      durationMs,
      rawMeta?.stored ? 'redis' : 'none',
      rawMeta?.stored ? rawMeta.expiresAt : null,
      dbProcessed ? JSON.stringify(dbProcessed) : null,
      extras.our_report  ? JSON.stringify(extras.our_report)  : null,
      extras.comparison  ? JSON.stringify(extras.comparison)  : null,
    ],
  );
}

async function _finishError(reportId, message) {
  const safe = String(message || 'unknown error').slice(0, 1000);
  await db.query(
    `UPDATE relevance_reports
       SET status='error',
           current_stage='error',
           error_message = $2,
           completed_at = NOW()
     WHERE id = $1`,
    [reportId, safe],
  );
}

/**
 * Основной запуск пайплайна. Никогда не бросает наружу — всё ловит и
 * пишет error_message в БД.
 *
 * @param {string} reportId — UUID записи в relevance_reports.
 */
async function processRelevanceReport(reportId) {
  const t0 = Date.now();

  const { rows } = await db.query(
    `SELECT id, query, lr, top_n, our_url, exclude_aggregators
       FROM relevance_reports WHERE id = $1`,
    [reportId],
  );
  if (!rows.length) {
    console.error(`[relevance] report ${reportId} not found`);
    return;
  }
  const { query, lr, top_n: topN, our_url: ourUrl, exclude_aggregators: excludeAggregators } = rows[0];

  try {
    // ── 1. SERP ──────────────────────────────────────────────────────────
    await _setStage(reportId, 'serp', { status: 'fetching', started: true });

    const serpRaw = await fetchYandexSerp(query, { lr: lr || '', pages: 2 });
    // Нормализуем + дедуп по URL и по домену + берём top_n.
    // Заказчик: «парсим один домен; если на один домен несколько ссылок —
    // оставляем первую попавшуюся». Дедуп по домену работает ПОСЛЕ
    // дедупа по URL и ДО фильтра агрегаторов, чтобы экономить лимиты
    // парсинга на одинаковых доменах из выдачи Яндекса.
    const seen = new Set();
    const seenHosts = new Set();
    const skippedSameHost = [];
    const serp = [];
    for (const item of (serpRaw || [])) {
      const url = String(item.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const host = _canonicalHost(url);
      if (host && seenHosts.has(host)) {
        // Второй и далее URL того же домена — пропускаем, но фиксируем для
        // прозрачности в карточке отчёта (оператор видит «дубль домена,
        // оставлен первый из выдачи»).
        skippedSameHost.push({ url, host });
        continue;
      }
      if (host) seenHosts.add(host);
      serp.push({
        url,
        title:   String(item.title   || '').slice(0, 500),
        snippet: String(item.snippet || '').slice(0, 1000),
      });
      if (serp.length >= topN) break;
    }

    if (serp.length === 0) {
      throw new Error(
        `XMLStock не вернул ни одного URL для запроса «${query}» `
        + `(регион lr=${lr || '—'}). Проверьте лимиты ключа XMLStock и корректность запроса.`,
      );
    }

    // ── 1.5. Фильтр агрегаторов (опционально, по чекбоксу формы) ───────
    // Avito/hh/ozon/dzen/… занимают ТОП Яндекса почти всегда, но сами
    // никогда не «информационный конкурент» — их словарь («доставка /
    // отзыв / товар») размывает корпус. Отфильтровываем ДО парсинга, но
    // оставляем список removed в SERP-карточке для прозрачности.
    let removedAggregators = [];
    let serpForFetch = serp;
    if (excludeAggregators) {
      const split = splitBySerp(serp);
      removedAggregators = split.removed;
      serpForFetch = split.kept;
      if (serpForFetch.length === 0) {
        // На всякий случай: если после фильтра ничего не осталось — НЕ
        // падаем, продолжаем с исходным списком, но логируем warning.
        console.warn(
          `[relevance] aggregator filter оставил 0 URL для отчёта ${reportId}, `
          + `используем оригинальный SERP.`,
        );
        serpForFetch = serp;
        removedAggregators = [];
      }
    }
    await _setStage(reportId, 'fetching_pages', { serp });

    // ── 2. Скачивание HTML ───────────────────────────────────────────────
    const { successes, failures } = await fetchPages(serpForFetch.map((s) => s.url));
    await _setStage(reportId, 'analyzing', {
      status: 'analyzing',
      fetched_count: successes.length,
      failed_urls:   failures,
    });

    if (successes.length < MIN_FETCHED_FOR_ANALYZE) {
      throw new Error(
        `Удалось скачать только ${successes.length}/${serp.length} страниц `
        + `(минимум для анализа: ${MIN_FETCHED_FOR_ANALYZE}).`,
      );
    }

    // ── 3. Python-микросервис ────────────────────────────────────────────
    // return_processed=true — processed_documents пойдут в Redis с TTL.
    // include_anchor_zone=true — отдельно посчитаем «анкорный профиль» ниши
    //   (BM25 по текстам внутри `<a>` основного контента).
    // include_tag_zone=true — отдельный BM25 по «теговой зоне» (header/
    //   footer/nav + .menu/.navbar/...). Заказчик: «учитывать сквозное меню».
    // include_headings=true — соберём h2..h6 и пересечения для рекомендаций
    //   по структуре статьи.
    // include_parsed_preview=true — превью парсеннного текста для UI-кнопки
    //   «что собрал парсер» (ограничение по символам).
    const analysisResp = await analyze({
      query,
      documents: successes.map((s) => ({ url: s.url, html: s.html })),
      options: {
        return_processed: true,
        include_anchor_zone: true,
        include_tag_zone: true,
        include_headings: true,
        include_parsed_preview: true,
        // Wave 1: HTML-сигналы из утечек Google Content Warehouse / Yandex
        // (1922 факторов) — title/H1/meta-шаблон, schema.org-профиль, freshness,
        // URL/slug, trust-link density, anchor-bank, UX-профиль, exact-form
        // occurrences, host-hygiene. Доп. env-выключатель на стороне Python:
        // RELEVANCE_COMPETITOR_SIGNALS=false.
        include_competitor_signals: true,
        parsed_preview_chars: 20000,
      },
    });

    // ── 3.5. Складываем processed-доки в Redis (best-effort) и в Postgres ───
    // Redis — «горячий путь» для быстрых пересчётов; Postgres — гарантия,
    // что коконы будут работать всегда, даже без Redis или после истечения
    // TTL. В БД храним только леммы (без POS-последовательностей) — они
    // занимают на порядок меньше места и достаточны для TruncatedSVD.
    let rawMeta = { stored: false };
    let dbProcessed = null;
    const processed = Array.isArray(analysisResp?.processed_documents)
      ? analysisResp.processed_documents
      : [];
    if (processed.length > 0) {
      try {
        rawMeta = await rawStorage.saveRaw(reportId, processed);
      } catch (e) {
        // saveRaw сама ловит ошибки, но на всякий случай.
        console.warn('[relevance] saveRaw threw:', e.message);
      }
      // Компактный DB-fallback: оставляем только {url, lemmas}.
      dbProcessed = processed
        .filter((d) => Array.isArray(d?.lemmas) && d.lemmas.length > 0)
        .map((d) => ({
          url:    String(d.url || ''),
          lemmas: d.lemmas,
        }));
      if (dbProcessed.length === 0) dbProcessed = null;
    }

    // ── 4. Сохраняем отчёт ───────────────────────────────────────────────
    const fullReport = {
      query,
      lr: lr || '',
      generated_at: new Date().toISOString(),
      stats:      analysisResp?.stats      || {},
      vocabulary: Array.isArray(analysisResp?.vocabulary) ? analysisResp.vocabulary : [],
      ngrams:     Array.isArray(analysisResp?.ngrams)     ? analysisResp.ngrams     : [],
      // PR3: per-document diagnostics + anchor-zone vocabulary + filter info
      document_diagnostics: Array.isArray(analysisResp?.document_diagnostics)
        ? analysisResp.document_diagnostics : [],
      anchor_zone_vocabulary: Array.isArray(analysisResp?.anchor_zone_vocabulary)
        ? analysisResp.anchor_zone_vocabulary : [],
      // Новое: «теговая зона» (шапка/подвал/сквозное меню) + пересечения h2..h6.
      tag_zone_vocabulary: Array.isArray(analysisResp?.tag_zone_vocabulary)
        ? analysisResp.tag_zone_vocabulary : [],
      headings_intersection: Array.isArray(analysisResp?.headings_intersection)
        ? analysisResp.headings_intersection : [],
      // Wave 1 SEO-сигналы из утечек Google/Yandex (см. signals.py).
      // Может быть null, если опция выключена через env на стороне Python.
      competitor_signals: (analysisResp?.competitor_signals && typeof analysisResp.competitor_signals === 'object')
        ? analysisResp.competitor_signals
        : null,
      filter: {
        exclude_aggregators:  !!excludeAggregators,
        removed_aggregators:  removedAggregators,
        skipped_same_host:    skippedSameHost,
        serp_after_filter:    serpForFetch.length,
      },
      // Сводка причин fail'а — оператору сразу видно, где проблема.
      fail_breakdown: _summarizeFailures(failures),
    };

    // ── 5. Сравнение «наш сайт vs ТОП» (опционально, если задан our_url) ─
    let ourReport = null;
    let comparisonReport = null;
    if (ourUrl && (analysisResp?.vocabulary?.length || 0) > 0) {
      try {
        await _setStage(reportId, 'comparing');
        const ourResult = await _runComparison({
          ourUrl,
          analysisResp,
          processedDocs: Array.isArray(analysisResp?.processed_documents)
            ? analysisResp.processed_documents : [],
          serp,
          query,
        });
        ourReport       = ourResult.our_report;
        comparisonReport = ourResult.comparison;
      } catch (e) {
        // Мягкая ошибка: отчёт ТОПа всё равно сохраняем.
        console.warn('[relevance] comparison failed:', e.message);
        comparisonReport = { error: String(e.message || e).slice(0, 500) };
      }
    }

    await _finishOk(reportId, fullReport, Date.now() - t0, rawMeta, dbProcessed, {
      our_report: ourReport,
      comparison: comparisonReport,
    });
  } catch (err) {
    console.error(`[relevance] report ${reportId} failed:`, err.message);
    await _finishError(reportId, err.message);
  }
}

/** Группирует failures по category-code, чтобы оператор сразу видел распределение
 *  причин: `{http_403: 5, timeout: 3, empty_body: 2, dns: 1, unknown: 1}`.
 *  Это и есть «детальный лог по каждому failure», требуемый в плане работ. */
function _summarizeFailures(failures) {
  const breakdown = {};
  for (const f of (failures || [])) {
    const code = String(f?.code || 'unknown');
    breakdown[code] = (breakdown[code] || 0) + 1;
  }
  return breakdown;
}

/**
 * Качает наш URL тем же pageFetcher'ом, шлёт single-doc analyze, потом /compare
 * с уже посчитанным vocabulary ТОПа + леммами нашего документа.
 *
 * Все ошибки бросаются наружу — обёртка в processRelevanceReport ловит и
 * пишет comparison.error, не валя основной отчёт.
 */
async function _runComparison({ ourUrl, analysisResp, processedDocs, serp, query }) {
  // 1) Скачиваем нашу страницу — тем же fetcher'ом (cookie-jar, retry,
  //    headless-fallback). Если 0 страниц — бросаем понятную ошибку.
  const fetched = await fetchOne(ourUrl);
  if (!fetched || !fetched.html) {
    const err = new Error(
      `Не удалось загрузить наш URL: ${fetched?.error || 'unknown'}`,
    );
    err.code = fetched?.code;
    throw err;
  }

  // 2) Прогоняем парсер + нормализатор через single-doc analyze — это
  //    единственный способ получить леммы, не дублируя нормализатор в Node.
  //    Корпус НЕ передаём → analyze посчитает пустой словарь, но вернёт
  //    processed_documents с леммами нашего документа и diagnostics.
  //    include_tag_zone=true — нужен для сравнения «наш сайт vs ТОП»
  //    по сквозному меню (заказчик).
  const ourAnalyze = await analyze({
    // Передаём настоящий query, чтобы Wave 1 сигналы (exact-form occurrences,
    // title_query_*) считались относительно реальной выдачи, а не плейсхолдера.
    query: String(query || 'our_document_only'),
    documents: [{ url: ourUrl, html: fetched.html }],
    options: {
      return_processed: true,
      min_term_df: 1,
      min_ngram_df: 1,
      include_tag_zone: true,
      include_headings: true,
      include_parsed_preview: true,
      // Wave 1 сигналы и для нашего документа — UI показывает «наш сайт vs медиана топа».
      include_competitor_signals: true,
      parsed_preview_chars: 20000,
    },
  });

  const ourProcessed = (ourAnalyze?.processed_documents || [])[0];
  const ourLemmas    = Array.isArray(ourProcessed?.lemmas) ? ourProcessed.lemmas : [];
  const ourTagZoneLemmas = Array.isArray(ourProcessed?.tag_zone_lemmas)
    ? ourProcessed.tag_zone_lemmas : [];
  const ourDiag      = (ourAnalyze?.document_diagnostics || [])[0] || {};

  if (ourLemmas.length === 0) {
    throw new Error(
      `Парсер не вытащил из ${ourUrl} ни одного слова `
      + `(reason=${ourDiag.empty_reason || 'unknown'}, method=${ourDiag.method || 'none'})`,
    );
  }

  // 3) Собираем corpus_lemmas из processed_documents ТОПа (что уже посчитано).
  const corpusLemmas = (processedDocs || [])
    .map((d) => Array.isArray(d?.lemmas) ? d.lemmas : [])
    .filter((l) => l.length > 0);
  const corpusUrls = (processedDocs || [])
    .filter((d) => Array.isArray(d?.lemmas) && d.lemmas.length > 0)
    .map((d) => String(d?.url || ''));

  if (corpusLemmas.length === 0) {
    throw new Error('У ТОПа нет ни одного processed-документа для сравнения');
  }

  // 3.5) Выровненные параллельно corpusUrls массивы метрик из document_diagnostics
  //      ТОПа — нужны Python-сервису, чтобы отрисовать text_chars/word_count
  //      в сравнительной таблице без повторного парсинга. Также строим
  //      позиции в SERP по URL → 1-based индекс в исходной выдаче.
  const diagByUrl = new Map();
  for (const d of (analysisResp?.document_diagnostics || [])) {
    if (d && d.url) diagByUrl.set(String(d.url), d);
  }
  const serpPosByUrl = new Map();
  for (let i = 0; i < (serp || []).length; i++) {
    const u = String(serp[i]?.url || '');
    if (u && !serpPosByUrl.has(u)) serpPosByUrl.set(u, i + 1);
  }

  const competitorTextChars     = corpusUrls.map((u) => Number(diagByUrl.get(u)?.text_chars) || 0);
  const competitorWordCounts    = corpusUrls.map((u) => Number(diagByUrl.get(u)?.word_count) || 0);
  const competitorSerpPositions = corpusUrls.map((u) => serpPosByUrl.has(u) ? serpPosByUrl.get(u) : null);

  const ourSerpPosition = serpPosByUrl.has(String(ourUrl)) ? serpPosByUrl.get(String(ourUrl)) : null;

  // 4) Зовём /compare.
  const cmp = await compare({
    our_lemmas:        ourLemmas,
    our_url:           ourUrl,
    our_text_chars:    Number(ourDiag.text_chars) || 0,
    our_html_chars:    Number(ourDiag.html_chars) || 0,
    our_word_count:    Number(ourDiag.word_count) || 0,
    our_serp_position: ourSerpPosition,
    median_text_chars: Number(analysisResp?.stats?.median_text_chars) || 0,
    median_html_chars: Number(analysisResp?.stats?.median_html_chars) || 0,
    vocabulary:        analysisResp?.vocabulary || [],
    ngrams:            analysisResp?.ngrams     || [],
    corpus_lemmas:     corpusLemmas,
    competitor_urls:   corpusUrls,
    competitor_text_chars:     competitorTextChars,
    competitor_word_counts:    competitorWordCounts,
    competitor_serp_positions: competitorSerpPositions,
  });

  return {
    our_report: {
      url:         ourUrl,
      method:      fetched.method || 'axios',
      diagnostics: ourDiag,
      lemma_count: ourLemmas.length,
      // Леммы нашего сайта (для сравнения с tag_zone_vocabulary конкурентов
      // на стороне UI). Только уникальные — корпус с шапкой/подвалом обычно
      // 100–500 уникальных лемм, не больше нескольких КБ JSON.
      tag_zone_lemmas: Array.from(new Set(ourTagZoneLemmas)),
      // Wave 1 SEO-сигналы НАШЕГО документа (если Python-сервис их вернул).
      // Сравниваем на UI с фронтового competitor_signals.top_aggregate.
      competitor_signals: ((ourAnalyze?.competitor_signals?.per_url) || [])[0] || null,
    },
    comparison: cmp,
  };
}

module.exports = { processRelevanceReport };
