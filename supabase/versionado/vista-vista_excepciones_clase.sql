-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: vista vista_excepciones_clase
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create or replace view public.vista_excepciones_clase with (security_invoker=on) as
 WITH hoy AS (
         SELECT (now() AT TIME ZONE 'Europe/Madrid'::text)::date AS d
        ), partes AS (
         SELECT regexp_replace(translate(lower(btrim(cr.student_name)), 'áàäâéèëêíìïîóòöôúùüûñç'::text, 'aaaaeeeeiiiioooouuuunc'::text), '\s+'::text, ' '::text, 'g'::text) AS nombre_norm,
            NULLIF(btrim(cr.teacher_name), ''::text) AS profesor,
            cr.class_type,
            cr.class_date,
            COALESCE(cr.original_date, cr.class_date) AS fecha_original,
            cr.rescheduled_to,
                CASE
                    WHEN cr.class_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text THEN cr.class_time
                    ELSE NULL::text
                END AS hora_parte,
            "substring"(cr.comment, 'Reprogramada para [0-9]{4}-[0-9]{2}-[0-9]{2} (([01][0-9]|2[0-3]):[0-5][0-9])'::text) AS hora_comentario
           FROM class_records cr
             CROSS JOIN hoy hoy_1
          WHERE cr.reverted_at IS NULL AND cr.class_date >= '2025-01-01'::date AND cr.class_date <= (hoy_1.d + 365)
        ), excepciones AS (
         SELECT partes.nombre_norm,
            partes.profesor,
            partes.class_type,
            'añade'::text AS tipo,
            partes.class_date AS fecha,
            partes.hora_parte AS hora,
            false AS hora_del_comentario,
            NULL::date AS original_date
           FROM partes
          WHERE partes.class_type = 'recuperacion'::text AND partes.hora_parte IS NOT NULL
        UNION ALL
         SELECT partes.nombre_norm,
            partes.profesor,
            partes.class_type,
            'añade'::text,
            partes.rescheduled_to,
            COALESCE(partes.hora_comentario, partes.hora_parte) AS "coalesce",
            partes.hora_comentario IS NOT NULL,
            partes.fecha_original
           FROM partes
          WHERE partes.class_type = 'reprogramada'::text AND partes.rescheduled_to IS NOT NULL AND COALESCE(partes.hora_comentario, partes.hora_parte) IS NOT NULL
        UNION ALL
         SELECT partes.nombre_norm,
            partes.profesor,
            partes.class_type,
            'quita'::text,
            partes.fecha_original,
            partes.hora_parte,
            false,
            partes.fecha_original
           FROM partes
          WHERE partes.class_type = 'reprogramada'::text
        UNION ALL
         SELECT partes.nombre_norm,
            partes.profesor,
            partes.class_type,
            'quita'::text,
            partes.class_date,
            partes.hora_parte,
            false,
            NULL::date AS date
           FROM partes
          WHERE partes.class_type = ANY (ARRAY['cancelada_por_profesor'::text, 'cancelada_con_preaviso'::text, 'falta_con_aviso'::text, 'falta_sin_aviso'::text, 'cancelacion_hora'::text])
        ), alumnos AS (
         SELECT regexp_replace(translate(lower(btrim(a.student_name)), 'áàäâéèëêíìïîóòöôúùüûñç'::text, 'aaaaeeeeiiiioooouuuunc'::text), '\s+'::text, ' '::text, 'g'::text) AS nombre_norm,
            min(a.student_id) AS alumno_id
           FROM assignments a
          WHERE a.student_id IS NOT NULL AND btrim(COALESCE(a.student_name, ''::text)) <> ''::text
          GROUP BY (regexp_replace(translate(lower(btrim(a.student_name)), 'áàäâéèëêíìïîóòöôúùüûñç'::text, 'aaaaeeeeiiiioooouuuunc'::text), '\s+'::text, ' '::text, 'g'::text))
         HAVING count(DISTINCT a.student_id) = 1
        )
 SELECT DISTINCT al.alumno_id,
    e.tipo,
    e.class_type,
    e.fecha,
    e.hora,
    e.hora_del_comentario,
    e.original_date,
    e.profesor
   FROM excepciones e
     JOIN alumnos al ON al.nombre_norm = e.nombre_norm
     CROSS JOIN hoy
  WHERE e.fecha >= hoy.d AND e.fecha <= (hoy.d + 365);
-- permisos: postgres=arwdDxtm/postgres, anon=awdDxtm/postgres, authenticated=awdDxtm/postgres, service_role=arwdDxtm/postgres
