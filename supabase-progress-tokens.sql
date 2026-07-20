-- ── progress_tokens ──────────────────────────────────────────────────────────
-- Un link público y de solo lectura por alumno, para que vea su propio progreso
-- en /progreso/[token]. Mismo patrón que form_tokens.
--
-- OJO (seguridad): igual que el resto del esquema, la tabla queda con RLS
-- deshabilitada y la página pública lee con la clave anónima. Eso significa que
-- quien tenga la anon key puede listar todos los tokens. El link en sí no es
-- adivinable (uuid v4) y expira a los 30 días, pero NO es un secreto fuerte.
-- Ver la nota en el README del módulo antes de exponer datos más sensibles.

create table if not exists progress_tokens (
  id           text primary key,
  token        text not null unique,
  student_id   text,
  teacher_id   text,
  student_name text not null,
  expires_at   timestamptz default (now() + interval '30 days'),
  created_at   timestamptz default now()
);

alter table progress_tokens disable row level security;

-- Columnas añadidas después (no-op si ya existen).
alter table progress_tokens add column if not exists student_id   text;
alter table progress_tokens add column if not exists teacher_id   text;
alter table progress_tokens add column if not exists expires_at   timestamptz default (now() + interval '30 days');

create index if not exists idx_progress_tokens_token   on progress_tokens (token);
create index if not exists idx_progress_tokens_student on progress_tokens (student_id);
