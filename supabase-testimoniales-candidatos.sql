-- ── Testimoniales, fase 2: parejas "antes / después" candidatas ─────────────
--
-- Una fila por pareja de clases del mismo alumno: una vieja donde se trababa y
-- una reciente donde habla con soltura (notas de transcript_fluency, ver
-- supabase-testimoniales.sql). La detecta el código sin IA; una segunda
-- revisión con Haiku confirma que la mejora parece real; el admin la lleva por
-- los estados desde la pestaña "Testimoniales".
--
--   detectado → revisado → permiso_alumno → listo      (o descartado)
--
-- SIN FK A students NI A assignments, a propósito: el borrado total de un alumno
-- (delete_student_cascade) descubre las FK del catálogo y una nueva sin decidir
-- bloquearía la eliminación de TODOS los alumnos. El alumno va como texto plano,
-- igual que churn_snapshots o student_dropouts. Las únicas FK son a
-- class_analyses, que no se borra nunca (es la verificación del pago).
--
-- Aditivo, idempotente y reversible: DROP TABLE testimonial_candidates;
-- Requiere haber corrido antes supabase-testimoniales.sql.

CREATE TABLE IF NOT EXISTS testimonial_candidates (
  id                  text PRIMARY KEY,

  -- Alumno: misma agrupación que la vista transcript_fluency_numbered.
  student_group       text NOT NULL,
  student_id          text,
  student_name        text,

  -- Clase "antes" (se trababa). Foto del momento de la detección.
  before_analysis_id  text NOT NULL REFERENCES class_analyses(id) ON DELETE CASCADE,
  before_teacher_id   text,
  before_class_number integer,
  before_class_date   date,
  before_score        smallint,
  before_excerpt      text,
  before_excerpt_at   text,
  before_fathom_url   text,

  -- Clase "después" (habla con soltura).
  after_analysis_id   text NOT NULL REFERENCES class_analyses(id) ON DELETE CASCADE,
  after_teacher_id    text,
  after_class_number  integer,
  after_class_date    date,
  after_score         smallint,
  after_excerpt       text,
  after_excerpt_at    text,
  after_fathom_url    text,

  improvement         smallint NOT NULL,

  -- Segunda revisión con IA (Haiku). 'pending' = aún no se hizo (o se cortó).
  ai_review_status    text NOT NULL DEFAULT 'pending'
                      CHECK (ai_review_status IN ('pending', 'ready', 'failed')),
  ai_is_real          boolean,
  ai_reason           text,
  ai_summary          text,
  ai_error            text,

  status              text NOT NULL DEFAULT 'detectado'
                      CHECK (status IN ('detectado', 'revisado', 'permiso_alumno', 'listo', 'descartado')),
  -- Quién la descartó: la IA en la segunda revisión o el admin a mano.
  discarded_by        text CHECK (discarded_by IN ('ia', 'admin')),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  admin_notes         text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (before_analysis_id <> after_analysis_id)
);

-- Igual que el resto de tablas: el servidor y el panel escriben con la clave anon.
ALTER TABLE testimonial_candidates DISABLE ROW LEVEL SECURITY;

-- Máximo UNA pareja activa por alumno (activa = cualquier estado menos descartado).
CREATE UNIQUE INDEX IF NOT EXISTS uq_testimonial_candidates_activa
  ON testimonial_candidates (student_group) WHERE status <> 'descartado';

CREATE INDEX IF NOT EXISTS idx_testimonial_candidates_status  ON testimonial_candidates (status);
CREATE INDEX IF NOT EXISTS idx_testimonial_candidates_student ON testimonial_candidates (student_group);

-- Comprobación: debe devolver 0 sin error.
-- select count(*) from testimonial_candidates;
