-- ════════════════════════════════════════════════════════════════════════════
-- Testimoniales: VARIAS PAREJAS POR ALUMNO en "Buscar y verificar"
-- (rama testimoniales-varias-parejas, 30/10/2026).
--
-- Requiere supabase-testimoniales-verificador.sql ya corrido. Se puede correr
-- más de una vez: no borra nada ni pisa umbrales ya cambiados. También se puede
-- correr antes o después de supabase-testimoniales-escucha.sql (comparten los
-- precios de Deepgram y no se pisan).
--
-- Qué hace:
--   1. Umbrales nuevos en testimonial_config.
--   2. La tanda guarda su plan de parejas y por dónde va.
--   3. Cada verificación guarda su gasto estimado (Deepgram y Claude).
--   4. Tabla de vetos: momentos y clases que el verificador ya no vuelve a usar.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Umbrales ──────────────────────────────────────────────────────────────
INSERT INTO testimonial_config (key, value, description, motivo, paso, limite) VALUES
  ('parejas_por_alumno',        10,     'Parejas candidatas como mucho por alumno en cada tanda (ordenadas de mejor a peor).', NULL, NULL, NULL),
  ('momento_max_parejas',       2,      'Veces que un mismo momento (ANTES o DESPUÉS) puede salir entre las parejas de un alumno.', NULL, NULL, NULL),
  ('momento_espanol_max',       0.15,   'Momentos del buscador: con más de esta fracción de palabras en español (texto de Fathom) no se usan; con algo de español van al final.', NULL, NULL, NULL),
  ('tanda_max_verificaciones',  150,    'Tope de verificaciones por tanda de "Buscar y verificar" (aunque no se reúnan las aprobadas).', NULL, NULL, NULL),
  ('deepgram_usd_min_multi',    0.0052, 'Precio de Deepgram por minuto en modo multi (para el gasto estimado).', NULL, NULL, NULL),
  ('deepgram_usd_min_detect',   0.0043, 'Precio de Deepgram por minuto en modo detect (para el gasto estimado).', NULL, NULL, NULL),
  ('claude_usd_mtok_entrada',   2,      'Precio de Claude (Sonnet 5.5) por millón de tokens de entrada (para el gasto estimado).', NULL, NULL, NULL),
  ('claude_usd_mtok_salida',    10,     'Precio de Claude (Sonnet 5.5) por millón de tokens de salida (para el gasto estimado).', NULL, NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- ── 2. Plan de la tanda ──────────────────────────────────────────────────────
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS plan    jsonb;
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS cursor  integer NOT NULL DEFAULT 0;
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS alumnos integer;

-- ── 3. Gasto estimado por verificación ───────────────────────────────────────
ALTER TABLE testimonial_verifications ADD COLUMN IF NOT EXISTS coste_deepgram_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE testimonial_verifications ADD COLUMN IF NOT EXISTS coste_claude_usd   numeric NOT NULL DEFAULT 0;

-- ── 4. Vetos ─────────────────────────────────────────────────────────────────
-- clave 'm:<testimonial_segments.id>' = un momento; 'c:<analysis_id>' = una clase
-- entera (enlace privado o borrado).
CREATE TABLE IF NOT EXISTS testimonial_vetos (
  clave            text PRIMARY KEY,
  motivo           text NOT NULL,
  lado             text,
  verification_id  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Solo la usa el servidor (clave de servicio): sin políticas, nadie más entra.
ALTER TABLE testimonial_vetos ENABLE ROW LEVEL SECURITY;

-- Un momento es una intervención del alumno en una GRABACIÓN de Fathom (así
-- también vale para las copias del mismo transcript en otra clase):
--   'm:<grabación>#<intervención>'  ·  'g:<grabación>' (enlace privado o borrado)
-- <grabación> = la URL de Fathom en minúsculas, sin https://, www., ?timestamp ni
-- barra final (igual que recordingKey en lib/testimonialPairPlan.ts).
--
-- Lo ya verificado antes de este cambio también veta (el lado sale del detalle:
-- "ANTES: …" / "DESPUÉS: …").
INSERT INTO testimonial_vetos (clave, motivo, lado, verification_id)
SELECT DISTINCT ON (clave) clave, motivo, lado, id FROM (
  SELECT id, motivo, lado,
    CASE
      WHEN motivo = 'enlace_roto' THEN 'g:' || grabacion
      WHEN turno IS NOT NULL THEN 'm:' || grabacion || '#' || turno
    END AS clave
  FROM (
    SELECT id, motivo,
      CASE WHEN motivo_detalle LIKE 'ANTES:%' THEN 'ANTES' ELSE 'DESPUÉS' END AS lado,
      regexp_replace(regexp_replace(
        split_part(split_part(lower(trim(
          CASE WHEN motivo_detalle LIKE 'ANTES:%'
            THEN candidate_snapshot -> 'clips' -> 'malos' -> 0 ->> 'fathomUrl'
            ELSE candidate_snapshot -> 'clips' -> 'buenos' -> 0 ->> 'fathomUrl' END
        )), '?', 1), '#', 1),
        '^https?://(www\.)?', ''), '/+$', '') AS grabacion,
      substring(CASE WHEN motivo_detalle LIKE 'ANTES:%' THEN before_moment_id ELSE after_moment_id END
        FROM ':([0-9]+):[AB]:[^:]*$') AS turno
    FROM testimonial_verifications
    WHERE kind = 'busqueda' AND status = 'descartado'
      AND (motivo_detalle LIKE 'ANTES:%' OR motivo_detalle LIKE 'DESPUÉS:%')
      AND (motivo IN ('espanol', 'habla_profe', 'leyendo', 'camara_apagada')
           OR (motivo = 'enlace_roto' AND fathom_causa IN ('privado', 'borrado')))
  ) x
  WHERE grabacion <> ''
) v
WHERE clave IS NOT NULL
ORDER BY clave, id
ON CONFLICT (clave) DO NOTHING;

-- ── Comprobación ─────────────────────────────────────────────────────────────
-- Tiene que dar: 8 | 3 | 2 | t | (los vetos sacados de las tandas ya hechas)
SELECT
  (SELECT count(*) FROM testimonial_config WHERE key IN ('parejas_por_alumno', 'momento_max_parejas', 'momento_espanol_max',
     'tanda_max_verificaciones', 'deepgram_usd_min_multi', 'deepgram_usd_min_detect', 'claude_usd_mtok_entrada', 'claude_usd_mtok_salida')) AS umbrales,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'testimonial_verify_batches' AND column_name IN ('plan', 'cursor', 'alumnos')) AS columnas_tanda,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'testimonial_verifications' AND column_name IN ('coste_deepgram_usd', 'coste_claude_usd')) AS columnas_gasto,
  (SELECT to_regclass('public.testimonial_vetos') IS NOT NULL) AS tabla_vetos,
  (SELECT count(*) FROM testimonial_vetos) AS vetos;
