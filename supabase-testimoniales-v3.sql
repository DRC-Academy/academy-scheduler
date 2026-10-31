-- ════════════════════════════════════════════════════════════════════════════
-- Testimoniales v3: ESCUCHA + PANEL DE ANÁLISIS + RECORTE EN VEZ DE DESCARTE
-- (30/10/2026).
--
-- Un solo SQL con todo lo que falta en Supabase. Sustituye a
-- supabase-testimoniales-escucha.sql (que no se llegó a correr) e incluye otra vez
-- lo de supabase-testimoniales-varias-parejas.sql (que ya se corrió: no pasa nada,
-- no se duplica).
--
-- Requiere supabase-testimoniales-verificador.sql ya corrido.
-- Se puede correr DOS O MÁS VECES sin romper nada: no borra nada, no pisa
-- umbrales que ya existan y no duplica filas.
--
-- Qué hace:
--   1. Umbrales nuevos en testimonial_config.
--   2. La escucha: origen de cada pareja, clases y tramos escuchados, gasto de Deepgram.
--   3. Varias parejas, vetos y gasto por verificación (ya estaba: no cambia nada).
--   4. Panel de análisis: opciones de cada tanda y una fila por pareja (o clase por
--      escuchar), para pausar y reanudar sin repetir ni pagar dos veces.
--   5. Comprobación: qué tablas y umbrales existen.
--
-- OJO: deja APAGADO el buscador viejo que rehacía UNA pareja por alumno al subir
-- cada transcript (buscador_v6_activo = 0). Los recortes del texto se siguen
-- calculando (fuente "Texto de Fathom" del panel); solo deja de crear y borrar
-- parejas por su cuenta. Para volver atrás basta poner 1.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Umbrales ──────────────────────────────────────────────────────────────
INSERT INTO testimonial_config (key, value, description, motivo, paso, limite) VALUES
  -- Buscador viejo
  ('buscador_v6_activo',            0,      'Buscador viejo (V6) que rehace UNA pareja por alumno al subir un transcript: 1 = encendido, 0 = apagado (manda el panel de análisis).', NULL, NULL, NULL),
  -- Escucha
  ('escucha_tramos_por_clase',      5,      'Escucha: tramos del alumno que se escuchan por clase (los más largos, sin lecturas).', NULL, NULL, NULL),
  ('escucha_tope_s',                45,     'Escucha: segundos como mucho de cada tramo.', NULL, NULL, NULL),
  ('escucha_min_turno_s',           15,     'Escucha: solo intervenciones del alumno de más de estos segundos seguidos (según Fathom).', NULL, NULL, NULL),
  ('escucha_margen_s',              2,      'Escucha: segundos de margen antes del inicio que marca Fathom.', NULL, NULL, NULL),
  ('escucha_clases_lado',           3,      'Escucha: clases grabadas que se escuchan al principio y al final de cada alumno (dentro de las fechas elegidas).', NULL, NULL, NULL),
  ('escucha_min_palabras',          8,      'Escucha: palabras mínimas del alumno en un tramo para que cuente.', NULL, NULL, NULL),
  ('escucha_clip_max_s',            30,     'Escucha: duración máxima del clip que se propone al verificador (dentro del tramo escuchado).', NULL, NULL, NULL),
  ('escucha_seg_por_clase_estimado',216,    'Escucha: segundos de audio por clase para el coste estimado (hasta tener 10 clases escuchadas; luego se usa la media real).', NULL, NULL, NULL),
  -- Varias parejas y vetos (ya existen si se corrió supabase-testimoniales-varias-parejas.sql)
  ('parejas_por_alumno',            10,     'Parejas candidatas como mucho por alumno (el panel deja elegir 1, 5, 10 o 20).', NULL, NULL, NULL),
  ('momento_max_parejas',           2,      'Veces que un mismo momento (ANTES o DESPUÉS) puede salir entre las parejas de un alumno.', NULL, NULL, NULL),
  ('momento_espanol_max',           0.15,   'Momentos del texto de Fathom: con más de esta fracción de palabras en español no se usan; con algo de español van al final.', NULL, NULL, NULL),
  -- Precios (gasto estimado)
  ('deepgram_usd_min_multi',        0.0052, 'Precio de Deepgram por minuto en modo multi (para el gasto estimado).', NULL, NULL, NULL),
  ('deepgram_usd_min_detect',       0.0043, 'Precio de Deepgram por minuto en modo detect (para el gasto estimado).', NULL, NULL, NULL),
  ('deepgram_credito_usd',          200,    'Deepgram: crédito inicial de la cuenta, para mostrar cuánto queda.', NULL, NULL, NULL),
  ('claude_usd_mtok_entrada',       2,      'Precio de Claude (Sonnet 5.5) por millón de tokens de entrada (para el gasto estimado).', NULL, NULL, NULL),
  ('claude_usd_mtok_salida',        10,     'Precio de Claude (Sonnet 5.5) por millón de tokens de salida (para el gasto estimado).', NULL, NULL, NULL),
  ('coste_pareja_estimado_usd',     0.05,   'Coste por pareja verificada para el contador (hasta tener 20 verificaciones con gasto; luego se usa la media real).', NULL, NULL, NULL),
  -- Panel y "habla el profe" (nuevos)
  ('analisis_en_paralelo',          3,      'Panel de análisis: alumnos que se verifican a la vez (una llamada al servidor por pareja).', NULL, NULL, NULL),
  ('voces_interjecciones_max',      4,      'Palabras tipo "yeah, ok, mhm, right, really?, and then?" que puede decir la otra voz dentro del clip sin descartarlo.', NULL, NULL, NULL),
  ('recorte_alumno_min_antes_s',    8,      'Con otra voz o español en el ANTES: se sigue con el trozo más largo en que habla solo el alumno en inglés si dura al menos esto (s).', NULL, NULL, NULL),
  ('recorte_alumno_min_despues_s',  12,     'Con otra voz o español en el DESPUÉS: se sigue con el trozo más largo en que habla solo el alumno en inglés si dura al menos esto (s).', NULL, NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- ── 2. Escucha ───────────────────────────────────────────────────────────────
-- Origen de cada pareja: 'v6' = texto de Fathom; 'escucha' = escucha con Deepgram.
ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'v6';

-- Clases escuchadas (para no volver a pagarlas).
CREATE TABLE IF NOT EXISTS testimonial_listen_classes (
  analysis_id    text PRIMARY KEY,
  student_group  text NOT NULL,
  teacher_id     text,
  class_day      date,
  -- escuchada | sin_tramos (ningún tramo largo que no sea lectura) | enlace_roto | error
  status         text NOT NULL CHECK (status IN ('escuchada', 'sin_tramos', 'enlace_roto', 'error')),
  detalle        text,
  tramos         integer NOT NULL DEFAULT 0,
  segundos       numeric NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_listen_classes ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_listen_classes_student ON testimonial_listen_classes (student_group);

-- Medidas de cada tramo escuchado. Segundos absolutos desde el inicio de la
-- grabación. habla_*: donde habla de verdad el alumno según Deepgram (si en el
-- tramo hablaba también el profe, el trozo más largo en que habla solo él).
CREATE TABLE IF NOT EXISTS testimonial_listen_segments (
  id                   text PRIMARY KEY,           -- escucha:<analysis_id>:<turno>
  analysis_id          text NOT NULL,
  student_group        text NOT NULL,
  teacher_id           text,
  class_day            date,
  turn_index           integer NOT NULL,
  start_s              numeric NOT NULL,
  dur_s                numeric NOT NULL,
  audio_s              numeric,
  habla_start_s        numeric,
  habla_end_s          numeric,
  medidas              jsonb,                      -- lib/testimonialMeasures ClipMeasures; null = sin voz
  ppm                  numeric,
  pausas_min           numeric,
  muletillas           integer,
  espanol_pct          numeric,
  texto                text,
  request_id           text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_listen_segments ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_listen_segments_student ON testimonial_listen_segments (student_group);
CREATE INDEX IF NOT EXISTS idx_testimonial_listen_segments_analysis ON testimonial_listen_segments (analysis_id);

-- Gasto en Deepgram (segundos enviados).
CREATE TABLE IF NOT EXISTS testimonial_deepgram_usage (
  id          bigserial PRIMARY KEY,
  origen      text NOT NULL CHECK (origen IN ('escucha', 'verificador')),
  modo        text NOT NULL CHECK (modo IN ('multi', 'detect')),
  segundos    numeric NOT NULL,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_deepgram_usage ENABLE ROW LEVEL SECURITY;

-- Lo que ya gastó el verificador antes de existir esta tabla (multi y detect por
-- clip), una sola vez aunque se corra de nuevo.
INSERT INTO testimonial_deepgram_usage (origen, modo, segundos, request_id, created_at)
SELECT 'verificador', m.modo,
       COALESCE((v.antes->>'dur')::numeric, 0) + COALESCE((v.despues->>'dur')::numeric, 0),
       'retro:' || v.id || ':' || m.modo, v.created_at
  FROM testimonial_verifications v
 CROSS JOIN (VALUES ('multi'), ('detect')) AS m(modo)
 WHERE v.antes ? 'medidas' AND jsonb_typeof(v.antes->'medidas') = 'object'
   AND NOT EXISTS (SELECT 1 FROM testimonial_deepgram_usage u WHERE u.request_id = 'retro:' || v.id || ':' || m.modo);

-- ── 3. Varias parejas, vetos y gasto (ya corrido: no cambia nada) ────────────
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS plan    jsonb;
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS cursor  integer NOT NULL DEFAULT 0;
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS alumnos integer;
ALTER TABLE testimonial_verifications ADD COLUMN IF NOT EXISTS coste_deepgram_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE testimonial_verifications ADD COLUMN IF NOT EXISTS coste_claude_usd   numeric NOT NULL DEFAULT 0;

-- Vetos: 'm:<grabación>#<intervención>' = un momento (español, habla el profe,
-- leyendo, cámara apagada); 'g:<grabación>' = una clase entera (enlace privado o
-- borrado). <grabación> = la URL de Fathom en minúsculas, sin https://, www.,
-- ?timestamp ni barra final (recordingKey en lib/testimonialPairPlan.ts).
CREATE TABLE IF NOT EXISTS testimonial_vetos (
  clave            text PRIMARY KEY,
  motivo           text NOT NULL,
  lado             text,
  verification_id  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_vetos ENABLE ROW LEVEL SECURITY;

-- ── 4. Panel de análisis ─────────────────────────────────────────────────────
-- Opciones con que se abrió cada tanda y por dónde va.
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS fuente      text;          -- 'escucha' | 'texto'
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS filtros     jsonb;         -- { desde, hasta, alumno, profe }
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS objetivo    integer;       -- parejas a verificar; null = todas
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS por_alumno  integer;
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS solo_nuevas boolean;
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS fase        text;          -- 'escuchar' | 'verificar'
ALTER TABLE testimonial_verify_batches ADD COLUMN IF NOT EXISTS paused_at   timestamptz;

-- Una fila por clase por escuchar o pareja por verificar de cada tanda.
CREATE TABLE IF NOT EXISTS testimonial_batch_items (
  batch_id         text NOT NULL,
  idx              integer NOT NULL,
  tipo             text NOT NULL CHECK (tipo IN ('escuchar', 'pareja')),
  student_group    text NOT NULL,
  -- pareja: momento ANTES (a) y DESPUÉS (b), sus momentKey (ma, mb) y grabaciones (ra, rb).
  -- escuchar: a = analysis_id de la clase.
  a                text,
  b                text,
  ma               text,
  mb               text,
  ra               text,
  rb               text,
  -- pendiente | en_curso | hecha | saltada | error
  status           text NOT NULL DEFAULT 'pendiente',
  -- verificación: aprobado | descartado | error · escucha: escuchada | sin_tramos | enlace_roto | error
  resultado        text,
  motivo           text,
  detalle          text,
  verification_id  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, idx)
);
ALTER TABLE testimonial_batch_items ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_batch_items_estado ON testimonial_batch_items (batch_id, tipo, status);
CREATE INDEX IF NOT EXISTS idx_testimonial_batch_items_alumno ON testimonial_batch_items (batch_id, student_group);

-- Lo que hizo el verificador para no descartar (voz partida, recorte al alumno).
ALTER TABLE testimonial_verifications ADD COLUMN IF NOT EXISTS ajustes jsonb;

NOTIFY pgrst, 'reload schema';

-- ── 5. Comprobación ──────────────────────────────────────────────────────────
-- Todo tiene que salir con existe = true (y el buscador viejo con valor 0).
SELECT tipo, nombre, existe, valor FROM (
  SELECT 1 AS orden, 'tabla' AS tipo, t AS nombre, to_regclass('public.' || t) IS NOT NULL AS existe, NULL::numeric AS valor
    FROM unnest(ARRAY['testimonial_config', 'testimonial_verify_batches', 'testimonial_verifications', 'testimonial_candidates',
      'testimonial_listen_classes', 'testimonial_listen_segments', 'testimonial_deepgram_usage', 'testimonial_vetos',
      'testimonial_batch_items']) AS t
  UNION ALL
  SELECT 2, 'columna', c, EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = split_part(c, '.', 1) AND column_name = split_part(c, '.', 2)), NULL
    FROM unnest(ARRAY['testimonial_candidates.source', 'testimonial_verifications.ajustes', 'testimonial_verifications.coste_claude_usd',
      'testimonial_verify_batches.fuente', 'testimonial_verify_batches.filtros', 'testimonial_verify_batches.objetivo',
      'testimonial_verify_batches.fase', 'testimonial_verify_batches.paused_at']) AS c
  UNION ALL
  SELECT 3, 'umbral', k, cfg.key IS NOT NULL, cfg.value
    FROM unnest(ARRAY['buscador_v6_activo', 'escucha_tramos_por_clase', 'escucha_tope_s', 'escucha_min_turno_s', 'escucha_margen_s',
      'escucha_clases_lado', 'escucha_min_palabras', 'escucha_clip_max_s', 'escucha_seg_por_clase_estimado',
      'parejas_por_alumno', 'momento_max_parejas', 'momento_espanol_max', 'deepgram_usd_min_multi', 'deepgram_usd_min_detect',
      'deepgram_credito_usd', 'claude_usd_mtok_entrada', 'claude_usd_mtok_salida', 'coste_pareja_estimado_usd',
      'analisis_en_paralelo', 'voces_interjecciones_max', 'recorte_alumno_min_antes_s', 'recorte_alumno_min_despues_s']) AS k
    LEFT JOIN testimonial_config cfg ON cfg.key = k
  UNION ALL
  SELECT 4, 'filas', 'testimonial_vetos', true, (SELECT count(*) FROM testimonial_vetos)
) x
ORDER BY orden, nombre;
