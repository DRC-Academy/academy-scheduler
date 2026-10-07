-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: vista vista_calendario_alumno
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create or replace view public.vista_calendario_alumno with (security_invoker=on) as
 WITH celdas AS (
         SELECT tc.teacher_id,
            t.name AS profesor,
            c.key AS celda,
            "substring"(c.key, '^(.*)_[^_]*$'::text) AS dia,
            "substring"(c.key, '_([^_]*)$'::text) AS hora,
            c.value ->> 'state'::text AS estado,
            NULLIF(c.value ->> 'student'::text, ''::text) AS alumno_celda,
            NULLIF(c.value ->> 'baseStudent'::text, ''::text) AS alumno_base,
            NULLIF(c.value ->> 'baseState'::text, ''::text) AS estado_base,
            NULLIF(c.value ->> 'weekDate'::text, ''::text) AS week_date,
            NULLIF(c.value ->> 'recoveryFor'::text, ''::text) AS recovery_for,
            NULLIF(c.value ->> 'rescheduledTo'::text, ''::text) AS rescheduled_to
           FROM teacher_calendars tc
             JOIN teachers t ON t.id = tc.teacher_id AND t.archived_at IS NULL
             CROSS JOIN LATERAL jsonb_each(
                CASE
                    WHEN jsonb_typeof(tc.grid) = 'object'::text THEN tc.grid
                    ELSE '{}'::jsonb
                END) c(key, value)
          WHERE jsonb_typeof(c.value) = 'object'::text
        ), nombres AS (
         SELECT celdas.teacher_id,
            celdas.profesor,
            celdas.celda,
            celdas.dia,
            celdas.hora,
            celdas.estado,
            celdas.alumno_celda,
            celdas.alumno_base,
            celdas.estado_base,
            celdas.week_date,
            celdas.recovery_for,
            celdas.rescheduled_to,
            n_1.nombre
           FROM celdas
             CROSS JOIN LATERAL ( SELECT celdas.alumno_celda AS nombre
                UNION ALL
                 SELECT celdas.alumno_base
                  WHERE lower(btrim(celdas.alumno_base)) IS DISTINCT FROM lower(btrim(celdas.alumno_celda))) n_1
          WHERE n_1.nombre IS NOT NULL
        ), alumnos AS (
         SELECT regexp_replace(translate(lower(btrim(a.student_name)), 'áàäâéèëêíìïîóòöôúùüûñç'::text, 'aaaaeeeeiiiioooouuuunc'::text), '\s+'::text, ' '::text, 'g'::text) AS nombre_norm,
            min(a.student_id) AS alumno_id
           FROM assignments a
          WHERE a.student_id IS NOT NULL AND btrim(COALESCE(a.student_name, ''::text)) <> ''::text
          GROUP BY (regexp_replace(translate(lower(btrim(a.student_name)), 'áàäâéèëêíìïîóòöôúùüûñç'::text, 'aaaaeeeeiiiioooouuuunc'::text), '\s+'::text, ' '::text, 'g'::text))
         HAVING count(DISTINCT a.student_id) = 1
        )
 SELECT al.alumno_id,
    n.nombre AS nombre_en_celda,
    n.teacher_id,
    n.profesor,
    n.celda,
    n.dia,
    n.hora,
    n.estado,
    n.alumno_celda,
    n.alumno_base,
    n.estado_base,
    n.week_date,
    n.recovery_for,
    n.rescheduled_to,
    asg.start_date AS asignacion_inicio,
    asg.created_at AS asignacion_alta,
    st.created_at AS alumno_alta,
    baja.dropped_at AS baja,
    asg.meet_link
   FROM nombres n
     JOIN alumnos al ON al.nombre_norm = regexp_replace(translate(lower(btrim(n.nombre)), 'áàäâéèëêíìïîóòöôúùüûñç'::text, 'aaaaeeeeiiiioooouuuunc'::text), '\s+'::text, ' '::text, 'g'::text)
     LEFT JOIN LATERAL ( SELECT a.start_date,
            a.created_at,
            a.meet_link
           FROM assignments a
          WHERE a.teacher_id = n.teacher_id AND lower(btrim(a.student_name)) = lower(btrim(n.nombre))
          ORDER BY a.created_at DESC
         LIMIT 1) asg ON true
     LEFT JOIN LATERAL ( SELECT s.created_at
           FROM students s
          WHERE lower(btrim(s.name)) = lower(btrim(n.nombre))
          ORDER BY s.created_at DESC
         LIMIT 1) st ON true
     LEFT JOIN LATERAL ( SELECT max(d.dropped_at) AS dropped_at
           FROM student_dropouts d
          WHERE d.teacher_id = n.teacher_id AND lower(btrim(d.student_name)) = lower(btrim(n.nombre))) baja ON true;
-- permisos: postgres=arwdDxtm/postgres, anon=awdDxtm/postgres, authenticated=awdDxtm/postgres, service_role=arwdDxtm/postgres
