-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: vista vista_clases_contadas
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create or replace view public.vista_clases_contadas with (security_invoker=on) as
 SELECT student_id AS alumno_id,
    GREATEST(COALESCE(max(class_number) FILTER (WHERE class_number > 0), 0)::bigint, count(*))::integer AS clases_contadas
   FROM class_analyses ca
  WHERE student_id IS NOT NULL
  GROUP BY student_id;
-- permisos: postgres=arwdDxtm/postgres, anon=awdDxtm/postgres, authenticated=awdDxtm/postgres, service_role=arwdDxtm/postgres
