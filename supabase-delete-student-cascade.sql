-- ─────────────────────────────────────────────────────────────────────────────
-- Borrado ATÓMICO de un alumno: toda la cadena de claves foráneas, o nada.
--
-- POR QUÉ EXISTE
-- El borrado vivía en el navegador (lib/db.ts), repartido en una docena de
-- llamadas sueltas contra PostgREST. Sin transacción, cualquier fallo a mitad
-- dejaba al alumno "a medias": sin assignments, con el grid del profesor ya
-- vaciado, pero VIVO en `students` y visible en el panel. Le pasó a Diego Ruiz,
-- a Dolores Cueto y a Virginia Alfonso Villal (auditoría del 03/08/2026).
--
-- Y fallaba siempre por lo mismo: solo se soltaban las referencias a
-- `students(id)`, nunca las que cuelgan de `assignments(id)`. Así que el DELETE
-- de assignments reventaba con form_tokens_assignment_id_fkey; al arreglar esa
-- tabla habría reventado con level_test_sessions_assignment_id_fkey, y así.
--
-- CADENA COMPLETA (auditada contra producción el 03/08/2026)
--
--   students
--   ├── assignments (student_id, NOT NULL)      → BORRAR (no se puede nulificar)
--   │   ├── form_tokens (assignment_id)         → NULIFICAR   ← rompía aquí
--   │   │   └── student_profiles (form_token_id)
--   │   └── level_test_sessions (assignment_id) → NULIFICAR   ← siguiente eslabón
--   │       └── level_test_answers (session_id, ON DELETE CASCADE)
--   ├── class_analyses (student_id)             → NULIFICAR (finanzas)
--   ├── form_tokens (student_id)                → NULIFICAR
--   ├── student_profiles (student_id)           → BORRAR
--   └── level_test_sessions (student_id)        → NULIFICAR
--
-- NO son eslabones: churn_snapshots, student_dropouts, intervention_audits y
-- progress_tokens tienen `student_id` como TEXTO PLANO, sin foreign key. Nunca
-- bloquean el borrado y NO se tocan (son la retención y el dataset de churn).
--
-- FINANZAS INTACTAS
-- `class_records` y `class_join_logs` ni siquiera tienen columna student_id:
-- cruzan por student_name, así que el borrado no las roza. `class_analyses` se
-- NULIFICA, jamás se borra: es el segundo factor de verificación del pago en
-- lib/finance.ts, y borrarlo pasaría de 'pagable' a 'a_revisar' las clases ya
-- dadas. El profesor cobra todo lo que dio.
--
-- USO
--   select delete_student_cascade(array['id1','id2'], 'Nombre Apellido');
--   select delete_student_cascade(array['id1'], 'Nombre', true);  -- ENSAYO
--
-- Con p_dry_run = true no escribe NADA: devuelve el mismo informe con lo que
-- haría. Es el pre-flight que pide el panel antes de confirmar.
--
-- Todo corre dentro de la transacción implícita de la llamada: cualquier
-- `raise exception` revierte hasta el primer update. No hay estados a medias.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function delete_student_cascade(
  p_ids          text[],
  p_student_name text,
  p_dry_run      boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_asg_ids      text[] := '{}';
  v_repaired_ids text[] := '{}';
  v_blockers     text[] := '{}';
  v_tbl          text;
  v_n            bigint;
  v_cnt          bigint;
  v_dest         text;
  r              record;
  v_repaired     jsonb := '[]'::jsonb;
  v_cleared      jsonb := '{}'::jsonb;
  v_deleted      jsonb := '{}'::jsonb;
  v_preserved    jsonb := '{}'::jsonb;
  v_name_nk      text  := lower(btrim(coalesce(p_student_name, '')));
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    raise exception 'delete_student_cascade: hacen falta las ids del alumno.';
  end if;
  if v_name_nk = '' then
    raise exception 'delete_student_cascade: hace falta el nombre del alumno.';
  end if;

  -- ── 0. PRE-FLIGHT ────────────────────────────────────────────────────────
  -- Filas de `assignments` que apuntan a esta ficha con el NOMBRE de otro
  -- alumno (vínculos corruptos; ver la auditoría del 27/07/2026). Si el nombre
  -- resuelve a UNA sola ficha real, se re-apunta ahí (es lo correcto con o sin
  -- borrado). Si no resuelve o es ambiguo, NO se adivina: bloquea el borrado
  -- entero antes de haber tocado nada.
  for r in
    select a.id, a.student_name, a.teacher_name
      from assignments a
     where a.student_id = any(p_ids)
       and lower(btrim(coalesce(a.student_name, ''))) <> v_name_nk
  loop
    select count(*), min(s.id) into v_cnt, v_dest
      from students s
     where lower(btrim(coalesce(s.name, ''))) = lower(btrim(coalesce(r.student_name, '')))
       and not (s.id = any(p_ids));

    if v_cnt = 1 then
      if not p_dry_run then
        update assignments set student_id = v_dest where id = r.id;
      end if;
      v_repaired_ids := v_repaired_ids || r.id;
      v_repaired := v_repaired || jsonb_build_object(
        'assignment', r.id, 'student_name', r.student_name,
        'teacher', r.teacher_name, 'reapuntada_a', v_dest);
    else
      v_blockers := v_blockers || format(
        '%s · %s (assignment %s) — su nombre resuelve a %s fichas, no a una',
        coalesce(r.student_name, '(sin nombre)'), coalesce(r.teacher_name, '?'), r.id, v_cnt);
    end if;
  end loop;

  if array_length(v_blockers, 1) is not null then
    raise exception E'No se puede eliminar a "%": % fila(s) de assignments apuntan a su ficha con el nombre de OTRO alumno y no se pueden reasignar solas:\n%\nNo se ha modificado nada.',
      p_student_name, array_length(v_blockers, 1), array_to_string(v_blockers, E'\n');
  end if;

  -- ── 1. Qué assignments se van ────────────────────────────────────────────
  -- Por id (menos las que acabamos de reparar, que ya son de otro) y por
  -- nombre normalizado, pero SOLO las huérfanas: una fila con el mismo nombre
  -- que cuelga de otra ficha viva es de otro alumno homónimo y no se toca.
  select coalesce(array_agg(a.id), '{}'::text[]) into v_asg_ids
    from assignments a
   where (a.student_id = any(p_ids) and not (a.id = any(v_repaired_ids)))
      or (lower(btrim(coalesce(a.student_name, ''))) = v_name_nk
          and not exists (select 1 from students s
                           where s.id = a.student_id and not (s.id = any(p_ids))));

  -- ── 2. NIVEL 2: soltar lo que cuelga de esas assignments ─────────────────
  -- Esto es lo que faltaba y hacía fallar el borrado una tabla por vez.
  foreach v_tbl in array array['form_tokens', 'level_test_sessions'] loop
    if to_regclass('public.' || v_tbl) is null then continue; end if;
    begin
      if p_dry_run then
        execute format('select count(*) from %I where assignment_id = any($1)', v_tbl)
          into v_n using v_asg_ids;
      else
        execute format('update %I set assignment_id = null where assignment_id = any($1)', v_tbl)
          using v_asg_ids;
        get diagnostics v_n = row_count;
      end if;
      if v_n > 0 then
        v_cleared := v_cleared || jsonb_build_object(v_tbl || '.assignment_id', v_n);
      end if;
    exception
      when undefined_column then null;  -- migración de ese módulo sin correr
    end;
  end loop;

  -- ── 3. NIVEL 1: soltar las referencias a students(id) ────────────────────
  -- Nulificar, NO borrar: class_analyses conserva student_name, teacher_id,
  -- class_date y transcript, que es todo lo que lee finanzas.
  foreach v_tbl in array array['class_analyses', 'form_tokens', 'level_test_sessions'] loop
    if to_regclass('public.' || v_tbl) is null then continue; end if;
    begin
      if p_dry_run then
        execute format('select count(*) from %I where student_id = any($1)', v_tbl)
          into v_n using p_ids;
      else
        execute format('update %I set student_id = null where student_id = any($1)', v_tbl)
          using p_ids;
        get diagnostics v_n = row_count;
      end if;
      if v_n > 0 then
        v_cleared := v_cleared || jsonb_build_object(v_tbl || '.student_id', v_n);
      end if;
    exception
      when undefined_column then null;
    end;
  end loop;

  -- ── 4. La ficha IA sí se borra (ya está en el backup) ────────────────────
  -- Por `id` y por `student_id`: en las altas antiguas student_profiles.id ES
  -- el student_id y la columna student_id quedó en null.
  if p_dry_run then
    select count(*) into v_n from student_profiles
     where id = any(p_ids) or student_id = any(p_ids);
  else
    delete from student_profiles where id = any(p_ids) or student_id = any(p_ids);
    get diagnostics v_n = row_count;
  end if;
  v_deleted := v_deleted || jsonb_build_object('student_profiles', v_n);

  -- ── 5. Assignments ───────────────────────────────────────────────────────
  if p_dry_run then
    v_n := coalesce(array_length(v_asg_ids, 1), 0);
  else
    delete from assignments where id = any(v_asg_ids);
    get diagnostics v_n = row_count;
  end if;
  v_deleted := v_deleted || jsonb_build_object('assignments', v_n);

  -- ── 6. RE-VERIFICACIÓN antes del DELETE de students ──────────────────────
  -- Si quedara UNA sola referencia, se lanza y la transacción revierte entera:
  -- el alumno se queda como estaba, no a medias. El mensaje nombra la tabla, en
  -- vez del error críptico de Postgres.
  if not p_dry_run then
    v_blockers := '{}'::text[];
    foreach v_tbl in array array['assignments', 'class_analyses', 'form_tokens',
                                 'student_profiles', 'level_test_sessions'] loop
      if to_regclass('public.' || v_tbl) is null then continue; end if;
      begin
        execute format('select count(*) from %I where student_id = any($1)', v_tbl)
          into v_n using p_ids;
        if v_n > 0 then
          v_blockers := v_blockers || format('%s.student_id: %s fila(s)', v_tbl, v_n);
        end if;
      exception
        when undefined_column then null;
      end;
    end loop;

    select count(*) into v_n from student_profiles where id = any(p_ids);
    if v_n > 0 then
      v_blockers := v_blockers || format('student_profiles.id: %s fila(s)', v_n);
    end if;

    if array_length(v_blockers, 1) is not null then
      raise exception E'No se puede eliminar a "%": todavía quedan referencias a su ficha después de la limpieza:\n%\nSe ha revertido TODO: la base queda como estaba.',
        p_student_name, array_to_string(v_blockers, E'\n');
    end if;

    delete from students where id = any(p_ids);
    get diagnostics v_n = row_count;
    v_deleted := v_deleted || jsonb_build_object('students', v_n);
  end if;

  -- ── 7. Informe de lo que SOBREVIVE (finanzas) ────────────────────────────
  select count(*) into v_n from class_analyses
   where lower(btrim(coalesce(student_name, ''))) = v_name_nk;
  v_preserved := v_preserved || jsonb_build_object('class_analyses', v_n);

  select count(*) into v_n from class_records
   where lower(btrim(coalesce(student_name, ''))) = v_name_nk;
  v_preserved := v_preserved || jsonb_build_object('class_records', v_n);

  select count(*) into v_n from class_join_logs
   where lower(btrim(coalesce(student_name, ''))) = v_name_nk;
  v_preserved := v_preserved || jsonb_build_object('class_join_logs', v_n);

  return jsonb_build_object(
    'ok',            true,
    'dry_run',       p_dry_run,
    'student_name',  p_student_name,
    'ids',           to_jsonb(p_ids),
    'assignment_ids', to_jsonb(v_asg_ids),
    'repaired',      v_repaired,
    'cleared',       v_cleared,
    'deleted',       v_deleted,
    'preserved',     v_preserved
  );
end;
$$;

-- El borrado lo dispara el panel de admin desde el navegador (anon) y el webhook
-- de Woo desde el servidor. Mismos permisos que ya tenían sobre las tablas: la
-- función no concede nada nuevo, solo lo hace en una transacción.
grant execute on function delete_student_cascade(text[], text, boolean) to anon, authenticated, service_role;
