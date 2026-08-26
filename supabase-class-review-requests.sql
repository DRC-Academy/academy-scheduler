-- ── Solicitudes de revisión de clases SIN ingreso registrado ─────────────────
--
-- El problema: una clase solo entra a finanzas si hay un class_join_log (el clic
-- en "Ingresar a clase"). Cuando el profesor entra por el enlace directo de Meet,
-- o el alumno no se presenta y no llega a pulsar el botón, la clase NO EXISTE
-- para el pago: no aparece ni como pendiente, y no hay forma de reclamarla.
--
-- Esta tabla es esa vía. El profesor declara la clase y QUÉ pasó en ella; queda
-- 'pendiente' y NO paga sola. El admin la valida y es esa validación la que crea
-- el class_join_log (source='manual') y/o el class_record correspondiente.
--
-- Los tres tipos que puede declarar el profesor:
--   'normal'           → dio la clase. Exige transcript (se guarda por la vía de
--                        siempre en class_analyses; sin join_log no cobra).
--   'falta_sin_aviso'  → el alumno no se presentó. Sin transcript. Cobra a tarifa
--                        normal, consume cupo del alumno, tope de 2 por mes.
--   'falta_con_aviso'  → el alumno avisó / no se dio la clase. No paga, no penaliza.
--
-- El admin puede RECLASIFICAR al validar (resolved_type), incluidos los dos tipos
-- que al profesor no se le ofrecen: 'cancelacion_hora' y 'cancelada_por_profesor'.

create table if not exists class_review_requests (
  id             text primary key,
  teacher_id     text not null references teachers(id),
  teacher_name   text not null,
  student_name   text not null,
  class_date     date not null,
  class_time     text,
  -- 2 en una sesión de celdas contiguas: el admin tiene que saber que la clase
  -- que va a habilitar vale dos, igual que en finanzas.
  duration_hours int  not null default 1,

  -- Tipo declarado por el PROFESOR.
  requested_type text not null check (requested_type in ('normal', 'falta_sin_aviso', 'falta_con_aviso')),
  -- Fila de class_analyses con el transcript, cuando requested_type = 'normal'.
  -- El texto NO se guarda acá: vive donde vive siempre, con su validación.
  analysis_id    text,
  comment        text,

  status         text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada')),
  -- Tipo con el que el admin la resolvió. Puede diferir de requested_type.
  resolved_type  text,
  review_note    text,
  reviewed_by    text,
  reviewed_at    timestamptz,
  -- class_join_log creado al aprobarla (null en las que no generan ingreso).
  join_log_id    text,
  created_at     timestamptz default now()
);

-- Una sola solicitud por clase. Es lo que impide que el profesor mande la misma
-- clase dos veces mientras la primera espera (el equivalente al problema de las
-- faltas duplicadas, que ya nos costó 5 registros de más en agosto de 2026).
create unique index if not exists class_review_requests_clase_uk
  on class_review_requests (teacher_id, lower(trim(student_name)), class_date, coalesce(class_time, ''));

create index if not exists class_review_requests_status_idx
  on class_review_requests (status, class_date desc);

alter table class_review_requests disable row level security;

-- ── Ingresos creados a mano por el admin ─────────────────────────────────────
--
-- 'click' = el profesor pulsó "Ingresar a clase" (todo lo anterior a esto).
-- 'manual' = lo creó el admin al aprobar una solicitud de revisión.
-- Finanzas los trata IGUAL a propósito: un ingreso manual aprobado por el equipo
-- vale lo mismo que un clic. La columna es para poder auditarlos, no para
-- descontarlos.
alter table class_join_logs add column if not exists source     text default 'click';
alter table class_join_logs add column if not exists created_by text;
