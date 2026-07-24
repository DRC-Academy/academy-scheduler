-- ─────────────────────────────────────────────────────────────────────────────
-- Bloque 1 — Detección de transcripciones falsas
-- Columnas de validación sobre class_analyses. Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

-- Capa 1 — score estructural (0-100) y flags detectados.
alter table class_analyses add column if not exists transcript_validation_score int;
alter table class_analyses add column if not exists transcript_validation_flags text[];

-- Capa 3 — resultado del verificador semántico por IA (authentic/confidence/…).
alter table class_analyses add column if not exists ai_authenticity_check jsonb;

-- Estado de validación de la clase, usado por finanzas y por el panel del admin:
--   'ok'       → validada automáticamente (segundo factor válido)
--   'review'   → pendiente de revisión del equipo (NO cuenta hasta aprobarse)
--   'approved' → aprobada manualmente por el admin (cuenta)
--   'rejected' → rechazada por el admin (no cuenta; se notifica al profesor)
alter table class_analyses add column if not exists validation_status text default 'ok';

-- Quién y cuándo revisó (auditoría).
alter table class_analyses add column if not exists validation_reviewed_by text;
alter table class_analyses add column if not exists validation_reviewed_at timestamptz;

create index if not exists idx_class_analyses_validation on class_analyses (validation_status);
