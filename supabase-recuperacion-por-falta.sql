-- ── Recuperación automática cuando el profesor no se conecta ─────────────────
--
-- Rama recuperacion-por-falta (19/10/2026). Al detectar una posible ausencia
-- (/api/cron/ausencias), para los profesores de ABSENCE_RECOVERY_BETA_TEACHERS
-- (lib/teacherAbsences.ts) se crea una recuperación en class_recoveries con
-- origin = 'ausencia', y el alumno elige la fecha desde el LMS.
--
-- CUÁNDO CORRERLO: ANTES de publicar el código. Todo es aditivo: el código que
-- está hoy en producción no usa nada de esto y sigue igual.
-- Sin este SQL, el código nuevo no rompe: la ausencia se avisa como hoy, sin
-- recuperación (queda el error anotado en el registro del cron).
--
-- Idempotente: se puede volver a correr.
--
-- Reversible:
--   ALTER TABLE class_recoveries DROP CONSTRAINT IF EXISTS class_recoveries_origin_check;
--   ALTER TABLE class_recoveries ADD CONSTRAINT class_recoveries_origin_check
--     CHECK (origin IN ('profesor', 'admin_reclasificacion'));   -- solo si no hay filas 'ausencia'
--   ALTER TABLE teacher_absence_alerts DROP COLUMN recovery_id, DROP COLUMN annulled_at, DROP COLUMN annulled_by;
--   (y el CHECK de status sin 'anulada', igual que abajo)


-- ── 1) class_recoveries: nuevo origen 'ausencia' ──────────────────────────────

ALTER TABLE class_recoveries DROP CONSTRAINT IF EXISTS class_recoveries_origin_check;
ALTER TABLE class_recoveries ADD CONSTRAINT class_recoveries_origin_check
  CHECK (origin IN ('profesor', 'admin_reclasificacion', 'ausencia'));


-- ── 2) teacher_absence_alerts: la recuperación y la anulación del admin ──────

-- La recuperación creada para esa clase (class_recoveries.id). Sin FK, como el
-- resto de la tabla.
ALTER TABLE teacher_absence_alerts ADD COLUMN IF NOT EXISTS recovery_id text;
-- Quién y cuándo la anuló desde el admin (el motivo va en status_reason).
ALTER TABLE teacher_absence_alerts ADD COLUMN IF NOT EXISTS annulled_at timestamptz;
ALTER TABLE teacher_absence_alerts ADD COLUMN IF NOT EXISTS annulled_by text;

-- Estado nuevo 'anulada' (el admin anuló la posible ausencia). El CHECK viejo
-- se busca por su contenido, no solo por el nombre: si Postgres le hubiera dado
-- otro, quedarían los dos y 'anulada' seguiría prohibido.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'teacher_absence_alerts'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%posible_ausencia%'
  LOOP
    EXECUTE format('ALTER TABLE teacher_absence_alerts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE teacher_absence_alerts ADD CONSTRAINT teacher_absence_alerts_status_check
  CHECK (status IN ('posible_ausencia', 'llego_tarde', 'no_verificado', 'descartada', 'anulada'));


-- ── 3) Comprobación (tiene que devolver las 2 restricciones y las 3 columnas) ─

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname IN ('class_recoveries_origin_check', 'teacher_absence_alerts_status_check');

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'teacher_absence_alerts' AND column_name IN ('recovery_id', 'annulled_at', 'annulled_by');
