-- ─────────────────────────────────────────────────────────────────────────────
-- Migración: mejoras Academy Scheduler
--   · Reprogramar clase (profesor)  → original_date, rescheduled_to
--   · "En recuperación" vinculada al alumno → recovery_for_date
--
-- class_type ahora admite además 'reprogramada' (constancia de clase movida; NO
-- cuenta para el pago — la clase se contará cuando efectivamente se dé).
-- Ejecutá este script una vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table class_records add column if not exists original_date      date;
alter table class_records add column if not exists rescheduled_to      date;
alter table class_records add column if not exists recovery_for_date   date;
