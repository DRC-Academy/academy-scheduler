-- ─────────────────────────────────────────────────────────────────────────────
-- Rango de horas del calendario de cada profesor
--
-- El calendario mostraba un rango fijo (09:00–22:00). Ahora cada profesor puede
-- ampliarlo con los botones "+ Añadir horario más temprano / más tarde" y su
-- preferencia se guarda acá para que se mantenga entre sesiones.
--
-- Límites absolutos de la app: 00:00 (start) y 23:00 (end): el día entero. Las
-- 00:00 en España son las 19:00 en Argentina, así que la medianoche es horario real.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table teachers add column if not exists calendar_start_hour int default 9;
alter table teachers add column if not exists calendar_end_hour   int default 22;

update teachers set calendar_start_hour = 9  where calendar_start_hour is null;
update teachers set calendar_end_hour   = 22 where calendar_end_hour   is null;
