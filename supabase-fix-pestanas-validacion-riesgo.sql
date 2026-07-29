-- ─────────────────────────────────────────────────────────────────────────────
-- FIX — Pestañas "Validación" e "IA y Riesgo" vacías (29/07/2026)
--
-- Junta las DOS migraciones que faltaban en producción y que dejaban la pestaña
-- Validación permanentemente vacía:
--
--   1. supabase-transcript-validation.sql  → faltaban validation_status,
--      validation_reviewed_by y validation_reviewed_at. La pestaña filtra por
--      validation_status, así que la consulta moría con 42703 y devolvía [].
--
--   2. supabase-join-log-link.sql          → faltaba join_log_id.
--
-- Por qué van juntas: el guardado descartaba columnas EN CASCADA hasta que el
-- INSERT pasaba, así que estas dos ausencias arrastraban consigo a
-- transcript_hash, transcript_validation_score y transcript_validation_flags
-- AUNQUE ESAS COLUMNAS SÍ EXISTAN. Por eso las 17 filas actuales tienen el score
-- de validación en null. El código ya está corregido para descartar solo la
-- columna que falta, pero mientras falte una el dato se sigue perdiendo.
--
-- Es idempotente: se puede correr más de una vez sin efecto.
--
-- NOTA sobre las filas existentes: al añadir validation_status con default 'ok',
-- Postgres rellena las 17 filas ya guardadas con 'ok'. Es lo que se busca: son
-- clases que nunca pasaron por la validación y NO deben bloquearse el pago de
-- forma retroactiva. Tampoco aparecerán en la pestaña (que solo lista review /
-- approved / rejected). Las clases nuevas sí nacerán con su score y su estado.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1) supabase-transcript-validation.sql ────────────────────────────────────

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


-- ── 2) supabase-join-log-link.sql ────────────────────────────────────────────
-- Vínculo explícito entre el transcript y el INGRESO a la clase, para que
-- finanzas no tenga que adivinar por cercanía de fechas.

alter table class_analyses add column if not exists join_log_id text;

create index if not exists idx_class_analyses_join_log
  on class_analyses (join_log_id);

-- Un ingreso no puede tener dos transcripts: evita duplicar la clase en el
-- cálculo. Parcial, porque join_log_id es null en todo lo añadido a mano.
create unique index if not exists uq_class_analyses_join_log
  on class_analyses (join_log_id) where join_log_id is not null;


-- ── 3) Comprobación ──────────────────────────────────────────────────────────
-- Debe devolver las 8 columnas. Si falta alguna, algo de arriba no se aplicó.
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'class_analyses'
  and column_name in (
    'transcript_validation_score', 'transcript_validation_flags',
    'ai_authenticity_check', 'validation_status',
    'validation_reviewed_by', 'validation_reviewed_at',
    'transcript_hash', 'join_log_id'
  )
order by column_name;
