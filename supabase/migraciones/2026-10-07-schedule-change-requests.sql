-- ===========================================================================
-- schedule_change_requests  --  idempotencia y auditoria de los cambios de
-- horario con el MISMO profesor (Fase 1, pedidos por el alumno desde el LMS)
--
-- Una fila por cada intento que pasa por lib/cambioHorario/core.ts: alumno
-- (por su assignment), profesor, modo, sesion antes y despues, fechas, origen y
-- como termino. Mismo comportamiento que transfer_requests:
--   'ok'        -> la misma clave devuelve el resultado guardado (resultado).
--   'en_curso'  -> la misma clave responde conflicto (EN_CURSO).
--   'error' o 'compensada' -> se puede reintentar con la misma clave.
-- Varias filas con idempotency_key NULL son validas (UNIQUE ignora los NULL).
--
-- sesion_antes / sesion_despues: { "dia": "Martes", "hora": "15:00", "duracion": 2 }
-- fecha_original / fecha_nueva: solo en modo 'puntual' (la clase que se mueve y
-- su fecha nueva). En 'fijo', fecha_nueva es la primera clase con el horario nuevo.
--
-- RLS activado y SIN politicas: solo el service role (servidor) lee y escribe.
-- Idempotente: se puede correr varias veces. ASCII puro a proposito.
-- ===========================================================================

create table if not exists public.schedule_change_requests (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text unique,
  assignment_id    text not null,
  teacher_id       text not null,
  modo             text not null check (modo in ('puntual', 'fijo')),
  sesion_antes     jsonb not null,
  sesion_despues   jsonb not null,
  fecha_original   date,
  fecha_nueva      date,
  origen           text not null check (origen in ('lms', 'admin', 'script')),
  actor            text not null,
  estado           text not null default 'en_curso'
                   check (estado in ('en_curso', 'ok', 'error', 'compensada')),
  error            text,
  resultado        jsonb,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create index if not exists idx_schedule_change_requests_assignment
  on public.schedule_change_requests (assignment_id, created_at desc);

create index if not exists idx_schedule_change_requests_estado
  on public.schedule_change_requests (estado, created_at desc);

alter table public.schedule_change_requests enable row level security;

revoke all on public.schedule_change_requests from anon, authenticated;
grant select, insert, update on public.schedule_change_requests to service_role;

-- Comprobacion: debe devolver la tabla con RLS activado.
select relname, relrowsecurity
from pg_class
where relname = 'schedule_change_requests';

-- ---------------------------------------------------------------------------
-- MANTENIMIENTO A MANO (comentado: no se ejecuta con la migracion)
--
-- 1) Filas en_curso con mas de 15 minutos (proceso interrumpido):
--
-- select id, idempotency_key, assignment_id, teacher_id, modo, sesion_antes,
--        sesion_despues, fecha_original, fecha_nueva, origen, actor, created_at
-- from public.schedule_change_requests
-- where estado = 'en_curso'
--   and created_at < now() - interval '15 minutes'
-- order by created_at;
--
-- 2) Marcar como error las YA REVISADAS (poner los ids a mano):
--
-- update public.schedule_change_requests
-- set estado = 'error',
--     error = 'Revisada a mano: quedo en_curso (proceso interrumpido)',
--     finished_at = now()
-- where estado = 'en_curso'
--   and id in ('00000000-0000-0000-0000-000000000000');
