-- ── Testimoniales, fase 1: fluidez del alumno por transcript ─────────────────
--
-- Cada transcript subido recibe, aparte del análisis de riesgo con Opus, un
-- análisis SOLO de fluidez con Haiku: cuánto se traba el alumno hablando inglés.
-- Comparando una clase vieja con una reciente se detectan alumnos que mejoraron
-- mucho, para pedirle al profe esas dos grabaciones y usarlas en anuncios.
--
-- POR QUÉ UNA TABLA APARTE Y NO COLUMNAS EN class_analyses
-- Hay listados que hacen select('*') sobre class_analyses (lib/db.ts, backup de
-- alumnos) y se traerían todo esto. Una tabla propia no la carga nadie que no la
-- pida. Una fila por transcript; se borra sola si se borra la clase.
--
-- EL NÚMERO DE CLASE DEL ALUMNO NO SE GUARDA: lo calcula la vista de abajo.
-- Si un profe sube tarde el transcript de una clase anterior, un número guardado
-- quedaría mal para todas las siguientes. Misma idea que has_transcript: la
-- aplicación nunca lo escribe.
--
-- Aditivo, idempotente (se puede correr dos veces) y reversible:
--   DROP VIEW transcript_fluency_numbered;
--   DROP TABLE transcript_fluency;
--
-- Se puede correr ANTES de desplegar el código: no toca ninguna tabla existente.

CREATE TABLE IF NOT EXISTS transcript_fluency (
  analysis_id        text PRIMARY KEY REFERENCES class_analyses(id) ON DELETE CASCADE,
  -- Agrupación del alumno: su student_id (resuelto con el emparejamiento
  -- tolerante si la clase no lo traía) o 'name:<nombre normalizado>'.
  student_key        text NOT NULL,

  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'ready', 'skipped', 'failed')),
  -- Descartes previos a la IA (no gastan llamada).
  skip_reason        text
                     CHECK (skip_reason IN ('pocas_palabras', 'mas_de_dos_hablantes',
                                            'un_solo_hablante', 'sin_formato_hablantes')),
  word_count         integer,
  speaker_count      integer,
  teacher_speaker    text,
  student_speaker    text,

  -- Resultado de la IA. fluency_score NULL + unscorable_reason = no evaluable.
  fluency_score      smallint CHECK (fluency_score BETWEEN 1 AND 10),
  unscorable_reason  text,
  student_talk_share smallint CHECK (student_talk_share BETWEEN 0 AND 100),
  hesitation_level   text CHECK (hesitation_level IN ('alta', 'media', 'baja')),
  spanish_usage      text CHECK (spanish_usage IN ('mucho', 'algo', 'casi nada')),
  fluency_evidence   text,
  best_excerpt       text,
  best_excerpt_at    text,
  -- ¿La cita aparece de verdad en el transcript? (la comprueba el código)
  best_excerpt_found boolean,
  worst_excerpt      text,
  worst_excerpt_at   text,
  worst_excerpt_found boolean,

  fathom_url         text,
  model              text,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  analyzed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Igual que class_analyses: el servidor escribe con la clave anon.
ALTER TABLE transcript_fluency DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_transcript_fluency_student ON transcript_fluency (student_key);
CREATE INDEX IF NOT EXISTS idx_transcript_fluency_status  ON transcript_fluency (status);

-- Número de clase del alumno: orden cronológico de TODOS sus transcripts
-- (también los descartados), en fecha de España. Solo columnas ligeras de
-- class_analyses: nunca el transcript.
CREATE OR REPLACE VIEW transcript_fluency_numbered AS
SELECT
  tf.*,
  COALESCE(ca.student_id, tf.student_key) AS student_group,
  COALESCE(ca.class_date, (ca.analyzed_at AT TIME ZONE 'Europe/Madrid')::date) AS class_day,
  ca.teacher_id,
  ROW_NUMBER() OVER (
    PARTITION BY COALESCE(ca.student_id, tf.student_key)
    ORDER BY COALESCE(ca.class_date, (ca.analyzed_at AT TIME ZONE 'Europe/Madrid')::date), tf.analysis_id
  ) AS student_class_number
FROM transcript_fluency tf
JOIN class_analyses ca ON ca.id = tf.analysis_id;

-- Comprobación: debe devolver 0 sin error.
-- select count(*) from transcript_fluency_numbered;
