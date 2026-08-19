-- ─────────────────────────────────────────────────────────────────────────────
-- Circulares "a todos EXCEPTO": exclusiones por notificación.
--
-- Hasta ahora una circular solo se podía expresar de dos maneras:
--   · target_role = 'teacher'  → todo el equipo
--   · target_user = '<id>'     → un profesor
--
-- Para "todos menos dos" la alternativa sin tocar el esquema era insertar UNA
-- FILA POR DESTINATARIO: con 29 profesores, 27 filas idénticas por envío, que
-- ensucian el historial del admin y crecen sin parar. Con esta columna la
-- circular sigue siendo UNA fila y es cada cliente quien descarta la suya.
--
-- `not null default '[]'` rellena TAMBIÉN las filas que ya existen. Importa: un
-- null haría que las comprobaciones de pertenencia devolvieran null en vez de
-- false, y una notificación antigua podría dejar de verse sin motivo.
--
-- Idempotente: se puede correr las veces que haga falta.
-- ─────────────────────────────────────────────────────────────────────────────

alter table notifications
  add column if not exists excluded_users jsonb not null default '[]'::jsonb;

comment on column notifications.excluded_users is
  'Ids de usuario que NO deben ver esta notificación aunque encajen con target_role. Lo usan las circulares "todos excepto".';

-- Comprobación rápida tras correrlo:
--   select id, title, target_role, excluded_users
--   from notifications
--   where jsonb_array_length(excluded_users) > 0
--   order by created_at desc;
