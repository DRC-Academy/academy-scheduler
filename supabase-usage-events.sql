-- ─────────────────────────────────────────────────────────────────────────────
-- Uso de la plataforma por profesor: EVENTOS DE USO + FOTO DIARIA DEL CALENDARIO.
--
-- Alimenta el dashboard "Uso de la plataforma" de la pestaña Profesores del
-- admin (/api/admin/teacher-usage). Dos huecos que la base no podía contestar:
--
-- 1) usage_events — acciones del profesor que no dejaban rastro, o que lo dejaban
--    en una columna que se SOBRESCRIBE:
--      risk_alert_opened        abrió una alerta de riesgo (campanita o pestaña
--                               Seguimiento de la ficha con intervención abierta).
--                               Antes no quedaba NADA.
--      level_confirmed          confirmó o corrigió el nivel del alumno. La
--                               columna teacher_confirmed_at guarda solo la
--                               ÚLTIMA vez; esto guarda cada una.
--      transcript_first_upload  primera subida del transcript de una clase.
--                               class_analyses.analyzed_at se reescribe al
--                               "Reemplazar transcript" y no hay created_at, así
--                               que una subida a tiempo reemplazada después
--                               parecía tardía.
--
-- 2) scheduled_class_snapshots — el calendario solo guarda el horario ACTUAL. Para
--    medir "entró con el link" en semanas pasadas había que proyectar el horario
--    de hoy hacia atrás, y un alumno que cambió de hora o de profesor salía mal.
--    El cron diario que ya existe (daily-transcript-reminder, 22:00 UTC) guarda
--    cada noche las clases programadas del día que termina. NO es un cron nuevo:
--    el plan Hobby de Vercel solo admite tres.
--
-- Solo metadatos, ni transcripciones ni contenidos (egress: ver
-- supabase-has-transcript.sql). Sin FK a teachers, a propósito: las FK son lo
-- que impide borrar/archivar profesores y un log no debe bloquear nada.
--
-- HISTÓRICO: no lo hay. Todo empieza a contar en cuanto se corre esto y se
-- despliega el código. Mientras tanto la app funciona igual: las escrituras son
-- best-effort y el dashboard marca esas semanas "sin datos".
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente. Como
-- el resto del sistema, RLS queda deshabilitado.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists usage_events (
  id           uuid primary key default gen_random_uuid(),
  teacher_id   text,
  teacher_name text,
  event        text not null check (event in ('risk_alert_opened', 'level_confirmed', 'transcript_first_upload')),
  student_id   text,
  student_name text,
  -- Id de lo que se tocó: la notificación, el análisis (class_analyses.id)...
  ref_id       text,
  -- Detalle corto (de dónde vino, nivel anterior y nuevo...). Nunca textos largos.
  meta         jsonb,
  created_at   timestamptz not null default now()
);

alter table usage_events disable row level security;

create index if not exists idx_usage_events_created on usage_events (created_at desc);
create index if not exists idx_usage_events_event   on usage_events (event, created_at desc);
create index if not exists idx_usage_events_ref     on usage_events (ref_id);

comment on table usage_events is 'Eventos de uso del profesor para el dashboard de uso. Solo metadatos.';


create table if not exists scheduled_class_snapshots (
  -- teacher_id|alumno normalizado|fecha|hora de inicio: la misma clase no se
  -- guarda dos veces aunque el cron se reintente.
  id             text primary key,
  teacher_id     text not null,
  teacher_name   text,
  student_name   text not null,
  class_date     date not null,      -- fecha ESPAÑOLA de la clase
  start_hour     int  not null,      -- hora de pared española
  duration_hours int  not null default 1,
  is_recovery    boolean not null default false,
  created_at     timestamptz not null default now()
);

alter table scheduled_class_snapshots disable row level security;

create index if not exists idx_sched_snap_date on scheduled_class_snapshots (class_date);

comment on table scheduled_class_snapshots is 'Clases programadas de cada día según el calendario de esa noche (cron daily-transcript-reminder).';

-- ── Verificación ─────────────────────────────────────────────────────────────
--   select event, count(*) from usage_events group by event;
--   select class_date, count(*) from scheduled_class_snapshots group by class_date order by class_date desc;
