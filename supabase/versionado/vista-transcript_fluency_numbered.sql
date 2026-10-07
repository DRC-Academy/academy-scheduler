-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: vista transcript_fluency_numbered
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create or replace view public.transcript_fluency_numbered as
 SELECT tf.analysis_id,
    tf.student_key,
    tf.status,
    tf.skip_reason,
    tf.word_count,
    tf.speaker_count,
    tf.teacher_speaker,
    tf.student_speaker,
    tf.fluency_score,
    tf.unscorable_reason,
    tf.student_talk_share,
    tf.hesitation_level,
    tf.spanish_usage,
    tf.fluency_evidence,
    tf.best_excerpt,
    tf.best_excerpt_at,
    tf.best_excerpt_found,
    tf.worst_excerpt,
    tf.worst_excerpt_at,
    tf.worst_excerpt_found,
    tf.fathom_url,
    tf.model,
    tf.attempts,
    tf.last_error,
    tf.analyzed_at,
    tf.created_at,
    tf.updated_at,
    COALESCE(ca.student_id, tf.student_key) AS student_group,
    COALESCE(ca.class_date, (ca.analyzed_at AT TIME ZONE 'Europe/Madrid'::text)::date) AS class_day,
    ca.teacher_id,
    row_number() OVER (PARTITION BY (COALESCE(ca.student_id, tf.student_key)) ORDER BY (COALESCE(ca.class_date, (ca.analyzed_at AT TIME ZONE 'Europe/Madrid'::text)::date)), tf.analysis_id) AS student_class_number
   FROM transcript_fluency tf
     JOIN class_analyses ca ON ca.id = tf.analysis_id;
-- permisos: postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres
