-- ===========================================================================
-- EXTRACCION de definiciones para supabase/versionado/  --  SOLO LECTURA
--
-- No crea, no modifica y no borra nada: es un unico SELECT sobre el catalogo
-- de Postgres. Se corre en Supabase -> SQL Editor y el resultado se descarga
-- como CSV (boton "Download CSV"). Con ese CSV se generan los archivos del
-- volcado, uno por objeto.
--
-- Por que existe: la API REST de Supabase (la unica via que tiene el repo) no
-- puede ejecutar pg_get_functiondef / pg_get_viewdef, asi que la extraccion
-- tiene que hacerla una persona desde el editor.
--
-- Devuelve una fila por objeto: (orden, tipo, nombre, definicion).
--   * todas las funciones del esquema public que no vienen de una extension
--     (incluye apply_calendar_patch y cualquiera que llame),
--   * todas las vistas del esquema public (las vista_* del LMS y las demas),
--     con sus opciones (security_invoker, etc.) y sus permisos,
--   * la tabla calendar_changes: columnas, restricciones, indices, triggers,
--     RLS, politicas y permisos,
--   * los triggers de teacher_calendars (por si el historial se escribe desde
--     ahi y no desde la funcion).
--
-- ASCII puro a proposito (ver el incidente del 29/07/2026 con los acentos).
-- ===========================================================================

with
funciones as (
  select 1 as orden,
         'funcion'::text as tipo,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as nombre,
         pg_get_functiondef(p.oid)
           || coalesce(E'\n-- permisos: ' || array_to_string(p.proacl::text[], ', '), '')
           as definicion
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    )
),
vistas as (
  select 2 as orden,
         case c.relkind when 'm' then 'vista_materializada' else 'vista' end as tipo,
         c.relname::text as nombre,
         'create or replace '
           || case c.relkind when 'm' then 'materialized view ' else 'view ' end
           || 'public.' || quote_ident(c.relname)
           || coalesce(' with (' || array_to_string(c.reloptions, ', ') || ')', '')
           || E' as\n' || pg_get_viewdef(c.oid, true)
           || coalesce(E'\n-- permisos: ' || array_to_string(c.relacl::text[], ', '), '')
           as definicion
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
    )
),
cc as (
  select c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'calendar_changes' and c.relkind = 'r'
),
tabla as (
  select 3 as orden,
         'tabla'::text as tipo,
         'calendar_changes'::text as nombre,
         'create table public.calendar_changes (' || E'\n'
         || (select string_agg(
                      format('  %I %s%s%s',
                             a.attname,
                             format_type(a.atttypid, a.atttypmod),
                             case when a.attnotnull then ' not null' else '' end,
                             coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')),
                      E',\n' order by a.attnum)
             from pg_attribute a
             left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where a.attrelid = cc.oid and a.attnum > 0 and not a.attisdropped)
         || E'\n);\n\n-- restricciones\n'
         || coalesce((select string_agg(
                        format('alter table public.calendar_changes add constraint %I %s;',
                               k.conname, pg_get_constraintdef(k.oid)),
                        E'\n' order by k.conname)
                      from pg_constraint k where k.conrelid = cc.oid), '-- (ninguna)')
         || E'\n\n-- indices (incluye los que crean las restricciones)\n'
         || coalesce((select string_agg(i.indexdef || ';', E'\n' order by i.indexname)
                      from pg_indexes i
                      where i.schemaname = 'public' and i.tablename = 'calendar_changes'), '-- (ninguno)')
         || E'\n\n-- triggers\n'
         || coalesce((select string_agg(pg_get_triggerdef(t.oid, true) || ';', E'\n' order by t.tgname)
                      from pg_trigger t where t.tgrelid = cc.oid and not t.tgisinternal), '-- (ninguno)')
         || E'\n\n-- RLS\n'
         || case when cc.relrowsecurity
                 then 'alter table public.calendar_changes enable row level security;'
                 else '-- RLS desactivado' end
         || case when cc.relforcerowsecurity
                 then E'\nalter table public.calendar_changes force row level security;' else '' end
         || E'\n\n-- politicas\n'
         || coalesce((select string_agg(
                        format('create policy %I on public.calendar_changes as %s for %s to %s%s%s;',
                               pl.policyname, pl.permissive, pl.cmd,
                               array_to_string(pl.roles, ', '),
                               coalesce(' using (' || pl.qual || ')', ''),
                               coalesce(' with check (' || pl.with_check || ')', '')),
                        E'\n' order by pl.policyname)
                      from pg_policies pl
                      where pl.schemaname = 'public' and pl.tablename = 'calendar_changes'), '-- (ninguna)')
         || coalesce(E'\n\n-- permisos: ' || array_to_string(cc.relacl::text[], ', '), '')
         as definicion
  from cc
),
triggers_calendario as (
  select 4 as orden,
         'triggers'::text as tipo,
         'teacher_calendars'::text as nombre,
         coalesce((select string_agg(pg_get_triggerdef(t.oid, true) || ';', E'\n' order by t.tgname)
                   from pg_trigger t
                   where t.tgrelid = 'public.teacher_calendars'::regclass and not t.tgisinternal),
                  '-- (ninguno)') as definicion
)
select orden, tipo, nombre, definicion from funciones
union all select orden, tipo, nombre, definicion from vistas
union all select orden, tipo, nombre, definicion from tabla
union all select orden, tipo, nombre, definicion from triggers_calendario
order by orden, nombre;
