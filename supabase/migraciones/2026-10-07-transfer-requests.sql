-- ===========================================================================
-- transfer_requests  --  idempotencia y auditoria de los cambios de profesor
--
-- Una fila por cada intento de transferencia que pasa por el nucleo
-- (lib/transferencia/core.ts): quien la pidio, desde donde, de que profesor a
-- cual, los horarios antes y despues y como termino.
--
-- idempotency_key: si llega dos veces la misma clave, la segunda no repite nada.
--   'ok'        -> devuelve el resultado guardado (columna resultado).
--   'en_curso'  -> responde conflicto (EN_CURSO).
--   'error' o 'compensada' -> se puede reintentar con la misma clave.
-- Varias filas con idempotency_key NULL son validas (UNIQUE ignora los NULL):
-- las transferencias sin clave quedan igualmente auditadas.
--
-- 'resultado' no estaba en la lista original: guarda el TransferenciaResultado
-- completo (nombres, avisos, efectos fallidos) para poder devolverlo tal cual en
-- un reintento sin volver a leer nada.
--
-- RLS activado y SIN politicas: solo el service role (servidor, scripts) lee y
-- escribe. Desde el navegador (anon) el nucleo recibe permiso denegado, lo avisa
-- en consola y sigue sin auditar. Ver la nota final.
--
-- Idempotente: se puede correr varias veces. ASCII puro a proposito.
-- ===========================================================================

create table if not exists public.transfer_requests (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text unique,
  assignment_id    text not null,
  from_teacher_id  text,
  to_teacher_id    text not null,
  slots_antes      jsonb,
  slots_despues    jsonb not null,
  motivo           text not null check (motivo in ('alumno', 'profesor', 'reorg', 'autoservicio')),
  origen           text not null check (origen in ('admin', 'setter', 'script', 'lms')),
  actor            text not null,
  estado           text not null default 'en_curso'
                   check (estado in ('en_curso', 'ok', 'error', 'compensada')),
  error            text,
  resultado        jsonb,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create index if not exists idx_transfer_requests_assignment
  on public.transfer_requests (assignment_id, created_at desc);

create index if not exists idx_transfer_requests_estado
  on public.transfer_requests (estado, created_at desc);

alter table public.transfer_requests enable row level security;

-- Sin politicas para anon/authenticated. Ademas se quitan los permisos de tabla,
-- para que no dependa solo de que nadie cree una politica por error.
revoke all on public.transfer_requests from anon, authenticated;
grant select, insert, update on public.transfer_requests to service_role;

-- Comprobacion: debe devolver la tabla con RLS activado.
select relname, relrowsecurity
from pg_class
where relname = 'transfer_requests';

-- NOTA: mientras el modal del panel siga corriendo en el navegador con la anon
-- key (paso 5), sus transferencias NO quedaran en esta tabla. Solo las del
-- script (service key) y, mas adelante, las del servidor.

-- ---------------------------------------------------------------------------
-- MANTENIMIENTO A MANO (comentado: no se ejecuta con la migracion)
--
-- Una fila se queda 'en_curso' si el proceso murio a mitad de la transferencia.
-- No hay caducidad automatica a proposito: reintentar sobre un estado a medias
-- es peligroso. Primero se buscan, se revisa cada caso (calendarios de los dos
-- profesores y la asignacion) y solo entonces se marcan como error, lo que
-- permite reintentar con la misma clave.
--
-- 1) Filas en_curso con mas de 15 minutos:
--
-- select id, idempotency_key, assignment_id, from_teacher_id, to_teacher_id,
--        slots_antes, slots_despues, motivo, origen, actor, created_at
-- from public.transfer_requests
-- where estado = 'en_curso'
--   and created_at < now() - interval '15 minutes'
-- order by created_at;
--
-- 2) Marcar como error las YA REVISADAS (poner los ids a mano):
--
-- update public.transfer_requests
-- set estado = 'error',
--     error = 'Revisada a mano: quedo en_curso (proceso interrumpido)',
--     finished_at = now()
-- where estado = 'en_curso'
--   and id in ('00000000-0000-0000-0000-000000000000');
