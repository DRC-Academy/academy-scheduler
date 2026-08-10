-- ── class_analyses.has_transcript ───────────────────────────────────────────
--
-- Señal liviana de "esta clase tiene transcript", para que los listados dejen de
-- traerse el texto entero.
--
-- POR QUÉ UNA COLUMNA GENERADA Y NO transcript_hash
--
-- La idea original era usar `transcript_hash IS NOT NULL`, que ya existe y ya
-- está poblada. Se descartó tras medirlo: de 361 filas, 2 tienen texto y NO
-- tienen hash. Y no son legado — son del 10/08/2026, las dos más recientes:
-- transcriptStore escribe `transcript_hash: input.transcriptHash || null`, así
-- que cualquier llamador que no calcule el hash deja la columna vacía. Usarla
-- como señal habría marcado esas dos clases como "sin transcript", sacándolas de
-- pagables en finanzas y pidiéndole al profesor que subiera algo que ya subió.
--
-- Una columna GENERATED la calcula Postgres a partir del propio texto en cada
-- escritura: no hay código que pueda olvidarse de mantenerla y no puede
-- desincronizarse. La aplicación nunca la escribe.
--
-- Es aditiva y reversible: `ALTER TABLE class_analyses DROP COLUMN has_transcript;`
--
-- El código tolera que esta migración NO se haya corrido: si la columna no
-- existe, las consultas reintentan pidiendo `transcript` como antes (mismo
-- patrón de reintento por 42703 que ya usa el resto del proyecto). Es decir,
-- nada se rompe si se despliega el código antes de correr esto — simplemente el
-- egress no baja hasta que se corra.

ALTER TABLE class_analyses
  ADD COLUMN IF NOT EXISTS has_transcript boolean
  GENERATED ALWAYS AS (transcript IS NOT NULL AND length(btrim(transcript)) > 0) STORED;

COMMENT ON COLUMN class_analyses.has_transcript IS
  'Generada por Postgres desde `transcript`. Permite a los listados saber si hay transcripcion sin transferir el texto (que pesa 30 KB de media). La aplicacion NUNCA la escribe.';

-- Índice: lo consultan finanzas y las vistas del profesor en cada carga.
CREATE INDEX IF NOT EXISTS idx_class_analyses_has_transcript
  ON class_analyses (has_transcript);
