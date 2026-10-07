-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: funcion apply_calendar_patch(p_teacher_id text, p_changes jsonb)
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.apply_calendar_patch(p_teacher_id text, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_grid      jsonb;
  v_before    jsonb;
  v_key       text;
  v_change    jsonb;
  v_expected  jsonb;
  v_next      jsonb;
  v_applied   jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
begin
  insert into teacher_calendars (teacher_id, grid, updated_at)
  values (p_teacher_id, '{}'::jsonb, now())
  on conflict (teacher_id) do nothing;

  select grid into v_grid
  from teacher_calendars
  where teacher_id = p_teacher_id
  for update;

  v_grid   := coalesce(v_grid, '{}'::jsonb);
  v_before := v_grid;

  for v_key, v_change in select key, value from jsonb_each(coalesce(p_changes, '{}'::jsonb)) loop
    v_expected := nullif(v_change -> 'expected', 'null'::jsonb);
    v_next     := nullif(v_change -> 'next',     'null'::jsonb);

    if (v_grid -> v_key) is not distinct from v_expected then
      if v_next is null then
        v_grid := v_grid - v_key;
      else
        v_grid := jsonb_set(v_grid, array[v_key], v_next, true);
      end if;
      v_applied := v_applied || to_jsonb(v_key);
    else
      v_conflicts := v_conflicts || to_jsonb(v_key);
    end if;
  end loop;

  if jsonb_array_length(v_applied) > 0 then
    update teacher_calendars
    set grid = v_grid, updated_at = now()
    where teacher_id = p_teacher_id;
  end if;

  return jsonb_build_object(
    'before',    v_before,
    'grid',      v_grid,
    'applied',   v_applied,
    'conflicts', v_conflicts
  );
end;
$function$

-- permisos: =X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres
