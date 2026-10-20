-- ════════════════════════════════════════════════════════════════════════════
-- SISTEMA ÚNICO DE PENALIZACIONES A PROFESORES (oct/2026)
-- Rama penalizaciones-unicas. Correr ENTERO en Supabase → SQL Editor ANTES de
-- publicar el código. Se puede correr dos veces sin romper nada.
--
--   1. scoring_events.applies_month: el mes al que cuenta cada multa (la falta,
--      el de la CLASE; la cancelación, el de la cancelación; hora de España).
--   2. teacher_absence_alerts: estado de la multa de cada posible ausencia
--      (cobrada / revertida / revisar).
--   3. Bloqueo del "Cancelar clase" VIEJO: un trigger descarta las constancias
--      de cancelación del profesor y las multas en euros que lleguen con la
--      llave PÚBLICA (la app vieja abierta en un navegador). Las del sistema
--      nuevo las escribe el servidor con la service role, que no se toca.
--      Cada intento queda en blocked_cancel_attempts y deja una campanita al
--      profesor ("actualiza la página") y otra al admin.
--   4. Facundo Test: desactiva la asignación duplicada a_1791860060190 (queda
--      308a0bfe-…) y anula sus 3 recuperaciones de prueba por ausencia.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Mes de imputación de cada evento ─────────────────────────────────────
ALTER TABLE scoring_events ADD COLUMN IF NOT EXISTS applies_month text;
ALTER TABLE scoring_events DROP CONSTRAINT IF EXISTS scoring_events_applies_month_check;
ALTER TABLE scoring_events ADD CONSTRAINT scoring_events_applies_month_check
  CHECK (applies_month IS NULL OR applies_month ~ '^\d{4}-\d{2}$');


-- ── 2. Multa de cada posible ausencia ───────────────────────────────────────
ALTER TABLE teacher_absence_alerts ADD COLUMN IF NOT EXISTS penalty_state    text;
ALTER TABLE teacher_absence_alerts ADD COLUMN IF NOT EXISTS penalty_event_id text;
ALTER TABLE teacher_absence_alerts ADD COLUMN IF NOT EXISTS penalty_reason   text;
ALTER TABLE teacher_absence_alerts DROP CONSTRAINT IF EXISTS teacher_absence_alerts_penalty_state_check;
ALTER TABLE teacher_absence_alerts ADD CONSTRAINT teacher_absence_alerts_penalty_state_check
  CHECK (penalty_state IS NULL OR penalty_state IN ('cobrada', 'revertida', 'revisar'));


-- ── 3. Bloqueo del sistema viejo ────────────────────────────────────────────

-- Intentos descartados. El chequeo de ausencias la lee: si el profesor intentó
-- cancelar una clase con la app vieja, su falta NO se cobra (queda "revisar").
CREATE TABLE IF NOT EXISTS blocked_cancel_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       text NOT NULL,          -- 'class_records' | 'scoring_events'
  teacher_id   text,
  teacher_name text,
  student_name text,
  class_date   date,
  class_time   text,
  detail       text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocked_cancel_attempts_teacher_date ON blocked_cancel_attempts (teacher_id, class_date);
-- RLS sin políticas: solo la service role (servidor) la lee.
ALTER TABLE blocked_cancel_attempts ENABLE ROW LEVEL SECURITY;

-- ¿La petición llega con la llave pública (navegador)? La service role, el SQL
-- Editor y los scripts no entran aquí.
CREATE OR REPLACE FUNCTION penalties_is_public_role() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
    ''
  ) IN ('anon', 'authenticated');
$$;

