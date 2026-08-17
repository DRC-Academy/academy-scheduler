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
-- LA LISTA DE ESLABONES YA NO SE ESCRIBE A MANO (07/08/2026)
--
-- La versión anterior llevaba la cadena escrita a mano, auditada contra
-- producción el 03/08/2026, y afirmaba que `progress_tokens` guardaba
-- `student_id` como texto plano sin foreign key. En producción SÍ la tiene
-- (`progress_tokens_student_id_fkey`), aunque supabase-progress-tokens.sql no la
-- declara: la tabla se creó en Supabase con el `references` y el archivo del
-- repo nunca lo reflejó. Resultado: el borrado de Sandra Mesa Blanco reventó
-- con esa constraint, exactamente el mismo fallo que este archivo decía haber
-- resuelto.
--
-- Añadir 'progress_tokens' a la lista habría repetido el error una vez más: la
-- siguiente tabla que alguien cree con un `references students(id)` volvería a
-- romperlo, y nadie se enteraría hasta el próximo borrado. Así que la cadena se
-- DESCUBRE del catálogo de Postgres (pg_constraint) en cada ejecución. Lo que la
-- base sabe de sí misma no puede quedar desactualizado en un comentario.
--
-- CÓMO SE TRATA CADA ESLABÓN DESCUBIERTO
--   · assignments y student_profiles  → los borra su propio paso (5 y 4).
--   · tablas de PURGA (v_purge)       → se BORRAN las filas del alumno.
--   · el resto, columna nulificable   → se NULIFICA (nunca se destruye dato).
--   · el resto, columna NOT NULL      → BLOQUEA con un mensaje que la nombra, en
--     vez de reventar con el error críptico de Postgres. Hay que decidir a mano
--     si esa tabla se borra o se nulifica, y añadirla acá.
--
-- POR QUÉ progress_tokens SE BORRA Y NO SE NULIFICA
-- /progreso/[token] resuelve por `student_id` y, si viene null, CAE AL NOMBRE
-- (app/progreso/[token]/page.tsx). Un token nulificado seguiría sirviendo la
-- ficha y las clases de un alumno ya eliminado, durante los 30 días de vigencia
-- del link y a quien tenga la URL. Nulificar acá no es conservador: es una fuga.
--
-- NO son eslabones: churn_snapshots, student_dropouts e intervention_audits
-- guardan `student_id` como TEXTO PLANO, sin foreign key. Nunca bloquean el
-- borrado y NO se tocan (son la retención y el dataset de churn).
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
--
-- ESTE ARCHIVO SE ESCRIBIÓ EL 07/08/2026 Y NO SE CORRIÓ HASTA EL 17/08/2026
--
-- Durante diez días el repo tuvo el arreglo y la base siguió con la versión del
-- 03/08 (la de la lista escrita a mano), así que el borrado volvió a reventar con
-- progress_tokens_student_id_fkey — en Tatiana Souto Comesaña y otra vez en
-- Sandra Mesa Blanco, el mismo caso que la cabecera decía haber cerrado. Un
-- `create or replace` en un archivo del repo no cambia nada hasta que alguien lo
-- pega en Supabase.
--
-- Por eso ahora la comparación «lo que la base tiene» contra «lo que la cadena
-- limpia» se puede hacer desde el panel en cualquier momento, sin adivinar y sin
-- leer este comentario: la responde `student_fk_map()`, al final del archivo.
-- Si su columna `trato` dice BLOQUEA en alguna fila, el borrado va a fallar por
-- esa tabla y hay que decidir qué hacer con ella ANTES de intentarlo.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── La lista de purga, en UN solo lugar ──────────────────────────────────────
-- Tablas cuyas filas se BORRAN con el alumno en vez de nulificarse, porque sin él
-- no significan nada y dejarlas vivas es una fuga (ver la cabecera).
--
-- Vive en su propia función porque la leen DOS: el borrado y el mapa de FKs. Con
-- la lista copiada en cada una, la primera vez que alguien añadiera una tabla al
-- borrado, el mapa habría empezado a mentir — que es exactamente el fallo que
-- este archivo lleva dos rondas arrastrando, pero en el catálogo.
create or replace function student_cascade_purge_tables()
returns text[]
language sql
immutable
as $$
  select array['progress_tokens']::text[];
$$;

grant execute on function student_cascade_purge_tables() to anon, authenticated, service_role;

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
$$;

