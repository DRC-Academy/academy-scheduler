-- ── progress_tokens ──────────────────────────────────────────────────────────
-- Un link público y de solo lectura por alumno, para que vea su propio progreso
-- en /progreso/[token]. Mismo patrón que form_tokens.
--
-- OJO (seguridad): igual que el resto del esquema, la tabla queda con RLS
-- deshabilitada y la página pública lee con la clave anónima. Eso significa que
-- quien tenga la anon key puede listar todos los tokens. El link en sí no es
-- adivinable (uuid v4) y expira a los 30 días, pero NO es un secreto fuerte.
-- Ver la nota en el README del módulo antes de exponer datos más sensibles.

-- OJO — DERIVA CORREGIDA (07/08/2026): este archivo declaraba `student_id text`
-- a secas, pero en producción la tabla se creó CON la foreign key
-- (`progress_tokens_student_id_fkey`). Por esa diferencia, el borrado en cascada
-- daba por hecho que esta tabla nunca bloqueaba y reventó al eliminar a Sandra
-- Mesa Blanco. Se declara acá para que un entorno nuevo salga igual que el vivo;
-- delete_student_cascade ya no depende de este archivo (descubre las FK del
-- catálogo), pero el repo no puede seguir describiendo un esquema que no es.

create table if not exists progress_tokens (
  id           text primary key,
  token        text not null unique,
  student_id   text references students(id),
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
