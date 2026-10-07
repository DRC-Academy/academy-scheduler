-- ── Testimoniales V5 (07/10/2026): momentos por clase y parejas por código ──
--
-- Con la V4 seguían saliendo clips de otra persona (la auditoría: 34 de 95
-- parejas mal). La V5 cambia el enfoque:
--   1. Para cada transcript se decide POR CÓDIGO cuál es la etiqueta de Fathom
--      del alumno (lib/testimonialSpeaker). Si no se puede con seguridad, el
--      transcript queda fuera. → tabla testimonial_transcripts.
--   2. Haiku elige, SOLO entre las intervenciones del alumno, hasta 2 momentos
--      malos y 2 muy buenos por clase; el código comprueba cada cita.
--      → tabla testimonial_moments.
--   3. La pareja (mismo alumno + mismo profe, malo de una clase y bueno de otra)
--      la elige el código, sin IA → testimonial_candidates (columnas nuevas).
--
-- Aditivo e idempotente salvo el DELETE del final (que es lo que pidió Facundo:
-- borrar lo de "Por revisar" y no tocar lo marcado "Sirve").
-- Correr ANTES de desplegar el código de la V5 (el código nuevo lee estas tablas);
-- el código viejo no las toca, así que no pasa nada si se corre antes.

-- ── 1. Un transcript por fila: quién es el alumno y si ya se analizó ────────
CREATE TABLE IF NOT EXISTS testimonial_transcripts (
  analysis_id       text PRIMARY KEY REFERENCES class_analyses(id) ON DELETE CASCADE,
  -- Alumno (su id de la plataforma, o 'name:<nombre>' si la clase no lo trae)
  -- y profe, copiados de class_analyses para no tener que volver a leerla.
  student_group     text,
  student_name      text,
  teacher_id        text,
  class_day         date,
  -- Etiquetas de Fathom decididas por código. NULL si el transcript quedó fuera.
  student_label     text,
  teacher_label     text,
  -- 'pending' → falta analizar; 'ready' → momentos guardados (puede que 0);
  -- 'excluded' → no se pudo decidir quién es el alumno (exclusion_reason);
  -- 'failed' → la IA falló (se reintenta hasta 3 veces).
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'ready', 'excluded', 'failed')),
  exclusion_reason  text,
  moments_count     integer,
  fathom_url        text,
  model             text,
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  processed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Reserva de las tandas (como transcript_fluency): una fila tocada hace menos
  -- de 2 minutos está "en curso" en otro proceso.
  updated_at        timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z'
);
ALTER TABLE testimonial_transcripts DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_transcripts_status  ON testimonial_transcripts (status);
CREATE INDEX IF NOT EXISTS idx_testimonial_transcripts_student ON testimonial_transcripts (student_group);

-- ── 2. Los momentos de cada clase ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS testimonial_moments (
  id             text PRIMARY KEY,
  analysis_id    text NOT NULL REFERENCES class_analyses(id) ON DELETE CASCADE,
  student_group  text NOT NULL,
  teacher_id     text,
  class_day      date,
  student_label  text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('malo', 'bueno')),
  -- Segundos desde el inicio de la grabación.
  start_s        integer NOT NULL,
  end_s          integer NOT NULL,
  excerpt        text NOT NULL,
  -- Lo malo o lo bueno que es (1-10, de la IA): 10 = se traba muchísimo / habla genial.
  score          smallint NOT NULL CHECK (score BETWEEN 1 AND 10),
  why            text,
  fathom_url     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_moments DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_moments_pair     ON testimonial_moments (student_group, teacher_id);
CREATE INDEX IF NOT EXISTS idx_testimonial_moments_analysis ON testimonial_moments (analysis_id);

-- Una fila 'pending' por cada transcript que ya existe (sin IA: solo ids).
INSERT INTO testimonial_transcripts (analysis_id, student_group, student_name, teacher_id, class_day)
SELECT ca.id,
       COALESCE(ca.student_id, tf.student_key),
       ca.student_name,
       ca.teacher_id,
       COALESCE(ca.class_date, (ca.analyzed_at AT TIME ZONE 'Europe/Madrid')::date)
  FROM class_analyses ca
  LEFT JOIN transcript_fluency tf ON tf.analysis_id = ca.id
 WHERE ca.has_transcript
ON CONFLICT (analysis_id) DO NOTHING;

-- ── 3. Parejas: una por alumno Y PROFE ──────────────────────────────────────
ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS pair_teacher_id  text;
ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS student_label    text;
ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS reverse_order    boolean NOT NULL DEFAULT false;
ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS before_moment_id text;
ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS after_moment_id  text;

-- Antes: una pareja activa por alumno. Ahora: una por alumno y profe.
DROP INDEX IF EXISTS uq_testimonial_candidates_activa;
CREATE UNIQUE INDEX IF NOT EXISTS uq_testimonial_candidates_activa_profe
  ON testimonial_candidates (student_group, COALESCE(pair_teacher_id, ''))
  WHERE status <> 'descartado';

-- ── 4. Fuera lo de "Por revisar" (y los descartes automáticos de la V4) ──────
-- Se conserva lo que el admin marcó "Sirve" (listo / revisado / permiso_alumno)
-- y lo que marcó "No sirve".
-- Comprobación previa:
--   select status, discarded_by, count(*) from testimonial_candidates group by 1, 2;
DELETE FROM testimonial_candidates
 WHERE status = 'detectado'
    OR (status = 'descartado' AND discarded_by = 'ia');

NOTIFY pgrst, 'reload schema';
