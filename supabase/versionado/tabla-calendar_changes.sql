-- ===========================================================================
-- VOLCADO de producción, NO es una migración. No ejecutar.
-- Objeto: tabla calendar_changes
-- Extraído el 2026-10-07 con supabase/versionado/_extraer-definiciones.sql
-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.
-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.
-- ===========================================================================
create table public.calendar_changes (
  id uuid not null default gen_random_uuid(),
  teacher_id text not null,
  teacher_name text,
  student_name text not null,
  assignment_id text,
  day text not null,
  hour text not null,
  action text not null,
  actor_role text,
  actor_name text,
  origin text not null,
  detail jsonb,
  created_at timestamp with time zone not null default now()
);

-- restricciones
alter table public.calendar_changes add constraint calendar_changes_action_check CHECK ((action = ANY (ARRAY['agregado'::text, 'quitado'::text, 'renombrado'::text])));
alter table public.calendar_changes add constraint calendar_changes_origin_check CHECK ((origin = ANY (ARRAY['profesor'::text, 'admin'::text, 'alumnos'::text, 'setter'::text, 'clases'::text, 'sistema'::text, 'restauracion'::text])));
alter table public.calendar_changes add constraint calendar_changes_pkey PRIMARY KEY (id);

-- indices (incluye los que crean las restricciones)
CREATE UNIQUE INDEX calendar_changes_pkey ON public.calendar_changes USING btree (id);
CREATE INDEX idx_calendar_changes_assignment ON public.calendar_changes USING btree (assignment_id);
CREATE INDEX idx_calendar_changes_student ON public.calendar_changes USING btree (lower(student_name), created_at DESC);
CREATE INDEX idx_calendar_changes_teacher ON public.calendar_changes USING btree (teacher_id, created_at DESC);

-- triggers
-- (ninguno)

-- RLS
-- RLS desactivado

-- politicas
-- (ninguna)

-- permisos: postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres
