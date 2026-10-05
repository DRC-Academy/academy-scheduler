-- ─────────────────────────────────────────────────────────────────────────────
-- Cola del análisis de transcripts en LOTE (Message Batches API, mitad de precio)
--
-- Oct/2026: el análisis de cada transcript era el 80 % del gasto de la clave de
-- Claude de la plataforma. Los análisis que nadie espera en pantalla (el paso 2
-- del registro normal de una clase) se encolan acá y los manda y recoge el cron
-- /api/cron/analisis-lote (y su pasada de la tarde). Ver lib/analysisBatch.ts.
--
-- Una fila por clase (class_analyses.id). Sin FK a propósito: una FK nueva hacia
-- class_analyses bloquearía el borrado de alumnos (delete_student_cascade).
--
--   body     → el cuerpo de la petición SIN el transcript (se relee de la fila).
--   status   → 'queued' (esperando lote) · 'submitted' (en un lote) ·
--              'done' (informe guardado) · 'failed' (la fila queda con el botón
--              "Reintentar análisis").
--   batch_id → id del lote de Anthropic ('msgbatch_…') mientras está 'submitted'.
--
-- Mientras esta tabla no exista, la plataforma analiza al momento como antes.
-- Idempotente: se puede correr más de una vez.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_analysis_queue (
  analysis_id text primary key,
  body        jsonb       not null default '{}'::jsonb,
  status      text        not null default 'queued',
  batch_id    text,
  attempts    integer     not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_ai_analysis_queue_status on ai_analysis_queue (status);

-- Mismo acceso que class_analyses: la escriben las rutas del servidor con la
-- clave anónima (todavía sin RLS en el proyecto).
grant select, insert, update, delete on ai_analysis_queue to anon, authenticated, service_role;
