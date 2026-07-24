-- ─────────────────────────────────────────────────────────────────────────────
-- Predicción de bajas (churn) — recopilación de datos desde HOY.
--
-- Cada fila es una "foto" de las señales de un alumno en un momento dado:
--   · trigger 'cancellation' + label 'churned'  → se da de baja (ejemplo POSITIVO)
--   · trigger 'active_check'  + label 'active'   → alumno activo escaneado
-- Con ~100 bajas (estimado 3 meses) la muestra empieza a ser fiable. Hasta
-- entonces el objetivo es ACUMULAR, no acertar.
-- Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists churn_snapshots (
  id                   text primary key,
  student_id           text,
  student_name         text not null,
  teacher_id           text,
  captured_at          timestamptz default now(),
  trigger              text,          -- 'cancellation' | 'active_check' | 'manual'
  label                text,          -- 'churned' | 'active'

  classes_analyzed     int,
  -- señales deterministas
  cancellations        int,
  late_count           int,
  risk_flags           int,
  days_since_last_class int,
  avg_speaking_pct     int,
  speaking_trend       text,          -- 'up' | 'stable' | 'down' | 'unknown'
  deterministic_risk   int,
  -- señales por IA
  ai_risk_score        int,
  ai_participation     text,
  ai_explicit_quit     boolean,
  ai_reasoning         text,
  -- riesgo combinado + volcado completo para análisis futuro
  combined_risk        int,
  alerted              boolean default false,
  signals              jsonb,
  ai_raw               jsonb
);

alter table churn_snapshots disable row level security;

create index if not exists idx_churn_student   on churn_snapshots (student_id);
create index if not exists idx_churn_label      on churn_snapshots (label);
create index if not exists idx_churn_captured   on churn_snapshots (captured_at desc);
