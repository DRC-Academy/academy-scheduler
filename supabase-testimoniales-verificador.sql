-- ── Testimoniales: VERIFICADOR con video y audio reales (oct/2026) ──────────
--
-- Rama testimoniales-verificador. Cada pareja que propone el buscador (V6,
-- testimonial_candidates 'detectado') pasa por el verificador antes de verse:
-- enlace de Fathom → recorte → Deepgram → medidas → Claude con los fotogramas →
-- nota del juez. Solo se enseñan las 5 mejores aprobadas.
--
-- Aditivo e idempotente: NO borra ni cambia nada de lo que ya existe. Se puede
-- correr dos veces. Correrlo ANTES de abrir la pestaña nueva del Preview.
--
-- Seguridad: las tablas nuevas llevan RLS ACTIVADO y sin políticas: solo las lee
-- y escribe el servidor (service role). Tienen nombres de alumnos, textos de sus
-- clases y rutas a fotos y audios suyos; el navegador no las toca nunca.

-- ── 1. Umbrales (todos los del verificador, editables aquí) ─────────────────
-- motivo/paso/limite: si el admin marca "No sirve" con ese motivo 3+ veces en
-- las últimas 20 revisiones, el umbral se mueve `paso` (sin pasar de `limite`) y
-- el cambio queda en testimonial_config_changes para poder deshacerlo.
CREATE TABLE IF NOT EXISTS testimonial_config (
  key          text PRIMARY KEY,
  value        numeric NOT NULL,
  description  text NOT NULL,
  motivo       text,
  paso         numeric,
  limite       numeric,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_config ENABLE ROW LEVEL SECURITY;

INSERT INTO testimonial_config (key, value, description, motivo, paso, limite) VALUES
  -- Recorte
  ('recorte_margen_s',            2,    'Segundos de margen antes y después del clip (Fathom solo estima dónde empieza y acaba).', NULL, NULL, NULL),
  ('recorte_min_s',               8,    'Duración mínima del tramo que se recorta, en segundos.', NULL, NULL, NULL),
  ('recorte_max_s',               35,   'Duración máxima del tramo que se recorta, en segundos.', NULL, NULL, NULL),
  -- Deepgram
  ('deepgram_ambas',              1,    '1 = llamar a Deepgram en modo multi (idioma por palabra) y detect (idioma del clip) a la vez; 0 = solo multi.', NULL, NULL, NULL),
  -- Audio
  ('espanol_confianza_min',       0.9,  'Español: Deepgram detecta un idioma que no es inglés con al menos esta confianza.', NULL, NULL, NULL),
  ('espanol_pct_max',             0.15, 'Español: más de esta fracción de palabras en español.', 'espanol', -0.03, 0.03),
  ('voces_otra_max_palabras',     3,    'Habla el profe: palabras que se toleran de una segunda voz ("yes", "mm-hm"). Más = descartado.', 'habla_profe', -1, 0),
  -- Fluidez medida
  ('pausa_min_s',                 0.6,  'Un silencio entre palabras de al menos esto cuenta como pausa (segundos).', NULL, NULL, NULL),
  ('antes_pausas_min',            3,    'ANTES válido: al menos este número de pausas.', 'falso_bloqueo', 1, 8),
  ('antes_ppm_max',               100,  'ANTES válido: palabras por minuto como mucho (velocidad baja).', NULL, NULL, NULL),
  ('antes_tercio_ppm_max',        140,  'ANTES válido: ningún tercio del clip va más rápido que esto (no es un tropiezo puntual).', NULL, NULL, NULL),
  ('antes_tercios_con_traba_min', 2,    'ANTES válido: tercios del clip (de 3) con alguna pausa o muletilla.', NULL, NULL, NULL),
  ('despues_pausa_max_s',         1.0,  'DESPUÉS válido: ninguna pausa más larga que esto (segundos).', NULL, NULL, NULL),
  ('despues_ppm_min',             110,  'DESPUÉS válido: al menos estas palabras por minuto.', NULL, NULL, NULL),
  -- Ejercicio de repetición
  ('repeticion_distintas_min',    3,    'Ejercicio: palabras DISTINTAS dichas dos o más veces seguidas ("delivered, delivered… achieved, achieved").', 'ejercicio_repeticion', -1, 1),
  ('repeticion_unicas_max',       0.5,  'Ejercicio: con 10+ palabras, fracción de palabras distintas por debajo de esto (lista repetida).', NULL, NULL, NULL),
  -- Contraste
  ('contraste_ppm_factor',        1.4,  'Contraste: palabras por minuto del DESPUÉS ≥ esto × las del ANTES.', 'sin_contraste', 0.1, 2.5),
  ('contraste_pausas_factor',     0.5,  'Contraste: pausas por minuto del DESPUÉS < esto × las del ANTES.', NULL, NULL, NULL),
  ('semanas_min',                 4,    'Contraste: semanas mínimas entre la clase del ANTES y la del DESPUÉS.', NULL, NULL, NULL),
  -- Imagen (Claude)
  ('vision_camara_conf',          0.6,  'Cámara apagada: confianza mínima de Claude para descartar.', 'camara_apagada', -0.1, 0.3),
  ('vision_leyendo_conf',         0.6,  'Leyendo: confianza mínima de Claude para descartar.', 'leyendo', -0.1, 0.3),
  -- Juez
  ('juez_nota_min',               60,   'Nota mínima del juez (0-100) para aprobar una pareja.', 'otro', 5, 90),
  ('parejas_por_tanda',           5,    'La tanda se para al reunir estas parejas aprobadas.', NULL, NULL, NULL),
  -- Aprendizaje, alarma y limpieza
  ('endurecer_ventana',           20,   'Revisiones recientes que se miran para endurecer un umbral.', NULL, NULL, NULL),
  ('endurecer_veces',             3,    'Veces que tiene que aparecer un motivo en esa ventana para endurecer su umbral.', NULL, NULL, NULL),
  ('alarma_fuente_pct',           0.5,  'Aviso de fuente rota: fracción de enlaces que fallan por error técnico en una tanda.', NULL, NULL, NULL),
  ('retencion_dias',              30,   'Días que se guardan audios y fotogramas de lo descartado ("Sirve" se guarda siempre).', NULL, NULL, NULL)
ON CONFLICT (key) DO NOTHING;

-- ── 2. Historial de cambios automáticos de umbral (para deshacerlos) ────────
CREATE TABLE IF NOT EXISTS testimonial_config_changes (
  id           bigserial PRIMARY KEY,
  key          text NOT NULL,
  antes        numeric NOT NULL,
  despues      numeric NOT NULL,
  motivo       text NOT NULL,
  detalle      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reverted_at  timestamptz
);
ALTER TABLE testimonial_config_changes ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_config_changes_key ON testimonial_config_changes (key, created_at DESC);

-- ── 3. Tandas ("Buscar y verificar" y la prueba con los "No sirve") ─────────
CREATE TABLE IF NOT EXISTS testimonial_verify_batches (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('busqueda', 'prueba')),
  planned      integer NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  cancelled    boolean NOT NULL DEFAULT false
);
ALTER TABLE testimonial_verify_batches ENABLE ROW LEVEL SECURITY;

