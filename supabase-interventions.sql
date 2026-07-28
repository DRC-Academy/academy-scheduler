-- ─────────────────────────────────────────────────────────────────────────────
-- Sugerencias de intervención + auditoría de seguimiento
--
-- BLOQUE 1 — cuando el análisis de una clase devuelve riesgo amarillo/rojo, la
-- IA genera además una SUGERENCIA DE INTERVENCIÓN concreta para el profesor.
-- Se guarda en la clase (histórico) y se copia a la ficha del alumno como
-- "intervención abierta" (pendiente de atender).
--
-- BLOQUE 2 — al analizar la clase SIGUIENTE de un alumno con intervención
-- abierta, la IA evalúa si hubo señales de que el profesor actuó. El resultado
-- se registra en intervention_audits y se avisa al ADMIN. IMPORTANTE: esto NO
-- crea scoring_events ni penaliza a nadie de forma automática. Una intervención
-- buena es sutil y puede no verse en el transcript: la decisión es humana.
--
-- Idempotente: se puede correr las veces que haga falta.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Sugerencia guardada en la clase ──────────────────────────────────────────
-- { action, reconnectHook, escalateToSupport, channel }
alter table class_analyses    add column if not exists intervention_suggestion jsonb;

-- ── Intervención ABIERTA del alumno (la alerta pendiente de atender) ─────────
-- Mismo objeto que arriba + metadatos (risk, classAnalysisId, classNumber).
alter table student_profiles  add column if not exists active_intervention     jsonb;
alter table student_profiles  add column if not exists active_intervention_at  timestamptz;
-- Contador de alertas sin señales de intervención. Es una SEÑAL para el admin,
-- no una penalización: no se descuenta scoring por este número.
alter table student_profiles  add column if not exists unattended_alerts       int default 0;

create index if not exists idx_student_profiles_unattended
  on student_profiles (unattended_alerts);

-- ── Auditoría de seguimiento ─────────────────────────────────────────────────
-- Una fila por clase analizada que venía con una intervención abierta.
create table if not exists intervention_audits (
  id                     text primary key,
  student_id             text,
  student_name           text,
  teacher_id             text,
  teacher_name           text,
  alert_signal           text,        -- 'amarillo' | 'rojo' (el de la alerta abierta)
  intervention_suggested jsonb,       -- qué se le sugirió al profesor
  signs_of_intervention  boolean,
  evidence               text,
  confidence             text,        -- 'alta' | 'media' | 'baja'
  class_analysis_id      text,
  created_at             timestamptz default now()
);

alter table intervention_audits disable row level security;

create index if not exists idx_intervention_audits_student on intervention_audits (student_id);
create index if not exists idx_intervention_audits_teacher on intervention_audits (teacher_id);
create index if not exists idx_intervention_audits_created on intervention_audits (created_at desc);

-- ── Baja con alerta de riesgo previa ─────────────────────────────────────────
-- Se marca ANTES de borrar al alumno (la baja elimina la fila de `students`),
-- por eso el dato duradero vive también en student_dropouts.
alter table students          add column if not exists churned_with_open_alert boolean default false;
alter table student_dropouts  add column if not exists had_open_alert          boolean default false;
alter table student_dropouts  add column if not exists unattended_alerts       int default 0;
