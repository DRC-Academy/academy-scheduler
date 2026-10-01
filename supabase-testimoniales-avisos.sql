-- ── Testimoniales, fase 4: aviso al profesor para subir la grabación ─────────
--
-- Cuando el admin pulsa "Enviar al profesor" en una mejora detectada, se crea
-- UNA fila por profesor implicado: si el alumno cambió de profe entre la clase
-- "antes" y la "después", cada uno recibe el aviso de SU grabación (la tiene en
-- su Fathom). El profesor la sube a la pestaña "Testimoniales" del sheet de
-- grabaciones y pulsa "Grabación subida" → se rellena `uploaded_at`.
--
--   notified_at  = "Notificación enviada al profesor" (lo que ve el admin)
--   uploaded_at  = "Subida" (lo marca el profesor)
--
-- Sin FK a teachers, a propósito: igual que testimonial_candidates, para no
-- interferir con el borrado/archivado de profesores. Se borra sola si se borra
-- la pareja.
--
-- Aditivo, idempotente y reversible: DROP TABLE testimonial_recording_requests;
-- Requiere haber corrido antes supabase-testimoniales-candidatos.sql.

CREATE TABLE IF NOT EXISTS testimonial_recording_requests (
  id               text PRIMARY KEY,
  candidate_id     text NOT NULL REFERENCES testimonial_candidates(id) ON DELETE CASCADE,
  teacher_id       text NOT NULL,
  -- Qué grabaciones le tocan a este profesor: 'antes', 'despues' o las dos.
  sides            text[] NOT NULL,

  notified_at      timestamptz NOT NULL DEFAULT now(),
  notification_id  text,
  email_sent       boolean NOT NULL DEFAULT false,
  -- Cuántas veces se le ha avisado (el admin puede reenviar si no la sube).
  times_notified   integer NOT NULL DEFAULT 1,

  uploaded_at      timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (candidate_id, teacher_id),
  CHECK (sides <@ ARRAY['antes', 'despues']::text[] AND cardinality(sides) > 0)
);

-- Igual que el resto de tablas: el servidor y los paneles escriben con la clave anon.
ALTER TABLE testimonial_recording_requests DISABLE ROW LEVEL SECURITY;

-- El panel del profesor busca sus grabaciones pendientes en cada carga.
CREATE INDEX IF NOT EXISTS idx_testimonial_requests_teacher_pending
  ON testimonial_recording_requests (teacher_id) WHERE uploaded_at IS NULL;

-- Comprobación: debe devolver 0 sin error.
-- select count(*) from testimonial_recording_requests;
