-- ─────────────────────────────────────────────────────────────────────────────
-- Migración: Módulo de IA (ficha estructurada + análisis de clases + riesgo)
--
--   · student_profiles.ai_ficha_json  → ficha estructurada (8 campos)
--   · student_profiles.ai_first_class → primera clase generada (JSON)
--   · student_profiles.risk_signal    → 'verde' | 'amarillo' | 'rojo'
--   · class_analyses                  → un análisis por transcripción de clase
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- Requiere que supabase-form-tokens.sql ya se haya corrido (crea student_profiles).
--
-- Nota: la columna ai_ficha (markdown) se conserva intacta. Las fichas viejas se
-- siguen viendo; las nuevas se guardan en ai_ficha_json. FichaModal prefiere el
-- JSON y cae al markdown si no hay.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── student_profiles: ficha estructurada, primera clase y riesgo ─────────────
alter table student_profiles add column if not exists ai_ficha_json  jsonb;
alter table student_profiles add column if not exists ai_first_class jsonb;
alter table student_profiles add column if not exists risk_signal    text;

-- Sólo admitimos los tres valores de la señal (o NULL = sin analizar todavía).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'student_profiles_risk_signal_check'
  ) then
    alter table student_profiles
      add constraint student_profiles_risk_signal_check
      check (risk_signal is null or risk_signal in ('verde', 'amarillo', 'rojo'));
  end if;
end $$;

create index if not exists idx_student_profiles_risk on student_profiles (risk_signal);

-- ── class_analyses ───────────────────────────────────────────────────────────
-- Un registro por transcripción analizada. Guardamos la transcripción cruda para
-- poder re-analizar sin pedírsela otra vez al profesor.
create table if not exists class_analyses (
  id               text primary key,
  student_id       text references students(id),
  student_name     text not null,
  teacher_id       text references teachers(id),
  teacher_name     text,
  class_number     integer,
  transcript       text,
  class_summary    text,
  errors_detected  text,
  progress_notes   text,
  topics_covered   text,
  risk_signal      text,
  risk_explanation text,
  next_class_guide jsonb,
  created_at       timestamptz default now()
);

alter table class_analyses disable row level security;

-- Por si la tabla ya existía de una versión previa del DDL: agregamos lo que falte.
alter table class_analyses add column if not exists student_id       text;
alter table class_analyses add column if not exists teacher_id       text;
alter table class_analyses add column if not exists teacher_name     text;
alter table class_analyses add column if not exists class_number     integer;
alter table class_analyses add column if not exists transcript       text;
alter table class_analyses add column if not exists class_summary    text;
alter table class_analyses add column if not exists errors_detected  text;
alter table class_analyses add column if not exists progress_notes   text;
alter table class_analyses add column if not exists topics_covered   text;
alter table class_analyses add column if not exists risk_signal      text;
alter table class_analyses add column if not exists risk_explanation text;
alter table class_analyses add column if not exists next_class_guide jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'class_analyses_risk_signal_check'
  ) then
    alter table class_analyses
      add constraint class_analyses_risk_signal_check
      check (risk_signal is null or risk_signal in ('verde', 'amarillo', 'rojo'));
  end if;
end $$;

create index if not exists idx_class_analyses_student on class_analyses (student_id);
create index if not exists idx_class_analyses_teacher on class_analyses (teacher_id);
create index if not exists idx_class_analyses_created on class_analyses (created_at desc);
create index if not exists idx_class_analyses_risk    on class_analyses (risk_signal);
