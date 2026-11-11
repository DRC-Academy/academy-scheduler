-- ── Aviso de posible falta del profesor SIN Zapier ────────────────────────────
--
-- Desde nov/2026 Gestión avisa directamente (lib/notificaciones/ausencia):
-- Slack, WhatsApp al alumno (Respond.io, plantilla "faltaprofe") y email al
-- profe. Antes lo hacía el zap "Ausencia - Aviso alumno".
--
-- No hay una "tabla de clases": las clases salen del calendario. La fila de
-- teacher_absence_alerts (una por clase, id fijo) ya era el anti-duplicado; aquí
-- se le añade lo que hace falta para avisar por tres canales sin repetir ninguno.
--
-- CUÁNDO CORRERLO: ANTES de publicar el código. El código nuevo comprueba estas
-- columnas y, si faltan, corta la vuelta del cron SIN avisar a nadie (para no
-- mandar el mismo WhatsApp cada 5 minutos). El código viejo las ignora, así que
-- correrlo antes no rompe nada.
--
-- Idempotente. Reversible:
--   alter table teacher_absence_alerts
--     drop column if exists aviso_ausencia_enviado_at,
--     drop column if exists aviso_canales,
--     drop column if exists aviso_intentos;

ALTER TABLE teacher_absence_alerts
  -- Primer momento en que un canal salió bien. null = todavía no se avisó a nadie.
  ADD COLUMN IF NOT EXISTS aviso_ausencia_enviado_at timestamptz,
  -- Resultado por canal: {"slack":{"estado":"enviado","at":"…"},"whatsapp":{"estado":"error","error":"…"},"email":{…}}
  -- estado: enviado | error | sin_config | omitido. Solo se reintenta 'error'.
  ADD COLUMN IF NOT EXISTS aviso_canales jsonb,
  -- Vueltas que intentaron avisar (máximo 3). También sirve de cerrojo: un
  -- reintento solo sale si consigue subirlo.
  ADD COLUMN IF NOT EXISTS aviso_intentos smallint NOT NULL DEFAULT 0;

-- Comprobación (debe devolver las 3 columnas):
--   select column_name, data_type from information_schema.columns
--    where table_name = 'teacher_absence_alerts' and column_name like 'aviso_%';
