-- Migration 054: Generation funnels — учёт успешных/неуспешных «связок».
--
--   Каждая генерация (любого kind: info_article, link_article, meta_tags,
--   relevance, article_topics, forecaster, super_core_seo, …) пишет сюда
--   одну строку-воронку с детализацией по стадиям. Используется для
--   агрегированного анализа: conversion-rate по стадиям, топ причин отказов,
--   стоимость/латентность успешных vs неуспешных генераций, разбивка по kind.
--
--   `report` (JSONB) содержит полный per-stage массив stages[] и агрегаты
--   (by_outcome, total_cost_usd, total_tokens_*, total_retries, duration_ms),
--   как их строит aegis/funnelTracker.createFunnelTracker().toReport().
--
--   Соответствует ensureSchema() в backend/server.js (идемпотентный DDL).

CREATE TABLE IF NOT EXISTS generation_funnels (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              VARCHAR(32)   NOT NULL,
    task_ref          TEXT,
    user_id           UUID,
    niche             TEXT,
    status            VARCHAR(16)   NOT NULL DEFAULT 'completed',  -- completed|failed|partial
    final_stage       TEXT,
    fail_reason       VARCHAR(48),
    stage_count       INTEGER       NOT NULL DEFAULT 0,
    total_cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
    total_tokens_in   BIGINT        NOT NULL DEFAULT 0,
    total_tokens_out  BIGINT        NOT NULL DEFAULT 0,
    total_retries     INTEGER       NOT NULL DEFAULT 0,
    duration_ms       BIGINT        NOT NULL DEFAULT 0,
    report            JSONB,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ
);

-- Один upsert на (kind, task_ref): повторный запуск воронки той же задачи
-- обновляет строку, а не плодит дубликаты. task_ref может быть NULL (ad-hoc).
CREATE UNIQUE INDEX IF NOT EXISTS generation_funnels_kind_ref_uidx
    ON generation_funnels (kind, task_ref)
    WHERE task_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS generation_funnels_kind_created_idx
    ON generation_funnels (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_funnels_status_idx
    ON generation_funnels (status);
CREATE INDEX IF NOT EXISTS generation_funnels_fail_reason_idx
    ON generation_funnels (fail_reason)
    WHERE fail_reason IS NOT NULL;
