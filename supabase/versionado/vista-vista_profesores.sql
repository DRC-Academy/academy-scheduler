-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: vista vista_profesores
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create or replace view public.vista_profesores with (security_invoker=on) as
 SELECT id AS teacher_id,
    name AS profesor
   FROM teachers t
  WHERE btrim(COALESCE(name, ''::text)) <> ''::text;
-- permisos: postgres=arwdDxtm/postgres, anon=awdDxtm/postgres, authenticated=awdDxtm/postgres, service_role=arwdDxtm/postgres