-- class_records: constancias de cancelación del PROFESOR desde el navegador.
-- RETURN NULL = la fila no se guarda, sin error (la app vieja no lo nota, pero
-- tampoco cobra ni avisa al alumno: /api/classes/cancel ya no manda el email).
CREATE OR REPLACE FUNCTION block_public_teacher_cancellations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  clave text;
BEGIN
  IF NEW.class_type IN ('cancelada_por_profesor', 'cancelada_con_preaviso') AND penalties_is_public_role() THEN
    INSERT INTO blocked_cancel_attempts (source, teacher_id, teacher_name, student_name, class_date, class_time, detail)
    VALUES ('class_records', NEW.teacher_id, NEW.teacher_name, NEW.student_name, NEW.class_date, NEW.class_time, NEW.class_type);

    clave := NEW.teacher_id || '_' || NEW.class_date::text || '_' || md5(coalesce(NEW.student_name, ''));
    INSERT INTO notifications (id, target_user, target_role, title, body, type, read_by, created_at, created_by)
    VALUES (
      'notif_cancel_bloqueada_' || clave, NEW.teacher_id, NULL,
      'No se registró tu cancelación',
      'Estás usando una versión vieja de la app y la cancelación de tu clase con ' || coalesce(NEW.student_name, 'tu alumno') ||
        ' del ' || to_char(NEW.class_date, 'DD/MM') || ' NO se guardó (y el alumno no recibió ningún aviso). ' ||
        'Actualiza la página (Ctrl + Shift + R) y usa «No puedo dar esta clase».',
      'cancelacion_bloqueada', '{}', now(), 'sistema'
    ) ON CONFLICT (id) DO NOTHING;
    INSERT INTO notifications (id, target_user, target_role, title, body, type, read_by, created_at, created_by)
    VALUES (
      'notif_cancel_bloqueada_admin_' || clave, NULL, 'admin',
      'Cancelación con la app vieja bloqueada · ' || coalesce(NEW.teacher_name, NEW.teacher_id),
      coalesce(NEW.teacher_name, NEW.teacher_id) || ' intentó cancelar con la versión vieja la clase del ' || to_char(NEW.class_date, 'DD/MM') ||
        ' con ' || coalesce(NEW.student_name, '—') || '. No se guardó ni se avisó al alumno. Pídele que recargue la página.',
      'cancelacion_bloqueada', '{}', now(), 'sistema'
    ) ON CONFLICT (id) DO NOTHING;
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_public_teacher_cancellations ON class_records;
CREATE TRIGGER trg_block_public_teacher_cancellations
  BEFORE INSERT ON class_records
  FOR EACH ROW EXECUTE FUNCTION block_public_teacher_cancellations();

-- scoring_events: ninguna multa en euros desde el navegador (el −5 € del botón
-- viejo y la "Falta injustificada" del formulario viejo del admin). Los bonos y
-- las reversiones (euros positivos) siguen igual.
CREATE OR REPLACE FUNCTION block_public_penalties() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(NEW.euros, 0) < 0 AND penalties_is_public_role() THEN
    INSERT INTO blocked_cancel_attempts (source, teacher_id, teacher_name, detail)
    VALUES ('scoring_events', NEW.teacher_id, NEW.teacher_name,
            NEW.event_type || ' ' || NEW.euros::text || ' € · ' || coalesce(NEW.note, ''));
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_public_penalties ON scoring_events;
CREATE TRIGGER trg_block_public_penalties
  BEFORE INSERT ON scoring_events
  FOR EACH ROW EXECUTE FUNCTION block_public_penalties();


-- ── 4. Facundo Test (alumno de prueba con t1) ───────────────────────────────
UPDATE assignments SET status = 'inactive'
WHERE id = 'a_1791860060190' AND status = 'active';

UPDATE class_recoveries SET
  status = 'anulada', status_changed_at = now(), updated_at = now(),
  annulled_at = now(), annulled_by = 'admin',
  annul_reason = 'Recuperación de prueba (Facundo Test), anulada a mano'
WHERE id IN ('rec_mvflaedwuogj46', 'rec_mvgfajzkpy0m6p', 'rec_mvgs5jdkq9yyl1')
  AND status <> 'anulada';


-- ── Comprobación (debería verse todo así) ───────────────────────────────────
-- applies_month existe:
SELECT column_name FROM information_schema.columns
WHERE table_name = 'scoring_events' AND column_name = 'applies_month';
-- Los dos triggers:
SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_block_public_teacher_cancellations', 'trg_block_public_penalties');
-- Facundo Test: a_1791860060190 inactive, 308a0bfe-… active:
SELECT id, status FROM assignments WHERE student_id = 's_1791860060190';
-- Sus 3 recuperaciones de prueba, anuladas:
SELECT id, status FROM class_recoveries WHERE id IN ('rec_mvflaedwuogj46', 'rec_mvgfajzkpy0m6p', 'rec_mvgs5jdkq9yyl1');
