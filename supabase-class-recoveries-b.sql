-- ── Recuperaciones, bloque B: anulación con motivo y origen de la fila ──────────
--
-- Requiere supabase-class-recoveries.sql (bloque A) ya corrido.
-- Correr ANTES de publicar el bloque B en main.
--
--   · annulled_at / annulled_by / annul_reason: quién anuló una recuperación,
--     cuándo y por qué (la pestaña "Recuperaciones" del admin exige el motivo;
--     las bajas y el chequeo nocturno también lo dejan escrito).
--   · origin: de dónde salió la fila.
--       'profesor'           → el botón "No puedo dar esta clase" (todo el bloque A).
--       'admin_reclasificacion' → el admin aprobó una revisión como "cancelada por
--                              el profesor": NO usa comodín (multa fija de 5 €
--                              desde PENALTY_START_DATE) y nace en 'sin_acuerdo'.
--
-- Aditivo, idempotente y reversible:
--   ALTER TABLE class_recoveries DROP COLUMN annulled_at, DROP COLUMN annulled_by,
--     DROP COLUMN annul_reason, DROP COLUMN origin;

ALTER TABLE class_recoveries ADD COLUMN IF NOT EXISTS annulled_at  timestamptz;
ALTER TABLE class_recoveries ADD COLUMN IF NOT EXISTS annulled_by  text;
ALTER TABLE class_recoveries ADD COLUMN IF NOT EXISTS annul_reason text;
ALTER TABLE class_recoveries ADD COLUMN IF NOT EXISTS origin       text NOT NULL DEFAULT 'profesor';

DO $$ BEGIN
  ALTER TABLE class_recoveries ADD CONSTRAINT class_recoveries_origin_check
    CHECK (origin IN ('profesor', 'admin_reclasificacion'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Comprobación: debe devolver las 4 columnas.
-- select column_name from information_schema.columns
--  where table_name = 'class_recoveries'
--    and column_name in ('annulled_at', 'annulled_by', 'annul_reason', 'origin');
