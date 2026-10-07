-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: vista vista_ultima_clase
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create or replace view public.vista_ultima_clase with (security_invoker=true) as
 SELECT DISTINCT ON (student_id) student_id AS alumno_id,
    class_date AS fecha_clase,
    class_title AS titulo,
    topics_covered AS temas,
    errors_detected AS errores,
    progress_notes AS notas_progreso,
    next_class_guide AS guia_proxima,
    analyzed_at AS analizado_en
   FROM class_analyses c
  WHERE student_id IS NOT NULL AND analysis_status = 'ready'::text AND (validation_status = ANY (ARRAY['auto_approved'::text, 'approved'::text, 'ok'::text]))
  ORDER BY student_id, class_date DESC, analyzed_at DESC;
-- permisos: postgres=arwdDxtm/postgres, service_role=arwdDxtm/postgres
