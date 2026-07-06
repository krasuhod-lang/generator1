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
const pageFetcher = require('./pageFetcher');
const { fetchPages, fetchOne } = pageFetcher;
const { analyze, compare }     = require('./pythonClient');
const rawStorage          = require('./rawStorage');
const { splitBySerp }     = require('./aggregatorDomains');
const aegisHooks          = require('./aegisHooks');
const { finalizeByTask }   = require('../aegis/backlogHooks');
const { createFunnelTracker } = require('../aegis/funnelTracker');

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
  // По умолчанию 3 (раньше было 5). Анализ по 3 точкам шумный, но
  // информативный — мы предпочитаем частичные данные с warning'ом, чем
  // фатальную ошибку «3/20» из-за WAF/SPA.
  return Number.isFinite(v) && v >= 1 ? v : 3;
})();

// Целевое число уникальных сайтов ПОСЛЕ dedup и фильтра агрегаторов. Ниже
// него мы делаем «добор» с доп. страниц SERP, пока не наберём ровно столько
// полезных URL. Порог динамический — равен `top_n` задачи (обычно 20), а не
// захардкоженному 18: цель ТЗ — выдать ровно top_n чистых сайтов, если они
// вообще есть в ТОП-100 Яндекса. Дефолт-фоллбек на случай кривого top_n.
const DEFAULT_SERP_TARGET = 20;
// До каких доп. страниц SERP добираем (XMLStock page index'ы; page=0 →
// поз.1-10). Добираем вплоть до 10-й страницы выдачи (page=9 → поз.91-100),
// останавливаясь раньше, как только набрали `top_n` уникальных сайтов.
// Один проход = +10 doc. [2..9] = страницы 3-10 SERP (позиции 21-100).
const SERP_TOPUP_PAGES = [2, 3, 4, 5, 6, 7, 8, 9];

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
  // SEO Relevance Analyzer 2.0 (Phase 1): сырую факторную матрицу храним
  // отдельной additive-колонкой (мигр. 099), чтобы пересчитывать корреляции
  // офлайн без повторного обхода SERP (§14). Колонка nullable — если
  // факторный слой выключен или столбца ещё нет (старый инстанс), пишем NULL
  // и не роняем сохранение отчёта.
  const factorMatrix = (report?.serp_factors && Array.isArray(report.serp_factors.page_factor_vectors))
    ? {
      query:      report.query || null,
      built_at:   new Date().toISOString(),
      backend:    report.serp_factors.backend || null,
      n_pages:    report.serp_factors.n_pages || 0,
      factors:    Array.isArray(report.serp_factors.factors) ? report.serp_factors.factors : [],
      page_factor_vectors: report.serp_factors.page_factor_vectors,
    }
    : null;
  try {
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
             comparison = $8::jsonb,
             factor_matrix = $9::jsonb
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
        factorMatrix ? JSON.stringify(factorMatrix) : null,
      ],
    );
  } catch (e) {
    // Обратная совместимость: если колонки factor_matrix ещё нет (миграция
    // не применена на старом инстансе), повторяем UPDATE без неё, чтобы
    // сохранение основного отчёта не падало.
    if (/factor_matrix/i.test(String(e.message || ''))) {
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
    } else {
      throw e;
    }
  }
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

  const funnel = createFunnelTracker({ kind: 'relevance', taskRef: reportId, niche: query || null });

  try {
    // ── 1. SERP ──────────────────────────────────────────────────────────
    funnel.step('serp');
    await _setStage(reportId, 'serp', { status: 'fetching', started: true });

    const serpRaw = await fetchYandexSerp(query, { lr: lr || '', pages: 2 });
    // Целевое число уникальных сайтов = top_n задачи (обычно 20). Порог
    // добора совпадает с целью — стремимся выдать ровно top_n чистых URL.
    const serpTarget = (Number.isFinite(topN) && topN > 0) ? topN : DEFAULT_SERP_TARGET;
    // Воронка парсинга: сколько «сырых» doc'ов пришло от XMLStock суммарно
    // (первые 2 страницы + все страницы добора) — до любого dedup/фильтра.
    // Нужно фронту для прозрачности: «запросили N ссылок, чтобы выдать 20».
    let rawSerpTotal = Array.isArray(serpRaw) ? serpRaw.length : 0;
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

    // Вспомогательная функция: добавить в `serp` URL'ы из dump'а XMLStock с
    // соблюдением dedup'ов (по URL и по host). Возвращает число добавленных.
    const _ingestSerp = (raw) => {
      let added = 0;
      for (const item of (raw || [])) {
        const url = String(item.url || '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const host = _canonicalHost(url);
        if (host && seenHosts.has(host)) {
          skippedSameHost.push({ url, host });
          continue;
        }
        if (host) seenHosts.add(host);
        serp.push({
          url,
          title:   String(item.title   || '').slice(0, 500),
          snippet: String(item.snippet || '').slice(0, 1000),
        });
        added += 1;
        if (serp.length >= topN) break;
      }
      return added;
    };

    // Считаем «полезное» количество URL — после исключения тех, кого выкинет
    // фильтр агрегаторов (если опция включена). Этот счётчик используем как
    // условие добора со следующей SERP-страницы.
    const _usefulCount = () => {
      if (!excludeAggregators) return serp.length;
      const split = splitBySerp(serp);
      return split.kept.length;
    };

    // ── 1.4. Добор с доп. страниц SERP (стр.3-10), пока не наберём top_n ──
    // Заказчик: «если кол-во меньше 20 сайтов, парсим ещё страницу». Делаем
    // это ИТЕРАТИВНО вплоть до 10-й страницы XMLStock (позиции 21-100),
    // останавливаясь при достижении serpTarget (= top_n) полезных URL ИЛИ
    // topN. Считаем именно «полезные» URL — после фильтра агрегаторов, чтобы
    // при включённой галке не выскочить из условия с 18 URL, из которых
    // 12 — Avito/hh/ozon.
    const topupPages = [];
    let needTopup = _usefulCount() < serpTarget && serp.length < topN;
    // Отметка: добрались ли мы до последней доступной страницы добора. Нужно,
    // чтобы warning «Добор исчерпан» показывался только когда мы реально
    // упёрлись в 10-ю страницу SERP, а не при раннем выходе из цикла.
    const LAST_TOPUP_PAGE = SERP_TOPUP_PAGES[SERP_TOPUP_PAGES.length - 1];
    if (needTopup) {
      for (const page of SERP_TOPUP_PAGES) {
        if (serp.length >= topN) break;
        if (_usefulCount() >= serpTarget) break;
        try {
          const extraRaw = await fetchYandexSerp(query, {
            lr: lr || '',
            pages: 1,
            startPage: page,
          });
          rawSerpTotal += Array.isArray(extraRaw) ? extraRaw.length : 0;
          const added = _ingestSerp(extraRaw);
          topupPages.push({ page, added, useful: _usefulCount() });
          console.log(
            `[relevance] добор SERP page=${page} (поз. ${page * 10 + 1}-${page * 10 + 10}) `
            + `для отчёта ${reportId}: +${added} URL `
            + `(итого ${serp.length}/${topN}, полезных ${_usefulCount()}, threshold=${serpTarget})`,
          );
        } catch (e) {
          // Best-effort: если страница не пришла — пробуем следующую.
          console.warn(
            `[relevance] добор SERP page=${page} не удался для отчёта ${reportId}: `
            + `${e.message || e}`,
          );
        }
      }
      needTopup = _usefulCount() < serpTarget;
    }
    const extendedFromExtraPages = topupPages.some((p) => (p.added || 0) > 0);
    // Дошли ли мы фактически до последней страницы добора (10-й SERP).
    const topupExhausted = topupPages.some((p) => p.page === LAST_TOPUP_PAGE);

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
    // serp в БД — JSONB-массив. Метаданные о доборе со стр. 3+ и фильтрах
    // пишем только в лог + позже в report.serp_meta, чтобы не ломать
    // существующих потребителей (RelevanceResultPage.vue, контроллеры
    // читают serp как массив URL).
    if (extendedFromExtraPages || skippedSameHost.length || removedAggregators.length) {
      console.log(
        `[relevance] serp-meta для ${reportId}: kept=${serpForFetch.length}, `
        + `skippedSameHost=${skippedSameHost.length}, `
        + `removedAggregators=${removedAggregators.length}, `
        + `topup=${topupPages.map((p) => `p${p.page}+${p.added}`).join(',') || '—'}`,
      );
    }
    funnel.step('fetching_pages');
    await _setStage(reportId, 'fetching_pages', { serp });

    // ── 2. Скачивание HTML ───────────────────────────────────────────────
    const fetchRes = await fetchPages(serpForFetch.map((s) => s.url));
    let successes = fetchRes.successes;
    let failures = fetchRes.failures;

    // ── 2b. Второй проход для не-успешных URL: форсим headless. Цель —
    // довести `successes.length` максимально близко к `serp.length`, иначе
    // мы считаем релевантность по 3 точкам, а оператор видит «3 из 20»
    // (основная боль из ТЗ). Запускаем только если есть failures и есть
    // headless-сервис.
    const failedForRetry = failures.filter((f) => {
      // Бессмысленно ретраить настоящие 404/410/451 — там HTML просто нет.
      const c = String(f?.code || '');
      if (c === 'http_404' || c === 'http_410' || c === 'http_451') return false;
      if (c === 'dns' || c === 'tls') return false;
      return true;
    });
    let headlessSecondPass = { attempted: 0, recovered: 0, available: false };
    if (failedForRetry.length > 0 && pageFetcher.HEADLESS_FETCHER_URL) {
      headlessSecondPass.available = true;
      headlessSecondPass.attempted = failedForRetry.length;
      try {
        const second = await pageFetcher.fetchHeadlessOnly(failedForRetry.map((f) => f.url));
        if (second.successes.length > 0) {
          const recoveredUrls = new Set(second.successes.map((s) => s.url));
          successes = successes.concat(second.successes);
          // Убираем восстановленные из failures и заменяем оставшиеся причины на
          // headless_fail/headless_unavailable из второго прохода.
          const stillFailed = failures.filter((f) => !recoveredUrls.has(f.url));
          // Обновим описание у тех, что остались failed после headless: пусть
          // финальная категория отражает headless_fail (если он действительно
          // пробовался и упал).
          const headlessFailMap = new Map();
          for (const f of second.failures) headlessFailMap.set(f.url, f);
          failures = stillFailed.map((f) => {
            const hh = headlessFailMap.get(f.url);
            if (hh && hh.code) {
              return { ...f, code: hh.code, error: hh.error || f.error };
            }
            return f;
          });
          headlessSecondPass.recovered = second.successes.length;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[relevance ${reportId}] headless second pass failed:`, e.message);
      }
    } else if (failedForRetry.length > 0 && !pageFetcher.HEADLESS_FETCHER_URL) {
      // Helmet «headless недоступен» — помечаем все retryable-failures стабильным
      // кодом, чтобы оператор сразу видел причину «20 - N» в fail_breakdown.
      const retryableSet = new Set(failedForRetry.map((f) => f.url));
      failures = failures.map((f) => (
        retryableSet.has(f.url)
          ? { ...f, code: f.code === 'unknown' ? 'headless_unavailable' : f.code }
          : f
      ));
    }

    // Aegis Phase 14: фильтр «отравленных» страниц (hidden text / keyword
    // stuffing / invisible chars) — данные конкурентов могут содержать
    // SEO-яд, и мы не хотим строить BM25/анкорный профиль ниши на нём.
    // Graceful: если AEGIS_ENABLED=false или модуль отсутствует — no-op.
    // ВАЖНО: по ТЗ «надо чтобы у каждого URL был спарсен контент»
    // poison-фильтр НЕ выкидывает страницы из корпуса, а только помечает —
    // оператор видит причину в `dropped_by_aegis`, корпус остаётся полным.
    let aegisDropped = [];
    try {
      const { kept, dropped } = aegisHooks.filterPoisonedPages(successes);
      aegisDropped = dropped || [];
      if (aegisDropped.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[aegis][relevance ${reportId}] poison filter flagged `
          + `${aegisDropped.length}/${successes.length} (kept in corpus, marked only): `
          + aegisDropped.slice(0, 3).map((d) => `${d.url} (${d.reason})`).join('; '),
        );
      }
      // Поведение по умолчанию изменено: НЕ дропаем, чтобы релевантность
      // считалась по всем URL. Если потребуется жёсткий drop — включить через
      // env RELEVANCE_AEGIS_HARD_DROP=1.
      if ((process.env.RELEVANCE_AEGIS_HARD_DROP || '').trim() === '1') {
        successes = kept;
      }
      aegisHooks.emitPagesTelemetry({ ok: successes.length, dropped: aegisDropped });
    } catch (_) { /* graceful */ }

    funnel.step('analyzing');
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
    // Карта url → позиция в выдаче (1-based). `serp` уже отсортирован по
    // позиции, поэтому индекс+1 — это ранг URL. Позиции нужны Relevance 2.0
    // (Phase 1) для факторной матрицы и ранговых корреляций Спирмена.
    const serpPositionByUrl = new Map();
    for (let i = 0; i < serp.length; i++) {
      const u = String(serp[i]?.url || '').trim();
      if (u && !serpPositionByUrl.has(u)) serpPositionByUrl.set(u, i + 1);
    }

    const analysisResp = await analyze({
      query,
      documents: successes.map((s) => ({
        url: s.url,
        html: s.html,
        // SEO Relevance Analyzer 2.0 (Phase 1): ранг URL в выдаче для
        // факторной матрицы / корреляций. Отсутствует → Python подставит index+1.
        serp_position: serpPositionByUrl.get(String(s.url || '').trim()) ?? null,
      })),
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
        // SEO Relevance Analyzer 2.0 (Phase 1): факторная матрица (row-per-page),
        // ранговые корреляции Спирмена (фактор↔позиция) и дифференциал
        // top3/top4-10/top11-20. Env-выключатель: RELEVANCE_SERP_FACTORS=false.
        include_serp_factors: true,
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
      // SEO Relevance Analyzer 2.0 (Phase 1): факторная матрица SERP 1–20,
      // ранговые корреляции Спирмена (фактор↔позиция) и дифференциал
      // top3/top4-10/top11-20. Может быть null, если флаг/env выключены на
      // стороне Python. Сырая матрица (page_factor_vectors) также сохраняется
      // отдельной JSONB-колонкой relevance_reports.factor_matrix (мигр. 099)
      // для офлайн-пересчёта корреляций без повторного обхода SERP.
      serp_factors: (analysisResp?.serp_factors && typeof analysisResp.serp_factors === 'object')
        ? analysisResp.serp_factors
        : null,
      filter: {
        exclude_aggregators:  !!excludeAggregators,
        removed_aggregators:  removedAggregators,
        skipped_same_host:    skippedSameHost,
        serp_after_filter:    serpForFetch.length,
      },
      // Метаданные SERP-добора: какие доп. страницы XMLStock запрашивали и
      // сколько уникальных URL они добавили. Полезно для отладки на стороне
      // оператора («а почему добор не сработал?»).
      serp_meta: {
        top_n:                  topN,
        serp_total:             serp.length,
        useful_after_filter:    serpForFetch.length,
        skipped_same_host:      skippedSameHost.length,
        removed_aggregators:    removedAggregators.length,
        topup_pages:            topupPages,
        min_threshold:          serpTarget,
        // Воронка парсинга (для прозрачного UI: «запросили N ссылок, чтобы
        // выдать M уникальных сайтов»). raw_total — все «сырые» doc'ы от
        // XMLStock (первые 2 стр. + все страницы добора) ДО любого dedup.
        raw_total:              rawSerpTotal,
        deduped_count:          serp.length,
        aggregators_skipped:    removedAggregators.length,
        same_host_skipped:      skippedSameHost.length,
        target:                 serpTarget,
        target_reached:         serpForFetch.length >= serpTarget,
        topup_exhausted:        topupExhausted,
      },
      // Человекочитаемые предупреждения (показываются баннером в UI).
      warnings: (() => {
        const warns = [];
        if (successes.length < 5) {
          warns.push(
            `Скачано ${successes.length} страниц — это мало для устойчивых медиан, `
            + `выводы по корпусу индикативны.`,
          );
        } else if (successes.length < 10) {
          warns.push(
            `Скачано ${successes.length}/${serp.length} — частичные данные. `
            + `Релевантность считается по этим документам, медианы шумные.`,
          );
        } else if (successes.length < serp.length) {
          warns.push(
            `Скачано ${successes.length}/${serp.length} — выводы устойчивы, но `
            + `${serp.length - successes.length} URL в корпусе не учтены.`,
          );
        }
        // Предупреждаем об исчерпании добора ТОЛЬКО когда реально дошли до
        // последней (10-й) страницы SERP и всё равно не набрали target — иначе
        // это шумное сообщение при раннем (успешном) выходе из цикла.
        if (serpForFetch.length < serpTarget && topupExhausted) {
          warns.push(
            `После dedup и фильтра агрегаторов осталось ${serpForFetch.length} URL `
            + `(цель ${serpTarget}). Добор с доп. страниц SERP исчерпан (дошли до `
            + `10-й страницы Яндекса).`,
          );
        }
        if (!pageFetcher.HEADLESS_FETCHER_URL) {
          warns.push(
            'Headless-фетчер (RELEVANCE_HEADLESS_FETCHER_URL) не настроен — '
            + 'SPA / WAF-страницы могут не скачиваться. Это поднимает долю «не открылось».',
          );
        } else if (headlessSecondPass.attempted > 0) {
          warns.push(
            `Второй проход через headless: ${headlessSecondPass.recovered}/`
            + `${headlessSecondPass.attempted} URL восстановлено.`,
          );
        }
        if ((aegisDropped || []).length > 0) {
          warns.push(
            `Aegis poison-фильтр пометил ${aegisDropped.length} страниц как `
            + `подозрительные (оставлены в корпусе для прозрачности).`,
          );
        }
        return warns;
      })(),
      // Сводка причин fail'а — оператору сразу видно, где проблема.
      fail_breakdown: _summarizeFailures(failures),
      // Сводка по парсингу: какой метод сработал на сколько URL и сколько
      // документов попали в empty_reason. Это разделяет «WAF не пустил» (виден
      // в fail_breakdown) и «парсер не справился» (виден в parse_breakdown) —
      // ключевое требование ТЗ для диагностики «3 из 20».
      parse_breakdown: _summarizeParse(analysisResp?.document_diagnostics),
      // Какой fetch-метод (axios_chrome / headless_* / axios_googlebot) дал
      // успех по каждому URL — оператор сразу видит, кому помог headless.
      fetch_methods: successes.map((s) => ({
        url: s.url, method: s.method || 'axios', retries_used: s.retries_used || 0,
      })),
      // Метаданные второго прохода через headless для UI/логов.
      headless_second_pass: headlessSecondPass,
      // Aegis: какие страницы помечены как «отравленные» (оставлены в корпусе,
      // если RELEVANCE_AEGIS_HARD_DROP не выставлен).
      dropped_by_aegis: aegisDropped,
    };

    // ── 5. Сравнение «наш сайт vs ТОП» (опционально, если задан our_url) ─
    let ourReport = null;
    let comparisonReport = null;
    if (ourUrl && (analysisResp?.vocabulary?.length || 0) > 0) {
      try {
        funnel.step('comparing');
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

    _logRunSummary(reportId, fullReport, successes, failures);

    await _finishOk(reportId, fullReport, Date.now() - t0, rawMeta, dbProcessed, {
      our_report: ourReport,
      comparison: comparisonReport,
    });
    funnel.step('finalize');
    try {
      await finalizeByTask({
        table: 'relevance_reports',
        taskId: reportId,
        ok: true,
        taskKind: 'relevance',
      });
    } catch (_) { /* no-op */ }
    try { await funnel.finish({ status: 'completed' }); } catch (_e) { /* analytics must not break generation */ }

    // Aegis Phase 14: после успеха зачистим эфемерные точки этого
    // прогона в Qdrant (если evidence/SERP-документы туда индексировались
    // с payload.run_id='relevance_<id>'). Graceful: при выключенном
    // флаге / отсутствии Qdrant — no-op.
    try { await aegisHooks.finalizeReportCleanup(reportId); }
    catch (_) { /* graceful */ }
  } catch (err) {
    console.error(`[relevance] report ${reportId} failed:`, err.message);
    await _finishError(reportId, err.message);
    try {
      await finalizeByTask({
        table: 'relevance_reports',
        taskId: reportId,
        ok: false,
        error: err.message,
        taskKind: 'relevance',
      });
    } catch (_) { /* no-op */ }
    try { await funnel.finish({ status: 'failed', error: err }); } catch (_e) { /* no-op */ }
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
 * Сводка по парсингу контента: сколько URL дали empty_reason vs какой метод
 * экстрактора (heavy_bs4 / trafilatura / readability / wide_bs4 / parser_exception)
 * сработал. Это позволяет в одном взгляде понять «WAF не пустил» (видно в
 * fail_breakdown) vs «парсер не справился» (видно здесь).
 */
function _summarizeParse(diagnostics) {
  const out = { methods: {}, empty_reasons: {}, total: 0, parsed: 0, empty: 0 };
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  for (const d of list) {
    out.total += 1;
    const method = String(d?.method || 'none');
    out.methods[method] = (out.methods[method] || 0) + 1;
    if (d?.empty_reason) {
      const r = String(d.empty_reason);
      out.empty_reasons[r] = (out.empty_reasons[r] || 0) + 1;
      out.empty += 1;
    } else if ((d?.text_chars || 0) > 0) {
      out.parsed += 1;
    }
  }
  return out;
}

/**
 * Печатает в лог одну сводную строку по отчёту: сколько URL скачано / не
 * скачано / распарсено + топ-3 причины по каждому breakdown'у.
 * Ничего не возвращает, не бросает — это диагностика, не часть контракта.
 */
function _logRunSummary(reportId, fullReport, successes, failures) {
  try {
    const top = (obj, n = 3) => Object.entries(obj || {})
      .sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `${k}×${v}`).join(',') || '—';
    const fb = fullReport?.fail_breakdown || {};
    const pb = fullReport?.parse_breakdown || {};
    const fm = (successes || []).reduce((acc, s) => {
      const k = String(s.method || 'axios');
      acc[k] = (acc[k] || 0) + 1; return acc;
    }, {});
    // eslint-disable-next-line no-console
    console.info(
      `[relevance ${reportId}] summary: `
      + `serp=${(fullReport.serp_meta || {}).useful_after_filter ?? '?'} `
      + `fetched=${successes.length} failed=${failures.length} `
      + `methods=[${top(fm)}] `
      + `parse_methods=[${top(pb.methods)}] `
      + `empty=${pb.empty || 0}/${pb.total || 0} (${top(pb.empty_reasons)}) `
      + `fail=[${top(fb)}]`,
    );
  } catch (_) { /* diagnostics must not throw */ }
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
