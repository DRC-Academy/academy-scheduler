-- ─────────────────────────────────────────────────────────────────────────────
-- Marca: "este alumno terminó el test y su profesor todavía no se ha enterado".
--
-- QUÉ PROBLEMA RESUELVE. Cuando un alumno completa el test de nivel, el sistema
-- avisa a su profesor para que lo valide. Pero un alumno puede hacer el test
-- ANTES de tener profesor asignado —es lo normal: el test se ofrece al terminar
-- el formulario, y la asignación llega después—. En ese caso no había a quién
-- avisar y el aviso se perdía para siempre: el profesor recibía al alumno sin
-- saber que tenía un nivel esperando su visto bueno.
--
-- Con esta columna el aviso queda EN ESPERA. Al asignarle profesor se manda el
-- email y la notificación, y la marca se apaga.
--
-- POR QUÉ UNA MARCA Y NO DERIVARLO. Se podría preguntar "¿tiene level_test_cefr
-- y no tiene teacher_confirmed_level?", pero eso es cierto para todos los
-- alumnos que aún no fueron validados, incluidos los que ya recibieron su aviso.
-- Volveríamos a avisar en cada asignación. La marca dice otra cosa: "hay un
-- aviso sin entregar".
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- Como el resto del sistema, RLS queda deshabilitado.
-- ─────────────────────────────────────────────────────────────────────────────

alter table student_profiles
  add column if not exists level_validation_pending boolean not null default false;

comment on column student_profiles.level_validation_pending is
  'true = el alumno completó el test de nivel sin profesor asignado y su aviso de validación está sin entregar. Se apaga al asignarle profesor y mandarle el email.';

-- Para el enganche de la asignación: se consulta por esta marca, no se escanea
-- la tabla. Índice parcial, que es el que sirve cuando lo normal es `false`.
create index if not exists idx_sp_level_validation_pending
  on student_profiles (student_id)
  where level_validation_pending;

-- ── Verificación ─────────────────────────────────────────────────────────────
-- La columna debería aparecer, y nadie debería tenerla en true todavía:
--
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name = 'student_profiles'
--      and column_name = 'level_validation_pending';
--
--   select count(*) from student_profiles where level_validation_pending;
--
-- Los alumnos que YA hicieron el test sin profesor y se quedaron sin aviso no se
-- rellenan hacia atrás a propósito: mandarles el correo hoy avisaría de tests de
-- hace meses. Si querés recuperarlos, esta es la consulta que los encuentra:
--
--   select sp.student_name, sp.level_test_cefr, sp.level_test_completed_at
--     from student_profiles sp
--    where sp.level_test_cefr is not null
--      and sp.teacher_confirmed_level is null
--      and not exists (select 1 from assignments a where a.student_id = sp.student_id)
--    order by sp.level_test_completed_at desc;
