-- ── Testimoniales V6 (15/10/2026): clips A/B elegidos SOLO CON CÓDIGO ──────
--
-- Sin IA: de cada transcript se guardan los mejores recortes del alumno como
-- posible clip A ("antes", se traba) y posible clip B ("después", habla fluido),
-- con todo lo medido (lib/testimonialScoring). Las parejas se eligen después,
-- una por alumno, con los umbrales de lib/testimonialConfig.
--
-- Aditivo e idempotente: NO borra nada. Las parejas "Sirve" y "No sirve" no se
-- tocan. Desde la V6, "No sirve" bloquea SOLO esos dos momentos (no al alumno
-- con ese profe).
--
-- CUÁNDO: ANTES de desplegar el código de la V6 (el código nuevo lee estas
-- tablas; el código actual no las toca, así que correrlo antes no rompe nada).

-- ── 1. Recortes de cada transcript ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS testimonial_segments (
  id              text PRIMARY KEY,                -- analysis_id:turno:tipo:palabras_antes
  analysis_id     text NOT NULL REFERENCES class_analyses(id) ON DELETE CASCADE,
  student_group   text NOT NULL,
  teacher_id      text,
  class_day       date,
  student_label   text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('A', 'B')),
  turn_index      integer NOT NULL,
  -- Segundos desde el inicio de la grabación (estimados dentro de la intervención).
  start_s         integer NOT NULL,
  end_s           integer NOT NULL,
  text            text NOT NULL,
  words           integer NOT NULL,
  fillers         numeric NOT NULL,                -- muletillas ponderadas
  repeats         integer NOT NULL,
  searches        integer NOT NULL,                -- "how do you say", "cómo se dice"…
  spanish_words   integer NOT NULL,
  turn_wpm        numeric NOT NULL,                -- palabras/min de la intervención entera
  teacher_before  boolean NOT NULL,
  fathom_url      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_segments DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_testimonial_segments_student  ON testimonial_segments (student_group);
CREATE INDEX IF NOT EXISTS idx_testimonial_segments_analysis ON testimonial_segments (analysis_id);

-- ── 2. Estado V6 de cada transcript ─────────────────────────────────────────
-- segments_at NULL = falta procesarlo con la V6 (al correr esto, TODOS: así se
-- reprocesa el histórico). segment_stats: lo descartado al extraer y las
-- palabras/segundos para el promedio de velocidad del alumno.
ALTER TABLE testimonial_transcripts ADD COLUMN IF NOT EXISTS segments_at   timestamptz;
ALTER TABLE testimonial_transcripts ADD COLUMN IF NOT EXISTS segment_stats jsonb;
CREATE INDEX IF NOT EXISTS idx_testimonial_transcripts_segments ON testimonial_transcripts (segments_at);

-- ── 3. Auditoría: por qué cada alumno sale o no sale ────────────────────────
CREATE TABLE IF NOT EXISTS testimonial_audit (
  student_group  text PRIMARY KEY,
  student_name   text,
  -- 'pareja' | 'sin_pareja' | 'ya_sirve' | 'sin_clases_validas'
  outcome        text NOT NULL,
  -- Motivo (lib/testimonialScoring NoPairReason) cuando no hay pareja.
  reason         text,
  -- Cuentas para auditar: clases, recortes A/B, combinaciones rechazadas por motivo…
  details        jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_audit DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- Comprobación después de correrlo (tiene que dar 0 procesados y el total de transcripts):
--   select count(*) filter (where segments_at is not null) as procesados, count(*) from testimonial_transcripts;
