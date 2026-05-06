-- =================================================================
-- Migration 018: Relevance Analyzer (XMLStock SERP + BM25 + n-grams)
-- =================================================================
-- Хранит отчёты анализа релевантности по ключевому запросу:
-- ТОП-20 Яндекса (XMLStock) → парсинг 20 страниц через Python-микросервис
-- (FastAPI + readability-lxml + pymorphy3 + rank-bm25) → агрегаты в JSONB.
-- Сырой текст ТОП-20 в БД НЕ сохраняем (только агрегаты).
-- =================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'relevance_report_status') THEN
    CREATE TYPE relevance_report_status AS ENUM (
      'pending', 'fetching', 'analyzing', 'done', 'error'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS relevance_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Входные параметры запроса
  query           TEXT NOT NULL,
  lr              TEXT NOT NULL DEFAULT '213',
  top_n           INTEGER NOT NULL DEFAULT 20,

  -- Состояние
  status          relevance_report_status NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  current_stage   TEXT,

  -- Метаданные сбора
  serp            JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{title,url,snippet}]
  fetched_count   INTEGER NOT NULL DEFAULT 0,           -- сколько URL реально удалось скачать
  failed_urls     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{url, error}]

  -- Главный агрегат, который рисуется в UI и экспортируется
  -- {
  --   stats: { doc_count, total_tokens, avg_doc_length, ... },
  --   vocabulary: [{ lemma, df, median_count, bm25_score, status }],
  --   ngrams:     [{ phrase, df, median_count, type, pos_pattern }]
  -- }
  report          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Тайминги
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_relevance_reports_user_created
  ON relevance_reports (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_relevance_reports_status
  ON relevance_reports (status);
