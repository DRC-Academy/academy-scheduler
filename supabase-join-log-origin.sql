-- IP y navegador del ingreso a clase del profesor (class_join_logs).
--
-- Por qué: prueba de servicio ante disputas de pago ("no recibí las clases").
-- Desde ahora el ingreso lo escribe el servidor (app/api/class-join), que es el
-- único que ve la IP y el user agent de quien pulsa "Ingresar a clase".
--
-- Solo AÑADE dos columnas nullable. No toca filas existentes: los ingresos
-- anteriores y los manuales del admin (source = 'manual') quedan con null.
-- La nómina (lib/finance.ts) no lee estas columnas.
--
-- Mientras no se ejecute, el ingreso se guarda igual sin ellas
-- (lib/classJoinStore reintenta sin ip/user_agent). Es idempotente.

alter table class_join_logs add column if not exists ip         text;
alter table class_join_logs add column if not exists user_agent text;

comment on column class_join_logs.ip is
  'IP de quien pulsó "Ingresar a clase" (cf-connecting-ip → 1.º de x-forwarded-for → x-real-ip). Null en ingresos manuales y anteriores al 22/10/2026.';
comment on column class_join_logs.user_agent is
  'User agent de quien pulsó "Ingresar a clase", recortado a 500 caracteres. Null en ingresos manuales y anteriores al 22/10/2026.';

-- Que PostgREST vea las columnas nuevas sin esperar a recargar el esquema.
notify pgrst, 'reload schema';

-- COMPROBAR
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_name = 'class_join_logs' and column_name in ('ip', 'user_agent');
-- Esperado: 2 filas, text, YES.

-- VUELTA ATRÁS
-- alter table class_join_logs drop column if exists ip;
-- alter table class_join_logs drop column if exists user_agent;
