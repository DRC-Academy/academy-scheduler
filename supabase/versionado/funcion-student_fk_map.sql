-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: funcion student_fk_map()
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.student_fk_map()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
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
           array_length(c.conkey, 1) as ncols,
           case c.confdeltype
             when 'c' then 'cascade'
             when 'n' then 'set null'
             when 'd' then 'set default'
             when 'r' then 'restrict'
             else          'no action'
           end as on_delete
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
      'on_delete_declarado', f.on_delete,
      'columnas_fk',   f.ncols,
      'filas_totales', v_n,
      'trato',         v_trato);
  end loop;

  return v_out;
end;
$function$

-- permisos: =X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres
