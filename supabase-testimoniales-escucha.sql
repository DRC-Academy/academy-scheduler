-- ── Testimoniales: ESCUCHA DIRIGIDA (oct/2026, rama testimoniales-escucha) ──
--
-- Los candidatos dejan de salir del texto de Fathom (que limpia las trabas) y
-- salen de ESCUCHAR con Deepgram los tramos largos del alumno en sus 3 primeras
-- y sus 3 últimas clases grabadas. Las parejas resultantes entran al verificador,
-- que no cambia.
--
-- Aditivo e idempotente: no borra nada. Se puede correr dos veces. Requiere haber
-- corrido antes supabase-testimoniales-verificador.sql.
--
-- Al correrlo, el buscador viejo (V6) queda APAGADO (buscador_v6_activo = 0):
-- sigue en el código; para volver atrás basta poner 1.

-- ── 1. Umbrales nuevos ──────────────────────────────────────────────────────
INSERT INTO testimonial_config (key, value, description) VALUES
  ('buscador_v6_activo',        0,      'Buscador viejo por texto de Fathom (V6): 1 = encendido, 0 = apagado (manda la escucha).'),
  ('escucha_tramos_por_clase',  5,      'Escucha: tramos del alumno que se escuchan por clase (los más largos, sin lecturas).'),
  ('escucha_tope_s',            45,     'Escucha: segundos como mucho de cada tramo.'),
  ('escucha_min_turno_s',       15,     'Escucha: solo intervenciones del alumno de más de estos segundos seguidos (según Fathom).'),
  ('escucha_margen_s',          2,      'Escucha: segundos de margen antes del inicio que marca Fathom.'),
  ('escucha_clases_lado',       3,      'Escucha: clases grabadas que se escuchan al principio y al final de cada alumno.'),
  ('escucha_min_clases',        4,      'Escucha: clases grabadas mínimas para entrar.'),
  ('escucha_antiguedad_dias',   60,     'Escucha: días desde su primera clase grabada para entrar (2 meses).'),
  ('escucha_min_palabras',      8,      'Escucha: palabras mínimas del alumno en un tramo para que cuente en el ranking.'),
  ('escucha_clip_max_s',        30,     'Escucha: duración máxima del clip que se propone al verificador (dentro del tramo escuchado).'),
  ('deepgram_usd_min_multi',    0.0052, 'Deepgram: dólares por minuto en modo multi (para el gasto estimado).'),
  ('deepgram_usd_min_detect',   0.0043, 'Deepgram: dólares por minuto en modo detect (para el gasto estimado).'),
  ('deepgram_credito_usd',      200,    'Deepgram: crédito inicial de la cuenta, para mostrar cuánto queda.')
ON CONFLICT (key) DO NOTHING;

-- ── 2. Origen de cada pareja ────────────────────────────────────────────────
-- 'v6' = buscador viejo por texto; 'escucha' = escucha dirigida. Con el buscador
-- viejo apagado, el verificador solo coge las de 'escucha'.
ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'v6';

-- ── 3. Clases escuchadas (para no volver a pagarlas) ────────────────────────
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

-- ── 4. Medidas de cada tramo escuchado ──────────────────────────────────────
-- Segundos absolutos desde el inicio de la grabación. habla_*: donde habla de
-- verdad el alumno según Deepgram (más exacto que Fathom).
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
  -- Todas las medidas (lib/testimonialMeasures ClipMeasures); null = sin voz.
  medidas              jsonb,
  -- Copia de las principales, para mirarlas a mano en Supabase.
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

-- ── 5. Resultado de la escucha por alumno (resumen de la pestaña) ───────────
-- outcome: pareja | sin_profe_en_comun | sin_pareja | pendiente | ya_sirve
CREATE TABLE IF NOT EXISTS testimonial_listen_students (
  student_group  text PRIMARY KEY,
  student_name   text,
  outcome        text NOT NULL,
  detalle        text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_listen_students ENABLE ROW LEVEL SECURITY;

-- ── 6. Gasto en Deepgram (estimado por segundos enviados) ───────────────────
CREATE TABLE IF NOT EXISTS testimonial_deepgram_usage (
  id          bigserial PRIMARY KEY,
  origen      text NOT NULL CHECK (origen IN ('escucha', 'verificador')),
  modo        text NOT NULL CHECK (modo IN ('multi', 'detect')),
  segundos    numeric NOT NULL,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_deepgram_usage ENABLE ROW LEVEL SECURITY;

-- Lo que ya gastó el verificador antes de existir esta tabla (las dos llamadas
-- por clip, multi y detect), una sola vez.
INSERT INTO testimonial_deepgram_usage (origen, modo, segundos, request_id, created_at)
SELECT 'verificador', m.modo,
       COALESCE((v.antes->>'dur')::numeric, 0) + COALESCE((v.despues->>'dur')::numeric, 0),
       'retro:' || v.id, v.created_at
  FROM testimonial_verifications v
 CROSS JOIN (VALUES ('multi'), ('detect')) AS m(modo)
 WHERE v.antes ? 'medidas' AND v.antes->'medidas' IS NOT NULL AND jsonb_typeof(v.antes->'medidas') = 'object'
   AND NOT EXISTS (SELECT 1 FROM testimonial_deepgram_usage u WHERE u.request_id = 'retro:' || v.id);

NOTIFY pgrst, 'reload schema';

-- Comprobación (tiene que dar 0 en la primera columna: buscador viejo apagado):
--   select (select value from testimonial_config where key = 'buscador_v6_activo') as v6,
--          (select count(*) from testimonial_config where key like 'escucha_%') as umbrales_escucha,
--          (select round(sum(segundos) / 60, 1) from testimonial_deepgram_usage) as minutos_ya_gastados;
