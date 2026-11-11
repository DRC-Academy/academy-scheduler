-- ── Aviso "Tu plan ha finalizado" desde Gestión (sin Zapier) ──────────────────
--
-- Desde nov/2026 el cron diario /api/cron/check-ending-plans avisa al alumno, a
-- su profe y al equipo (alumnos@) cuando su manual_active_until fue AYER y no
-- renovó (lib/endedPlanJob). Antes lo hacía el zap "Aviso Intensivos profe +
-- alumno" desde la planilla.
--
-- Estas columnas son el anti-duplicado, igual que ending_notice_* del aviso de
-- 7 días. MIENTRAS NO SE CORRA ESTE SQL, EL CRON NO ENVÍA NINGÚN AVISO DE FIN DE
-- PLAN (lo comprueba antes de enviar y corta). El modo ?finalizados=dry funciona
-- sin él.
--
-- Idempotente. Reversible:
--   alter table students
--     drop column if exists ended_notice_sent_at,
--     drop column if exists ended_notice_for_date,
--     drop column if exists ended_notice_canales;

ALTER TABLE students
  -- Cuándo quedó completo el aviso de ese ciclo (ningún destinatario en error).
  -- null con canales en error = se reintenta al día siguiente (hasta 3 días).
  ADD COLUMN IF NOT EXISTS ended_notice_sent_at timestamptz,
  -- El manual_active_until avisado. Si el alumno renueva y vuelve a vencer, la
  -- fecha cambia y el aviso vuelve a poder salir.
  ADD COLUMN IF NOT EXISTS ended_notice_for_date date,
  -- Resultado por destinatario:
  -- {"alumno":{"estado":"enviado","at":"…","to":"…"},"profe":{…},"equipo":{…}}
  -- estado: enviado | error | omitido. Solo se reintenta 'error'.
  ADD COLUMN IF NOT EXISTS ended_notice_canales jsonb;

-- Comprobación (debe devolver las 3 columnas):
--   select column_name, data_type from information_schema.columns
--    where table_name = 'students' and column_name like 'ended_notice_%';
