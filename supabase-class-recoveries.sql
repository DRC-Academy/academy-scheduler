-- ── "No puedo dar esta clase": recuperaciones de clases canceladas por el profesor ──
--
-- Una fila por TROZO a recuperar de una clase que el profesor no puede dar:
--   · clase de 1 h, o de 2 h recuperada junta → una fila (part 1 de 1);
--   · clase de 2 h "en dos días diferentes"   → dos filas de 1 h (part 1 y 2 de 2),
--     unidas por group_id. Comparten la cancelación (un solo comodín, una multa).
--
-- La lógica vive en Gestión (lib/classRecoveries.ts, lib/classRecoveryStore.ts);
-- el LMS solo lee por los endpoints /api/lms/recuperaciones y comunica lo que
-- elige el alumno. Ver docs/recuperaciones-contrato.md.
--
-- Estados:
--   esperando_alumno · el profe propuso fechas (reservadas) y el alumno elige
--   alumno_propuso   · el alumno dijo "ninguna" y propuso horarios: le toca al profe
--   confirmada       · hay fecha: celda de recuperación + constancia creadas
--   recuperada       · la recuperación se dio (hay ingreso)
--   sin_acuerdo      · sin fecha tras las rondas o con las fechas vencidas; la clase
--                      sigue a favor del alumno (su constancia sigue siendo recuperable)
--   anulada          · baja del alumno, anulación del admin…
--
-- Sin FK a students/assignments/teachers, a propósito: el borrado total de un
-- alumno descubre las FK del catálogo y una nueva sin decidir lo bloquearía para
-- TODOS (ver delete_student_cascade). Los ids van como texto.
--
-- Aditivo, idempotente y reversible:
--   DROP TABLE class_recoveries;
--   DROP INDEX IF EXISTS uq_class_records_cancelacion_profesor;

CREATE TABLE IF NOT EXISTS class_recoveries (
  id                 text PRIMARY KEY,
  group_id           text NOT NULL,
  part               smallint NOT NULL DEFAULT 1,
  parts              smallint NOT NULL DEFAULT 1,

  -- La clase cancelada
  assignment_id      text,
  teacher_id         text NOT NULL,
  teacher_name       text,
  student_id         text,
  student_name       text NOT NULL,
  student_email      text,
  original_date      date NOT NULL,
  original_hour      text NOT NULL,          -- 'HH:00' (hora de España)
  hours              smallint NOT NULL DEFAULT 1,   -- horas de ESTE trozo
  cancel_record_id   text,                   -- su constancia en class_records
  reason             text,

  -- Coste para el profesor (lo calcula el servidor)
  cancelled_at       timestamptz NOT NULL DEFAULT now(),
  cancel_month       text NOT NULL,          -- 'YYYY-MM' de la cancelación, hora de España
  notice_minutes     integer NOT NULL,
  late               boolean NOT NULL,       -- menos de 24 h
  used_wildcard      boolean NOT NULL DEFAULT false,
  penalty_euros      numeric NOT NULL DEFAULT 0,       -- 0 o -5
  would_have_penalty boolean NOT NULL DEFAULT false,   -- multa que no se cobró (antes de la fecha de inicio)
  penalty_event_id   text,                   -- scoring_events.id (se_cancel_prof_<group_id>)

  -- Acuerdo de la nueva fecha
  agreed_directly    boolean NOT NULL DEFAULT false,   -- "Ya lo acordé con el alumno"
  round              smallint NOT NULL DEFAULT 1,
  teacher_proposals  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{date, hour, hours}]
  student_proposals  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{date, hour}]
  student_note       text,
  chosen_date        date,
  chosen_hour        text,
  chosen_by          text CHECK (chosen_by IN ('alumno', 'profesor', 'acordada')),
  recovery_record_id text,                   -- constancia 'recuperacion' en class_records

  status             text NOT NULL DEFAULT 'esperando_alumno'
                     CHECK (status IN ('esperando_alumno', 'alumno_propuso', 'confirmada',
                                       'recuperada', 'sin_acuerdo', 'anulada')),
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  student_email_sent_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CHECK (part >= 1 AND part <= parts),
  CHECK (hours BETWEEN 1 AND 4),
  CHECK (round BETWEEN 1 AND 2)
);

-- Igual que el resto de tablas: el servidor y los paneles escriben con la clave anon.
ALTER TABLE class_recoveries DISABLE ROW LEVEL SECURITY;

-- UNA recuperación activa por clase (y trozo). 'sin_acuerdo' y 'anulada' no
-- bloquean: la clase se puede volver a intentar.
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_recoveries_activa
  ON class_recoveries (teacher_id, lower(trim(student_name)), original_date, original_hour, part)
  WHERE status IN ('esperando_alumno', 'alumno_propuso', 'confirmada', 'recuperada');

CREATE INDEX IF NOT EXISTS idx_class_recoveries_teacher_month ON class_recoveries (teacher_id, cancel_month);
CREATE INDEX IF NOT EXISTS idx_class_recoveries_student       ON class_recoveries (student_id);
CREATE INDEX IF NOT EXISTS idx_class_recoveries_status        ON class_recoveries (status);
CREATE INDEX IF NOT EXISTS idx_class_recoveries_group         ON class_recoveries (group_id);

-- ── Doble cancelación de la misma clase (afecta a TODOS los profesores) ─────────
-- La base impide guardar dos cancelaciones del profesor para la misma clase.
-- Solo para las NUEVAS: en el historial hay 3 duplicados (13/08, 12/09 y 17/09)
-- que harían fallar el índice; se dejan como están para revisarlos a mano.
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_records_cancelacion_profesor
  ON class_records (teacher_id, lower(trim(student_name)), class_date, coalesce(class_time, ''))
  WHERE class_type IN ('cancelada_por_profesor', 'cancelada_con_preaviso')
    AND reverted_at IS NULL
    AND created_at >= '2026-10-02T00:00:00Z';

-- Comprobación: debe devolver 0 sin error.
-- select count(*) from class_recoveries;
