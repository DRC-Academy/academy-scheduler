-- ─────────────────────────────────────────────────────────────────────────────
-- Módulo de IA — alineación del esquema
--
-- NOTA (16/07/2026): al diagnosticar el bug de "Ver ficha" se comprobó contra la
-- base real que TODAS estas columnas YA EXISTEN en producción. Este script es
-- idempotente y sirve como documentación del esquema + para replicarlo en un
-- entorno nuevo. Correrlo en producción no cambia nada.
--
-- La ficha se guarda en COLUMNAS SEPARADAS (initial_diagnosis, strong_points, …),
-- no en un JSON. Los nombres de acá son la fuente de verdad para el código.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── student_profiles ─────────────────────────────────────────────────────────
-- Sección A — perfil del alumno (del formulario inicial)
alter table student_profiles add column if not exists initial_diagnosis  text;
alter table student_profiles add column if not exists strong_points      text;
alter table student_profiles add column if not exists weak_points        text;
alter table student_profiles add column if not exists learning_style     text;
alter table student_profiles add column if not exists personal_objective text;
alter table student_profiles add column if not exists occupation         text;
alter table student_profiles add column if not exists recommended_focus  text;

-- Sección B — seguimiento clase a clase
alter table student_profiles add column if not exists current_level           text;
alter table student_profiles add column if not exists current_block           text;
alter table student_profiles add column if not exists grammar_focus           text;
alter table student_profiles add column if not exists vocabulary_focus        text;
alter table student_profiles add column if not exists risk_signal             text;
alter table student_profiles add column if not exists risk_explanation        text;
alter table student_profiles add column if not exists risk_updated_at         timestamptz;
alter table student_profiles add column if not exists progress_score          int default 5;
alter table student_profiles add column if not exists total_classes_analyzed  int default 0;
alter table student_profiles add column if not exists last_class_analyzed_at  timestamptz;
alter table student_profiles add column if not exists next_class_content      jsonb;
alter table student_profiles add column if not exists next_class_generated_at timestamptz;
alter table student_profiles add column if not exists teacher_id              text;
alter table student_profiles add column if not exists form_completed_at       timestamptz;

-- ai_ficha (markdown) se conserva: es el formato de las fichas antiguas.
alter table student_profiles add column if not exists ai_ficha  text;
alter table student_profiles add column if not exists ai_status text default 'pending';

create index if not exists idx_student_profiles_risk    on student_profiles (risk_signal);
create index if not exists idx_student_profiles_student on student_profiles (student_id);

-- ── class_analyses ───────────────────────────────────────────────────────────
-- Un registro por transcripción analizada.
-- Ojo: el timestamp se llama `analyzed_at` (NO created_at) y NO hay teacher_name.
create table if not exists class_analyses (
  id                 text primary key,
  student_id         text references students(id),
  teacher_id         text references teachers(id),
  student_name       text not null,
  class_number       integer,
  transcript         text not null,
  class_summary      text,
  errors_detected    text,
  progress_notes     text,
  topics_covered     text,
  next_class_guide   jsonb,
  risk_signal        text,
  risk_explanation   text,
  analyzed_at        timestamptz default now(),
  class_date         date,
  class_title        text,
  next_class_content jsonb
);

alter table class_analyses disable row level security;

alter table class_analyses add column if not exists class_date         date;
alter table class_analyses add column if not exists class_title        text;
alter table class_analyses add column if not exists next_class_content jsonb;
alter table class_analyses add column if not exists next_class_guide   jsonb;
alter table class_analyses add column if not exists analyzed_at        timestamptz default now();

create index if not exists idx_class_analyses_student  on class_analyses (student_id);
create index if not exists idx_class_analyses_teacher  on class_analyses (teacher_id);
create index if not exists idx_class_analyses_analyzed on class_analyses (analyzed_at desc);
create index if not exists idx_class_analyses_risk     on class_analyses (risk_signal);

-- ── Restricciones de la señal de riesgo ──────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'student_profiles_risk_signal_check') then
    alter table student_profiles add constraint student_profiles_risk_signal_check
      check (risk_signal is null or risk_signal in ('verde', 'amarillo', 'rojo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'class_analyses_risk_signal_check') then
    alter table class_analyses add constraint class_analyses_risk_signal_check
      check (risk_signal is null or risk_signal in ('verde', 'amarillo', 'rojo'));
  end if;
end $$;
