-- ── Pausas de los alumnos (variación "Pausa" de WooCommerce) ─────────────────
--
-- QUÉ ES. Un alumno está EN PAUSA cuando su suscripción activa de Woo tiene una
-- de las variaciones de Pausa (lib/subscriptions/pause.ts). Ese estado lo decide
-- WooCommerce; esta tabla solo GUARDA CUÁNDO empezó y cuándo terminó cada pausa,
-- para tres cosas que el estado en vivo no puede dar:
--
--   · "En pausa desde el …" en el badge;
--   · que las clases proyectadas de los días en pausa no salgan como
--     "No ingresó" en asistencias, registro de clases, uso de la plataforma…
--     (lib/studentPeriod, también DESPUÉS de reactivar);
--   · que los procesos del servidor (métricas, payouts, retención) sepan quién
--     está en pausa sin preguntar a WooCommerce alumno por alumno.
--
-- NO ES UN CAMPO MANUAL. La escriben solo /api/check-subscription (cada vez que
-- se verifica a un alumno) y el cron /api/cron/sync-pausas (una vez al día, con
-- todas las suscripciones). Abren una fila al ver la Pausa y la cierran
-- (ended_on) al ver que ya no está. Nadie la edita a mano.
--
-- FECHAS. started_on = día (hora de Madrid) del primer pedido de Pausa de la
-- racha actual; si no se encuentra, el día en que se detectó. ended_on = día en
-- que se detectó la reactivación: ese día YA tiene clases (la pausa cubre
-- [started_on, ended_on) ).
--
-- SIN CLAVE FORÁNEA a students A PROPÓSITO: una FK nueva hacia students bloquea
-- el borrado total de alumnos (scripts/eliminar-alumno.mts recorre la cadena).
-- Una fila huérfana no molesta: nadie la lee sin el alumno.
--
-- Es aditiva: no toca ninguna tabla existente. Sin correrla, todo sigue como
-- antes (el estado "En pausa" en vivo funciona igual; solo faltan las fechas).

create table if not exists student_pauses (
  id            text primary key default ('sp_' || replace(gen_random_uuid()::text, '-', '')),
  student_id    text not null,
  student_name  text not null,
  student_email text not null,
  started_on    date not null,
  ended_on      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint student_pauses_range check (ended_on is null or ended_on >= started_on)
);

-- Una sola pausa ABIERTA por alumno: si dos verificaciones se cruzan, la
-- segunda inserción falla con 23505 y el código la da por buena.
create unique index if not exists student_pauses_one_open
  on student_pauses (student_id) where ended_on is null;

create index if not exists student_pauses_student on student_pauses (student_id);
