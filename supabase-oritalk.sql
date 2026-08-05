-- ─────────────────────────────────────────────────────────────────────────────
-- Oritalk — tercer origen de "alumno activo"
--
-- Hasta ahora un alumno estaba activo por suscripción de WooCommerce o por
-- activación manual (students.manual_active_until). Oritalk es un tercer origen:
-- se marca a mano desde el panel de alumnos, cuenta como ACTIVO en todo el
-- sistema (badge, popup de "Ingresar a clase", filtros) y tiene su propia fecha
-- de fin para poder distinguirlo de la activación manual.
--
-- Por qué columnas propias y no reutilizar manual_active_until: si compartieran
-- campo no habría forma de saber si un alumno está activo "a dedo" o porque es
-- de Oritalk, y el badge azul no podría existir.
--
-- Vigencia: is_oritalk = true Y oritalk_until >= hoy (hora de España). Con la
-- fecha vencida el alumno vuelve solo a su estado real de suscripción; no hace
-- falta ningún proceso de limpieza.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table students add column if not exists is_oritalk   boolean default false;
alter table students add column if not exists oritalk_until date;

-- Los alumnos Oritalk vigentes se consultan de a uno por email (check-subscription),
-- pero el panel filtra por estado sobre la lista entera: el índice parcial evita
-- recorrer toda la tabla cuando solo unos pocos son de Oritalk.
create index if not exists idx_students_oritalk on students (is_oritalk) where is_oritalk;
