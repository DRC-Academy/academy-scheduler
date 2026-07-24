-- ─────────────────────────────────────────────────────────────────────────────
-- Bloque 4 — Sistema de penalizaciones por falta
-- Columnas de reversión sobre scoring_events. Idempotente.
--
-- Las penalizaciones se guardan como scoring_events:
--   event_type = 'falta_sin_aviso_penalizacion'  (euros -5)
--   event_type = 'penalizacion_revertida'         (euros +5, al revertir)
-- Al revertir, la penalización ORIGINAL se marca reverted=true (queda tachada en
-- la vista del profesor y no cuenta en el contador interno de faltas del admin).
-- ─────────────────────────────────────────────────────────────────────────────

alter table scoring_events add column if not exists reverted    boolean default false;
alter table scoring_events add column if not exists reverted_by  text;
alter table scoring_events add column if not exists reverted_at  timestamptz;

create index if not exists idx_scoring_events_type on scoring_events (event_type);
