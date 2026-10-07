-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: funcion delete_student_cascade(p_ids text[], p_student_name text, p_dry_run boolean)
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.delete_student_cascade(p_ids text[], p_student_name text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_asg_ids      text[] := '{}';
  v_repaired_ids text[] := '{}';
  v_blockers     text[] := '{}';
  v_n            bigint;
  v_cnt          bigint;
  v_dest         text;
  r              record;
  v_repaired     jsonb := '[]'::jsonb;
  v_cleared      jsonb := '{}'::jsonb;
  v_deleted      jsonb := '{}'::jsonb;
  v_preserved    jsonb := '{}'::jsonb;
  v_name_nk      text  := lower(btrim(coalesce(p_student_name, '')));
  f              record;
  -- Tablas que tienen su propio paso más abajo: el bucle genérico no las toca.
  v_handled      text[] := array['assignments', 'student_profiles'];
  -- Las que se borran en vez de nulificarse. La lista está arriba del archivo,
  -- compartida con student_fk_map() para que las dos digan siempre lo mismo.
  v_purge        text[] := student_cascade_purge_tables();
  -- Tablas que NUNCA se tocan aunque el catálogo las devuelva. La copia de
  -- seguridad es lo único que queda del alumno después del borrado: si algún día
  -- alguien le pone una foreign key a students, nulificar esa columna dejaría la
  -- copia huérfana — sin restaurar y sin la idempotencia que evita duplicarla en
  -- cada reintento. Se BLOQUEA con nombre y lo decide una persona.
  v_never        text[] := array['deleted_students_backup'];
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

  v_blockers := '{}'::text[];

  -- ── 2. NIVEL 2: soltar lo que cuelga de esas assignments ─────────────────
  -- La lista sale del CATÁLOGO, no de un array escrito a mano: cualquier tabla
  -- que referencie assignments(id) queda cubierta sin volver a tocar esto.
  for f in
    select src.relname::text as tbl, att.attname::text as col, att.attnotnull as not_null
      from pg_constraint c
      join pg_class     src on src.oid = c.conrelid
      join pg_class     tgt on tgt.oid = c.confrelid
      join pg_namespace n   on n.oid   = src.relnamespace
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
     where c.contype = 'f' and n.nspname = 'public'
       and tgt.relname = 'assignments'
       and array_length(c.conkey, 1) = 1
     order by src.relname
  loop
    if f.tbl = any(v_purge) then
      if p_dry_run then
        execute format('select count(*) from %I where %I = any($1)', f.tbl, f.col)
          into v_n using v_asg_ids;
      else
        execute format('delete from %I where %I = any($1)', f.tbl, f.col) using v_asg_ids;
        get diagnostics v_n = row_count;
      end if;
      if v_n > 0 then v_deleted := v_deleted || jsonb_build_object(f.tbl, v_n); end if;
      continue;
    end if;

    if f.not_null then
      v_blockers := v_blockers || format(
        '%s.%s apunta a assignments y es NOT NULL: no se puede nulificar. Decidí a mano si esa tabla se borra (v_purge) o se conserva.',
        f.tbl, f.col);
      continue;
    end if;

    if p_dry_run then
      execute format('select count(*) from %I where %I = any($1)', f.tbl, f.col)
        into v_n using v_asg_ids;
    else
      execute format('update %I set %I = null where %I = any($1)', f.tbl, f.col, f.col)
        using v_asg_ids;
      get diagnostics v_n = row_count;
    end if;
    if v_n > 0 then
      v_cleared := v_cleared || jsonb_build_object(f.tbl || '.' || f.col, v_n);
    end if;
  end loop;

  -- ── 3. NIVEL 1: soltar las referencias a students(id) ────────────────────
  -- Por defecto NULIFICAR, no borrar: class_analyses conserva student_name,
  -- teacher_id, class_date y transcript, que es todo lo que lee finanzas.
  -- Las de `v_purge` sí se borran (ver la cabecera: un progress_token nulificado
  -- sigue sirviendo la ficha del alumno por su nombre).
  for f in
    select src.relname::text as tbl, att.attname::text as col, att.attnotnull as not_null
      from pg_constraint c
      join pg_class     src on src.oid = c.conrelid
      join pg_class     tgt on tgt.oid = c.confrelid
      join pg_namespace n   on n.oid   = src.relnamespace
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
     where c.contype = 'f' and n.nspname = 'public'
       and tgt.relname = 'students'
       and array_length(c.conkey, 1) = 1
     order by src.relname
  loop
    continue when f.tbl = any(v_handled);   -- assignments y student_profiles: pasos 4 y 5

    -- Solo puede aparecer acá: la copia de seguridad guarda las assignments como
    -- jsonb, nunca por id, así que jamás cuelga de assignments(id).
    if f.tbl = any(v_never) then
      v_blockers := v_blockers || format(
        '%s.%s apunta a students y es la copia de seguridad del alumno: soltarla la dejaría huérfana. Hay que decidir a mano.',
        f.tbl, f.col);
      continue;
    end if;

    if f.tbl = any(v_purge) then
      if p_dry_run then
        execute format('select count(*) from %I where %I = any($1)', f.tbl, f.col)
          into v_n using p_ids;
      else
        execute format('delete from %I where %I = any($1)', f.tbl, f.col) using p_ids;
        get diagnostics v_n = row_count;
      end if;
      if v_n > 0 then v_deleted := v_deleted || jsonb_build_object(f.tbl, v_n); end if;
      continue;
    end if;

    if f.not_null then
      v_blockers := v_blockers || format(
        '%s.%s apunta a students y es NOT NULL: no se puede nulificar. Decidí a mano si esa tabla se borra (v_purge) o se conserva.',
        f.tbl, f.col);
      continue;
    end if;

    if p_dry_run then
      execute format('select count(*) from %I where %I = any($1)', f.tbl, f.col)
        into v_n using p_ids;
    else
      execute format('update %I set %I = null where %I = any($1)', f.tbl, f.col, f.col)
        using p_ids;
      get diagnostics v_n = row_count;
    end if;
    if v_n > 0 then
      v_cleared := v_cleared || jsonb_build_object(f.tbl || '.' || f.col, v_n);
    end if;
  end loop;

  -- Una tabla NOT NULL que no sabemos tratar corta acá, ANTES de borrar nada, y
  -- con su nombre en el mensaje. Es el mismo criterio que el pre-flight: no se
  -- adivina, y lo que ya se nulificó lo revierte la transacción.
  if array_length(v_blockers, 1) is not null then
    raise exception E'No se puede eliminar a "%": hay tablas que apuntan a su ficha y no se pueden soltar solas:\n%\nNo se ha modificado nada.',
      p_student_name, array_to_string(v_blockers, E'\n');
  end if;

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
    -- Misma consulta al catálogo que el paso 3: se comprueban TODAS las FK que
    -- existen ahora mismo, no las que había el día que se escribió esto. Es lo
    -- que convierte el error críptico de Postgres en un mensaje con nombre.
    for f in
      select src.relname::text as tbl, att.attname::text as col
        from pg_constraint c
        join pg_class     src on src.oid = c.conrelid
        join pg_class     tgt on tgt.oid = c.confrelid
        join pg_namespace n   on n.oid   = src.relnamespace
        join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
       where c.contype = 'f' and n.nspname = 'public'
         and tgt.relname = 'students'
         and array_length(c.conkey, 1) = 1
       order by src.relname
    loop
      execute format('select count(*) from %I where %I = any($1)', f.tbl, f.col)
        into v_n using p_ids;
      if v_n > 0 then
        v_blockers := v_blockers || format('%s.%s: %s fila(s)', f.tbl, f.col, v_n);
      end if;
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
$function$

-- permisos: =X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres
