-- ⚠️ NO CORRER TODAVÍA — PLANIFICADO PARA SEPTIEMBRE DE 2026 ⚠️
--
-- `assignments.start_date` es `text`. Nada impide guardar basura ahí, y el día
-- que alguien escriba '05/10/2026' en vez de '2026-10-05' toda la comparación de
-- fechas del sistema deja de funcionar EN SILENCIO: las comparaciones son entre
-- cadenas ('05/10/2026' < '2026-01-01' es true), así que ese alumno pasaría a
-- tener clases desde el principio de los tiempos.
--
-- Desde que la fecha de inicio decide QUÉ CLASES EXISTEN (ver lib/studentPeriod),
-- esa columna dejó de ser un metadato y pasó a ser parte del cálculo. Le
-- corresponde el tipo real.
--
-- POR QUÉ NO AHORA: se liquida el mes el 31 de agosto. Un ALTER TYPE sobre una
-- columna que alimenta el período de cada alumno no se hace en la semana del
-- pago. En septiembre, con el mes cerrado.
--
-- ANTES DE CORRERLO:
--   1. Comprobar que TODOS los valores parsean (la consulta de abajo tiene que
--      devolver 0 filas). Al 26/08/2026: 190 con valor, 2 nulas, todas en
--      formato 'YYYY-MM-DD'.
--   2. Hacer copia de la tabla.
--   3. Correr fuera de horario de clases.

-- ── 1. COMPROBACIÓN PREVIA ───────────────────────────────────────────────────
-- Tiene que devolver CERO filas. Si devuelve alguna, corregir esos valores a
-- mano ANTES de convertir: el ALTER falla entero con un solo valor malo.
select id, teacher_name, student_name, start_date
from assignments
where start_date is not null
  and start_date !~ '^\d{4}-\d{2}-\d{2}$';

-- ── 2. CONVERSIÓN ────────────────────────────────────────────────────────────
-- `using` explícito: sin él Postgres no sabe convertir text → date.
-- Las nulas se quedan nulas (el código ya cae a `created_at`, ver periodOf).
alter table assignments
  alter column start_date type date
  using nullif(trim(start_date), '')::date;

-- ── 3. VALIDACIÓN ────────────────────────────────────────────────────────────
-- Ninguna fecha de inicio puede ser anterior a la fundación de la academia ni
-- más de un año en el futuro: las dos cosas son errores de tipeo, no casos
-- reales, y hoy pasarían sin que nadie las viera.
alter table assignments
  add constraint assignments_start_date_razonable
  check (start_date is null or (start_date >= date '2024-01-01' and start_date <= current_date + interval '1 year'));

-- ── 4. DESPUÉS DE CORRERLO ───────────────────────────────────────────────────
-- El código NO necesita cambios: `mapAssignment` ya lee la columna como cadena y
-- PostgREST serializa un `date` como 'YYYY-MM-DD', que es exactamente el formato
-- que espera `lib/studentPeriod.toIsoDate`. Verificar igualmente:
--   · /revisiones sigue listando lo mismo
--   · el embudo de Finanzas sigue cuadrando
--   · asignar un alumno nuevo guarda bien la fecha
