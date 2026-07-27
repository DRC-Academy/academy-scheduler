-- ─────────────────────────────────────────────────────────────────────────────
-- Guardado y análisis SEPARADOS (arreglo de la subida de transcripciones)
--
-- El transcript se guarda PRIMERO (rápido, sin IA) y el informe pedagógico se
-- genera después. Estas columnas registran en qué estado está ese informe para
-- poder reintentarlo sin volver a pegar el texto.
--
--   analysis_status:  'ready'   → el informe está generado
--                     'pending' → transcript guardado, informe en curso
--                     'failed'  → el análisis falló (botón "Reintentar análisis")
--
-- El default es 'ready' a propósito: las filas históricas YA tienen su informe.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table class_analyses add column if not exists analysis_status     text default 'ready';
alter table class_analyses add column if not exists analysis_error      text;
alter table class_analyses add column if not exists analysis_updated_at timestamptz;

create index if not exists idx_class_analyses_analysis_status on class_analyses (analysis_status);

-- Las filas antiguas sin valor quedan como 'ready' (tienen informe).
update class_analyses set analysis_status = 'ready' where analysis_status is null;
