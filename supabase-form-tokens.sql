-- ─────────────────────────────────────────────────────────────────────────────
-- Migración: Formulario inicial del alumno (link único — Opción B)
--
--   · form_tokens      → un link único por alumno para completar el formulario
--   · student_profiles → respuestas del formulario + ficha generada por IA
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- Nota: en este proyecto las tablas usan RLS deshabilitado y la clave anónima
-- (mismo patrón que el resto del sistema), por eso el formulario público puede
-- leer el token sin login.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists form_tokens (
  id            text primary key,
  token         text not null unique,
  student_id    text references students(id),
  student_name  text not null,
  student_email text,
  teacher_id    text references teachers(id),
  teacher_name  text not null,
  assignment_id text references assignments(id),
  plan          text,
  level         text,
  status        text default 'pending',           -- 'pending' | 'completed' | 'expired'
  expires_at    timestamptz default (now() + interval '30 days'),
  completed_at  timestamptz,
  created_at    timestamptz default now()
);

alter table form_tokens disable row level security;

-- Por si la tabla ya existía sin todas las columnas (p. ej. se corrió antes una
-- versión previa del DDL): agregamos las que falten. Idempotente.
alter table form_tokens add column if not exists student_id    text;
alter table form_tokens add column if not exists student_email text;
alter table form_tokens add column if not exists teacher_id    text;
alter table form_tokens add column if not exists assignment_id text;
alter table form_tokens add column if not exists plan          text;
alter table form_tokens add column if not exists level         text;
alter table form_tokens add column if not exists status        text default 'pending';
alter table form_tokens add column if not exists expires_at    timestamptz default (now() + interval '30 days');
alter table form_tokens add column if not exists completed_at  timestamptz;

create index if not exists idx_form_tokens_token      on form_tokens (token);
create index if not exists idx_form_tokens_student     on form_tokens (student_id);
create index if not exists idx_form_tokens_status      on form_tokens (status);

-- ── student_profiles ─────────────────────────────────────────────────────────
-- La ficha del alumno: guarda las respuestas crudas del formulario (jsonb) y la
-- ficha + primera clase generadas por IA. Se identifica por el id del alumno.
create table if not exists student_profiles (
  id             text primary key,                 -- = student_id del alumno
  student_id     text references students(id),
  student_name   text,
  form_token_id  text references form_tokens(id),
  form_responses jsonb,
  ai_ficha       text,
  ai_status      text default 'pending',           -- 'pending'|'ready'|'error'|'skipped'
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

alter table student_profiles disable row level security;

-- Por si la tabla ya existía sin estas columnas (migración parcial previa):
alter table student_profiles add column if not exists student_name   text;
alter table student_profiles add column if not exists form_token_id  text;
alter table student_profiles add column if not exists form_responses jsonb;
alter table student_profiles add column if not exists ai_ficha       text;
alter table student_profiles add column if not exists ai_status      text default 'pending';
alter table student_profiles add column if not exists updated_at     timestamptz default now();

create index if not exists idx_student_profiles_student on student_profiles (student_id);
