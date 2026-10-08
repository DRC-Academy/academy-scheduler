-- ════════════════════════════════════════════════════════════════════════════
-- El borrado de alumnos, solo desde el servidor
-- ════════════════════════════════════════════════════════════════════════════
--
-- Quita EXECUTE a la clave pública (anon), a authenticated y a PUBLIC sobre las
-- tres funciones de la cadena de borrado. Solo service_role (la clave del
-- servidor, SUPABASE_SERVICE_ROLE_KEY) y postgres (el editor SQL) pueden
-- llamarlas después.
--
-- NO CORRER ANTES DE DEPLOYAR la ruta /api/admin/students/delete-cascade y el
-- cambio de runDeleteCascade (lib/db.ts). Si se corre antes, el botón Eliminar
-- de /students y el webhook de bajas de Woo fallan (el botón falla en el ensayo,
-- sin borrar nada, pero DESPUÉS de haber anulado las recuperaciones del alumno).
--
-- Por qué también PUBLIC: el catálogo muestra `=X/postgres`, es decir, EXECUTE
-- para PUBLIC. anon hereda de PUBLIC, así que quitárselo solo a anon no cerraría
-- nada.
--
-- Las tres funciones son SECURITY INVOKER: delete_student_cascade y
-- student_fk_map llaman por dentro a student_cascade_purge_tables con los
-- permisos de QUIEN LLAMA. Por eso service_role conserva EXECUTE en las tres.
--
-- Ojo al volver a correr supabase-delete-student-cascade.sql: hoy termina con
-- `grant execute ... to anon, authenticated, service_role` y reabriría todo.
-- Hay que cambiar esas tres líneas a `to service_role` antes de volver a usarlo.

begin;

revoke execute on function public.delete_student_cascade(text[], text, boolean) from public, anon, authenticated;
revoke execute on function public.student_cascade_purge_tables()               from public, anon, authenticated;
revoke execute on function public.student_fk_map()                             from public, anon, authenticated;

-- Ya lo tienen; explícito para que el archivo diga el estado final completo.
grant execute on function public.delete_student_cascade(text[], text, boolean) to service_role;
grant execute on function public.student_cascade_purge_tables()               to service_role;
grant execute on function public.student_fk_map()                             to service_role;

commit;

-- ── Verificación (correr después) ──────────────────────────────────────────
-- Las tres filas tienen que dar anon = false, authenticated = false,
-- service_role = true.
--
-- select f, has_function_privilege('anon', f, 'execute')          as anon,
--           has_function_privilege('authenticated', f, 'execute') as authenticated,
--           has_function_privilege('service_role', f, 'execute')  as service_role
-- from unnest(array[
--   'public.delete_student_cascade(text[],text,boolean)',
--   'public.student_cascade_purge_tables()',
--   'public.student_fk_map()'
-- ]) as f;

-- ── Marcha atrás (solo si el botón se rompe y no hay tiempo de arreglarlo) ──
-- Devuelve exactamente los permisos de hoy.
--
-- grant execute on function public.delete_student_cascade(text[], text, boolean) to public, anon, authenticated;
-- grant execute on function public.student_cascade_purge_tables()               to public, anon, authenticated;
-- grant execute on function public.student_fk_map()                             to public, anon, authenticated;