-- ── 4. Una verificación por pareja ──────────────────────────────────────────
-- antes / despues (jsonb): fecha, tramo, enlace de Fathom al segundo, rutas del
-- audio y los fotogramas en Storage, texto de Deepgram, medidas y lo que vio Claude.
-- candidate_snapshot: la pareja tal como se verificó (el buscador puede cambiarla
-- después); "Sirve" la deja exactamente así.
CREATE TABLE IF NOT EXISTS testimonial_verifications (
  id                  text PRIMARY KEY,
  batch_id            text,
  kind                text NOT NULL CHECK (kind IN ('busqueda', 'prueba')),
  candidate_id        text NOT NULL,
  student_group       text,
  student_id          text,
  student_name        text,
  teacher_id          text,
  before_moment_id    text,
  after_moment_id     text,
  candidate_snapshot  jsonb,
  status              text NOT NULL CHECK (status IN ('verificando', 'aprobado', 'descartado', 'error')),
  -- habla_profe | leyendo | camara_apagada | espanol | falso_bloqueo |
  -- ejercicio_repeticion | sin_contraste | enlace_roto | nota_baja | sin_voz | otro
  motivo              text,
  motivo_detalle      text,
  -- Solo con enlace_roto o error de Fathom: privado | borrado | error
  fathom_causa        text,
  antes               jsonb,
  despues             jsonb,
  semanas             integer,
  juez_nota           integer,
  juez_explicacion    text,
  consentimiento      text NOT NULL DEFAULT 'sin_pedir' CHECK (consentimiento IN ('sin_pedir', 'pedido', 'dado')),
  review              text CHECK (review IN ('sirve', 'no_sirve')),
  review_motivo       text,
  review_texto        text,
  reviewed_at         timestamptz,
  files_deleted_at    timestamptz,
  ms                  integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_verifications ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_verifications_batch  ON testimonial_verifications (batch_id);
CREATE INDEX IF NOT EXISTS idx_testimonial_verifications_status ON testimonial_verifications (kind, status);
CREATE INDEX IF NOT EXISTS idx_testimonial_verifications_pair   ON testimonial_verifications (before_moment_id, after_moment_id);
CREATE INDEX IF NOT EXISTS idx_testimonial_verifications_review ON testimonial_verifications (reviewed_at DESC) WHERE reviewed_at IS NOT NULL;

-- ── 5. Banco de ejemplos para el juez ───────────────────────────────────────
-- tipo: 'aprobado' ("Sirve"), 'rechazado' ("No sirve" con motivo) o 'calidad'
-- (las "Sirve" anteriores al verificador: SOLO como ejemplo de calidad de clip,
-- no de separación entre clases; decisión del 30/10/2026).
CREATE TABLE IF NOT EXISTS testimonial_examples (
  id               text PRIMARY KEY,
  verification_id  text,
  candidate_id     text,
  tipo             text NOT NULL CHECK (tipo IN ('aprobado', 'rechazado', 'calidad')),
  motivo           text,
  texto            text,
  resumen          text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_examples ENABLE ROW LEVEL SECURITY;

INSERT INTO testimonial_examples (id, candidate_id, tipo, resumen)
SELECT 'calidad_' || c.id, c.id, 'calidad',
       'ANTES: "' || COALESCE(c.before_excerpt, '') || '" · DESPUÉS: "' || COALESCE(c.after_excerpt, '') || '"'
  FROM testimonial_candidates c
 WHERE c.status IN ('listo', 'revisado', 'permiso_alumno')
ON CONFLICT (id) DO NOTHING;

-- ── 6. Almacenamiento de audios y fotogramas (privado) ──────────────────────
-- Se ven en la pestaña con enlaces firmados de 1 hora que genera el servidor.
INSERT INTO storage.buckets (id, name, public)
VALUES ('testimonios', 'testimonios', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- Comprobación (tiene que dar 27 umbrales, 0 verificaciones y 3 ejemplos de calidad):
--   select (select count(*) from testimonial_config) as umbrales,
--          (select count(*) from testimonial_verifications) as verificaciones,
--          (select count(*) from testimonial_examples where tipo = 'calidad') as calidad,
--          (select count(*) from storage.buckets where id = 'testimonios') as bucket;
