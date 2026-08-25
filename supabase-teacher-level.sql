-- ─────────────────────────────────────────────────────────────────────────────
-- Nivel confirmado por el PROFESOR (respaldo humano a la prueba automática).
--
-- La prueba de nivel asigna un CEFR el primer día; el profesor, tras 2-3 clases,
-- tiene mejor criterio. Estas columnas guardan SU nivel, SIN pisar el de la
-- prueba: `level_test_cefr` queda intacto para poder medir después cuánto
-- acierta la prueba comparándola con el criterio de los profesores.
--
-- Regla de uso (una sola implementación: lib/effectiveLevel.ts):
--     nivel efectivo = teacher_confirmed_level  →  current_level
--                   →  level_test_cefr          →  assignments.student_level
-- El primero que sea un CEFR reconocible gana.
--
-- Ojo con `current_level`: está en el orden por fidelidad al comportamiento
-- anterior, pero HOY no la escribe ningún código (verificado en agosto/2026).
-- En la práctica siempre es NULL, así que no compite con nada.
--
-- `teacher_confirmed_by` guarda el NOMBRE del profesor, no su id: es lo que se
-- muestra en la ficha y en el admin, y sobrevive a que el profesor se borre
-- (dbDeleteTeacher preserva el historial, ver supabase-delete-student-cascade).
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table student_profiles add column if not exists teacher_confirmed_level text;
alter table student_profiles add column if not exists teacher_confirmed_at    timestamptz;
alter table student_profiles add column if not exists teacher_confirmed_by    text;

comment on column student_profiles.teacher_confirmed_level is
  'CEFR que el profesor observa en clase. Manda sobre level_test_cefr para ficha, generación de clases con IA y página de progreso. NULL = el profesor todavía no se pronunció.';
comment on column student_profiles.teacher_confirmed_at is
  'Cuándo lo confirmó por última vez. Se reescribe en cada cambio.';
comment on column student_profiles.teacher_confirmed_by is
  'Nombre del profesor que lo confirmó.';

-- Solo A1–C2. Sin el check, un valor raro escrito a mano se colaría hasta el
-- prompt de la IA. Como constraint separada y tolerante a re-ejecución: en
-- Postgres no existe `add constraint if not exists`.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'student_profiles_teacher_confirmed_level_check'
  ) then
    alter table student_profiles
      add constraint student_profiles_teacher_confirmed_level_check
      check (teacher_confirmed_level is null or teacher_confirmed_level in ('A1','A2','B1','B2','C1','C2'));
  end if;
end $$;

-- Para el panel del admin: comparar prueba vs profesor sin escanear la tabla.
create index if not exists idx_sp_teacher_confirmed
  on student_profiles (teacher_confirmed_level)
  where teacher_confirmed_level is not null;

-- ── Verificación ─────────────────────────────────────────────────────────────
-- Las tres columnas deberían aparecer:
--
--   select column_name, data_type
--     from information_schema.columns
--    where table_name = 'student_profiles'
--      and column_name like 'teacher_confirmed%'
--    order by column_name;
--
-- Y esto, la desviación de la prueba (vacío hasta que los profesores confirmen):
--
--   select level_test_cefr as prueba, teacher_confirmed_level as profesor, count(*)
--     from student_profiles
--    where teacher_confirmed_level is not null
--    group by 1, 2
--    order by 3 desc;
