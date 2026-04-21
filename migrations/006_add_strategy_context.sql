-- =================================================================
-- Migration 006: Pre-Stage 0 strategic context + unused inputs report
-- =================================================================
-- Adds two JSONB columns to `tasks`:
--   * strategy_context — output of Pre-Stage 0 (Niche Landscape +
--     Market Opportunity Finder + Search Demand Mapper). Read by
--     subsequent stages (0/1/2) as a strategic reconnaissance layer.
--   * unused_inputs — end-of-pipeline report listing TZ inputs that
--     were not used in the final HTML (LSI, brand facts, competitor
--     facts, etc.). Surfaces in the «Ограничения проекта» UI block
--     so the editor can decide what to do with leftovers.
-- Both columns are optional; absence does not break the pipeline.
-- =================================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS strategy_context JSONB,
  ADD COLUMN IF NOT EXISTS unused_inputs    JSONB;
