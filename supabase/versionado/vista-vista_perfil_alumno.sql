-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: vista vista_perfil_alumno
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create or replace view public.vista_perfil_alumno as
 SELECT base.alumno_id,
    base.email,
    base.nombre,
    base.nivel,
    base.plan,
    base.producto,
    base.objetivo_setter,
    base.profesor,
    base.ocupacion,
    base.objetivo_perfil,
    base.puntos_fuertes,
    base.puntos_debiles,
    base.estilo_aprendizaje,
    base.foco_recomendado,
    base.respuestas_formulario,
    base.tiene_perfil,
    base.fecha_inicio,
    base.horas_semanales,
    base.plan_contratado,
    base.nivel_profesor,
    base.nivel_ficha,
    base.nivel_prueba,
    cla.meet_link,
    cla.slots
   FROM ( SELECT base_1.alumno_id,
            base_1.email,
            base_1.nombre,
            base_1.nivel,
            base_1.plan,
            base_1.producto,
            base_1.objetivo_setter,
            base_1.profesor,
            base_1.ocupacion,
            base_1.objetivo_perfil,
            base_1.puntos_fuertes,
            base_1.puntos_debiles,
            base_1.estilo_aprendizaje,
            base_1.foco_recomendado,
            base_1.respuestas_formulario,
            base_1.tiene_perfil,
            base_1.fecha_inicio,
            asg.horas AS horas_semanales,
            asg.plan AS plan_contratado,
            fic.teacher_confirmed_level AS nivel_profesor,
            fic.current_level AS nivel_ficha,
            fic.level_test_cefr AS nivel_prueba
           FROM ( SELECT s.id AS alumno_id,
                    lower(TRIM(BOTH FROM s.email)) AS email,
                    s.name AS nombre,
                    s.level AS nivel,
                    s.plan,
                    s.product_name AS producto,
                    a.objetivo AS objetivo_setter,
                    a.teacher_name AS profesor,
                    p.occupation AS ocupacion,
                    p.personal_objective AS objetivo_perfil,
                    p.strong_points AS puntos_fuertes,
                    p.weak_points AS puntos_debiles,
                    p.learning_style AS estilo_aprendizaje,
                    p.recommended_focus AS foco_recomendado,
                    p.form_responses AS respuestas_formulario,
                    p.form_completed_at IS NOT NULL AS tiene_perfil,
                    COALESCE(( SELECT min(a2.start_date) AS min
                           FROM assignments a2
                          WHERE a2.student_id = s.id AND a2.status = 'active'::text AND a2.start_date IS NOT NULL), ( SELECT min(a2.start_date) AS min
                           FROM assignments a2
                          WHERE a2.student_id = s.id AND a2.start_date IS NOT NULL)) AS fecha_inicio
                   FROM students s
                     JOIN assignments a ON a.student_id = s.id AND (a.status = 'active'::text OR NOT (EXISTS ( SELECT 1
                           FROM assignments a3
                          WHERE a3.student_id = s.id AND a3.status = 'active'::text)))
                     LEFT JOIN student_profiles p ON p.student_id = s.id) base_1
             LEFT JOIN LATERAL ( SELECT a.plan,
                        CASE
                            WHEN jsonb_typeof(a.slots) = 'array'::text AND jsonb_array_length(a.slots) > 0 THEN jsonb_array_length(a.slots)
                            WHEN COALESCE(a.weekly_hours, 0) > 0 THEN a.weekly_hours
                            ELSE NULL::integer
                        END AS horas
                   FROM assignments a
                  WHERE a.student_id = base_1.alumno_id
                  ORDER BY (GREATEST(
                        CASE
                            WHEN jsonb_typeof(a.slots) = 'array'::text THEN jsonb_array_length(a.slots)
                            ELSE 0
                        END, COALESCE(a.weekly_hours, 0))) DESC, a.created_at DESC
                 LIMIT 1) asg ON true
             LEFT JOIN LATERAL ( SELECT sp.teacher_confirmed_level,
                    sp.current_level,
                    sp.level_test_cefr
                   FROM student_profiles sp
                  WHERE sp.student_id = base_1.alumno_id
                 LIMIT 1) fic ON true) base
     LEFT JOIN LATERAL ( SELECT NULLIF(btrim(COALESCE(a.meet_link, ''::text)), ''::text) AS meet_link,
                CASE
                    WHEN jsonb_typeof(a.slots) = 'array'::text THEN a.slots
                    ELSE NULL::jsonb
                END AS slots
           FROM assignments a
          WHERE a.student_id = base.alumno_id
          ORDER BY (GREATEST(
                CASE
                    WHEN jsonb_typeof(a.slots) = 'array'::text THEN jsonb_array_length(a.slots)
                    ELSE 0
                END, COALESCE(a.weekly_hours, 0))) DESC, a.created_at DESC
         LIMIT 1) cla ON true;
-- permisos: postgres=arwdDxtm/postgres, service_role=arwdDxtm/postgres