-- El borrado lo dispara el panel de admin desde el navegador (anon) y el webhook
-- de Woo desde el servidor. Mismos permisos que ya tenían sobre las tablas: la
-- función no concede nada nuevo, solo lo hace en una transacción.
grant execute on function delete_student_cascade(text[], text, boolean) to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- student_fk_map() — QUÉ CUELGA DEL ALUMNO Y QUÉ VA A HACER LA CADENA CON ELLO
--
-- Devuelve, del catálogo de Postgres, TODAS las foreign keys que apuntan a
-- students o a assignments, y junto a cada una el `trato` que le va a dar
-- delete_student_cascade. No es documentación: son las mismas reglas y la misma
-- lista de purga que ejecuta el borrado, resueltas contra el esquema real.
--
-- POR QUÉ EXISTE
-- Dos veces se creyó saber qué tablas colgaban del alumno leyendo los archivos
-- del repo, y las dos veces el repo no era la base: progress_tokens tenía una
-- foreign key que ningún .sql declaraba, y el borrado reventó en producción con
-- un error críptico de Postgres. Preguntárselo a la base cuesta una llamada.
--
-- SOLO LECTURA: no escribe nada. Se puede llamar en cualquier momento.
--
-- USO
--   select student_fk_map();
--   select jsonb_pretty(student_fk_map());   -- legible en el editor de Supabase
--
-- CÓMO SE LEE `trato`
--   PASO PROPIO → la borra su propio paso del borrado (assignments, perfiles).
--   PURGA       → sus filas se borran con el alumno.
--   NULIFICA    → se suelta la referencia; la fila y sus datos se conservan.
--   BLOQUEA     → el borrado va a abortar nombrando esa tabla, sin tocar nada.
--                 Hay que decidir a mano si va a la purga o se nulifica, y
--                 añadirla arriba. NO se adivina.
--
-- Las tablas que guardan `student_id` como TEXTO PLANO (churn_snapshots,
-- student_dropouts, intervention_audits) NO salen acá, y es correcto: sin
-- foreign key nunca bloquean el borrado y son la retención y el dataset de
-- churn, que sobreviven al alumno a propósito.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function student_fk_map()
returns jsonb
language plpgsql
stable
as $$
declare
  v_handled text[] := array['assignments', 'student_profiles'];
  v_purge   text[] := student_cascade_purge_tables();
  v_never   text[] := array['deleted_students_backup'];
  v_out     jsonb  := '[]'::jsonb;
  v_n       bigint;
  v_trato   text;
  f         record;
begin
  for f in
    select src.relname::text as tbl,
           att.attname::text as col,
           tgt.relname::text as padre,
           c.conname::text   as cons,
           att.attnotnull    as not_null,
           array_length(c.conkey, 1) as ncols
      from pg_constraint c
      join pg_class     src on src.oid = c.conrelid
      join pg_class     tgt on tgt.oid = c.confrelid
      join pg_namespace n   on n.oid   = src.relnamespace
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
     where c.contype = 'f' and n.nspname = 'public'
       and tgt.relname in ('students', 'assignments')
     order by tgt.relname, src.relname, att.attname
  loop
    execute format('select count(*) from %I', f.tbl) into v_n;

    -- El mismo orden de decisiones que los bucles del borrado, o el mapa
    -- estaría describiendo una cadena distinta de la que corre.
    -- v_handled y v_never solo valen para las FK contra students: son los pasos 4
    -- y 5, que borran por student_id. Lo que cuelgue de assignments(id) lo trata
    -- el bucle del paso 2, que no las consulta.
    v_trato := case
      when f.ncols > 1 then 'BLOQUEA: foreign key de varias columnas; la cadena solo trata las de una'
      when f.padre = 'students' and f.tbl = any(v_handled) then 'PASO PROPIO: la borra su propio paso'
      when f.padre = 'students' and f.tbl = any(v_never)   then 'BLOQUEA: es la copia de seguridad, no se puede soltar'
      when f.tbl = any(v_purge) then 'PURGA: sus filas se borran con el alumno'
      when f.not_null           then 'BLOQUEA: columna NOT NULL, no se puede nulificar'
      else                           'NULIFICA: se suelta la referencia y la fila se conserva'
    end;

    v_out := v_out || jsonb_build_object(
      'tabla_hija',    f.tbl,
      'columna',       f.col,
      'tabla_padre',   f.padre,
      'constraint',    f.cons,
      'not_null',      f.not_null,
      'columnas_fk',   f.ncols,
      'filas_totales', v_n,
      'trato',         v_trato);
  end loop;

  return v_out;
end;
$$;

grant execute on function student_fk_map() to anon, authenticated, service_role;
