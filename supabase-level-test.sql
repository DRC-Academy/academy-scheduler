-- ─────────────────────────────────────────────────────────────────────────────
-- Migración: Test de Nivel de Inglés (link único por candidato — igual que el
-- formulario inicial, ver supabase-form-tokens.sql).
--
--   · level_test_questions → banco de preguntas (reading + writing)
--   · level_test_sessions  → una sesión por link, vinculada al alumno
--   · level_test_answers   → respuesta a cada pregunta
--   · + columnas level_test_* en student_profiles (para reflejar el resultado en
--     la ficha del alumno, misma tabla/ficha que usa el formulario)
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase, y luego el seed
-- (supabase-level-test-seed.sql). Es idempotente. Como el resto del sistema, RLS
-- queda deshabilitado y se usa la clave anónima (el link público lee sin login).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Banco de preguntas ───────────────────────────────────────────────────────
create table if not exists level_test_questions (
  id            uuid primary key default gen_random_uuid(),
  section       text not null check (section in ('reading_completion', 'reading_passage', 'reading_email', 'writing')),
  cefr_level    text not null check (cefr_level in ('A1','A2','B1','B2','C1','C2')),
  difficulty    int  not null check (difficulty between 1 and 6),  -- 1=A1 … 6=C2

  -- Reading (opción múltiple)
  prompt_text     text,     -- pasaje / email a leer (para passage/email)
  question_text   text,     -- la pregunta
  options         jsonb,    -- ["opción a","opción b","opción c","opción d"]
  correct_answer  int,      -- índice 0–3 de la correcta

  -- Writing
  writing_prompt             text,
  writing_min_words          int default 50,
  writing_evaluation_criteria jsonb,

  is_active   boolean default true,
  created_at  timestamptz default now()
);

alter table level_test_questions disable row level security;

create index if not exists idx_lt_questions_section_level on level_test_questions (section, cefr_level, is_active);
create index if not exists idx_lt_questions_difficulty     on level_test_questions (difficulty);

-- ── Sesiones (una por link) ──────────────────────────────────────────────────
create table if not exists level_test_sessions (
  id             uuid primary key default gen_random_uuid(),
  token          text unique not null,

  -- Datos del candidato
  candidate_name  text not null,
  candidate_email text not null,
  candidate_phone text,

  -- Vínculo al alumno (igual que form_tokens) — permite reflejar el resultado en la ficha
  student_id     text references students(id),
  student_name   text,
  student_email  text,
  teacher_id     text references teachers(id),
  teacher_name   text,
  assignment_id  text references assignments(id),
  plan           text,
  level          text,

  -- Estado
  status       text not null default 'pending' check (status in ('pending','in_progress','completed','expired')),
  started_at   timestamptz,
  completed_at timestamptz,
  expires_at   timestamptz not null default (now() + interval '7 days'),

  -- Resultados
  reading_score numeric(5,2),
  writing_score numeric(5,2),
  overall_score numeric(5,2),
  cefr_level    text,
  ai_evaluation jsonb,          -- evaluación IA del writing (resumen)

  -- Tracking adaptativo
  current_difficulty  int default 3,                 -- arranca en B1
  questions_answered  jsonb default '[]'::jsonb,     -- ids de preguntas ya usadas
  current_question_id text,                          -- pregunta actual (fija al recargar)

  created_at timestamptz default now()
);

alter table level_test_sessions disable row level security;

-- Por si la tabla ya existía sin todas las columnas (migración parcial previa):
alter table level_test_sessions add column if not exists candidate_phone   text;
alter table level_test_sessions add column if not exists student_id        text;
alter table level_test_sessions add column if not exists student_name      text;
alter table level_test_sessions add column if not exists student_email     text;
alter table level_test_sessions add column if not exists teacher_id        text;
alter table level_test_sessions add column if not exists teacher_name      text;
alter table level_test_sessions add column if not exists assignment_id     text;
alter table level_test_sessions add column if not exists plan              text;
alter table level_test_sessions add column if not exists level             text;
alter table level_test_sessions add column if not exists ai_evaluation     jsonb;
alter table level_test_sessions add column if not exists current_difficulty  int default 3;
alter table level_test_sessions add column if not exists questions_answered  jsonb default '[]'::jsonb;
alter table level_test_sessions add column if not exists current_question_id text;

create index if not exists idx_lt_sessions_token   on level_test_sessions (token);
create index if not exists idx_lt_sessions_email   on level_test_sessions (candidate_email);
create index if not exists idx_lt_sessions_student on level_test_sessions (student_id);
create index if not exists idx_lt_sessions_status  on level_test_sessions (status);

-- ── Respuestas ───────────────────────────────────────────────────────────────
create table if not exists level_test_answers (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid references level_test_sessions(id) on delete cascade,
  question_id  uuid references level_test_questions(id),
  section      text not null,
  difficulty   int,

  -- Reading
  selected_answer int,
  is_correct      boolean,

  -- Writing
  written_response text,
  ai_score         numeric(5,2),
  ai_feedback      jsonb,   -- {grammar, vocabulary, coherence, task_completion, ...}

  answered_at        timestamptz default now(),
  time_spent_seconds int
);

alter table level_test_answers disable row level security;

create index if not exists idx_lt_answers_session on level_test_answers (session_id);

-- ── Reflejo del resultado en la ficha del alumno ─────────────────────────────
-- student_profiles ya existe (supabase-form-tokens.sql / supabase-ai-module.sql).
-- Agregamos las columnas del test para que la ficha muestre el nivel junto al
-- resto (mismo patrón que la ficha del formulario).
alter table student_profiles add column if not exists level_test_cefr         text;
alter table student_profiles add column if not exists level_test_score        numeric(5,2);
alter table student_profiles add column if not exists level_test_completed_at  timestamptz;
alter table student_profiles add column if not exists level_test_evaluation    jsonb;
alter table student_profiles add column if not exists level_test_session_id    text;
