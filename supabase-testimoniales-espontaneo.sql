-- Testimoniales: escuchar habla espontánea, no lecturas (02/11/2026).
-- La escucha ya no elige los turnos más largos del alumno (casi siempre lecturas):
-- antes de pagar Deepgram, Haiku separa en el texto de Fathom las lecturas del
-- habla espontánea, y solo se escucha lo espontáneo (lib/testimonialListen).
-- Las últimas clases de cada alumno escuchadas con el criterio viejo se vuelven a
-- escuchar con el nuevo (lo ya escuchado no se vuelve a pagar).
-- Se puede correr más de una vez.

-- 1 = turnos más largos (viejo) · 2 = turnos espontáneos (nuevo).
ALTER TABLE testimonial_listen_classes ADD COLUMN IF NOT EXISTS criterio smallint NOT NULL DEFAULT 1;

-- Regla del DESPUÉS elegida por Facundo: 100 palabras/min y pausas de 1,5 s como máximo.
INSERT INTO testimonial_config_changes (key, antes, despues, motivo, detalle)
SELECT key, value, v.nuevo, 'manual', 'Regla del DESPUÉS elegida tras la simulación del 02/11/2026'
FROM testimonial_config
JOIN (VALUES ('despues_ppm_min', 100::numeric), ('despues_pausa_max_s', 1.5::numeric)) AS v(k, nuevo) ON v.k = key
WHERE value <> v.nuevo;

UPDATE testimonial_config SET value = 100, updated_at = now() WHERE key = 'despues_ppm_min';
UPDATE testimonial_config SET value = 1.5, updated_at = now() WHERE key = 'despues_pausa_max_s';

SELECT key, value FROM testimonial_config WHERE key IN ('despues_ppm_min', 'despues_pausa_max_s')
UNION ALL
SELECT 'clases_escuchadas_criterio_viejo', count(*) FROM testimonial_listen_classes WHERE criterio = 1;
