-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: funcion student_cascade_purge_tables()
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.student_cascade_purge_tables()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select array[
    'progress_tokens',        -- un token nulificado sigue sirviendo la ficha por nombre
    'level_test_followups'    -- recordatorios ya enviados; NOT NULL, sin el alumno no valen
  ]::text[];
$function$

-- permisos: =X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres
