-- Testimoniales: revisar descartes, hasta 3 testimonios por alumno y reglas nuevas
-- (04/11/2026, decisiones de Facundo). Correr ANTES de desplegar el código.
-- Se puede correr más de una vez.

-- 1. Revisión de descartes: "injusto" lo pasa a Por revisar; "justo" solo cuenta para calibrar.
ALTER TABLE testimonial_verifications
  ADD COLUMN IF NOT EXISTS descarte_revision text CHECK (descarte_revision IN ('injusto', 'justo')),
  ADD COLUMN IF NOT EXISTS descarte_nota text,
  ADD COLUMN IF NOT EXISTS descarte_revisado_at timestamptz;

-- 2. Varios testimonios por alumno y profe: lo único que no se repite es la misma pareja de clips.
DROP INDEX IF EXISTS uq_testimonial_candidates_activa_profe;
CREATE UNIQUE INDEX IF NOT EXISTS uq_testimonial_candidates_activa_clips
  ON testimonial_candidates (student_group, COALESCE(pair_teacher_id, ''), COALESCE(before_moment_id, ''), COALESCE(after_moment_id, ''))
  WHERE status <> 'descartado';

-- 3. Claves nuevas.
INSERT INTO testimonial_config (key, value, description, motivo, paso, limite) VALUES
  ('testimonios_por_alumno', 3,
   'Testimonios aprobados como mucho por alumno, siempre con clips distintos.', NULL, NULL, NULL),
  ('progreso_medio_min', 1.15,
   'Mejora media del alumno (últimas clases / primeras) a partir de la que sale primero en Por revisar.', NULL, NULL, NULL)
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, updated_at = now();

-- 4. Reglas nuevas (cada cambio queda en el historial y se puede deshacer desde la pestaña).
INSERT INTO testimonial_config_changes (key, antes, despues, motivo, detalle)
SELECT key, value, v.nuevo, 'manual', 'Reglas del 04/11/2026 (embudo por alumno)'
FROM testimonial_config
JOIN (VALUES ('juez_nota_min', 50::numeric), ('despues_pausa_max_s', 2::numeric), ('contraste_pausas_factor', 0.75::numeric)) AS v(k, nuevo) ON v.k = key
WHERE value <> v.nuevo;

UPDATE testimonial_config SET value = 50, updated_at = now() WHERE key = 'juez_nota_min';
UPDATE testimonial_config SET value = 2, updated_at = now() WHERE key = 'despues_pausa_max_s';
UPDATE testimonial_config SET value = 0.75, updated_at = now() WHERE key = 'contraste_pausas_factor';

-- 5. Audios y fotogramas de descartes: 90 días. Los marcados "Sirve" o "Descarte injusto", siempre.
UPDATE testimonial_config
SET value = 90, updated_at = now(),
    description = 'Días que se guardan audios y fotogramas de lo descartado ("Sirve" y "Descarte injusto" se guardan siempre).'
WHERE key = 'retencion_dias';

-- 6. A Por revisar: las 5 parejas de Cristina Salmón, Aleix Diez e Inmaculada Torres que
--    pasan con la nota mínima nueva (52-58). Solo si siguen descartadas por nota baja.
UPDATE testimonial_candidates c
SET status = 'detectado', discarded_by = NULL, status_changed_at = now(), updated_at = now()
FROM testimonial_verifications v
WHERE v.candidate_id = c.id AND c.status = 'descartado' AND v.motivo = 'nota_baja' AND v.status = 'descartado'
  AND v.id IN (
    'tv_tc_1793759145234_dncvys_8fe768a959cb', 'tv_tc_1793759419871_o7huz8_90e30dc71c06',
    'tv_tc_1793760590516_a9w9gk_ea54b1d562fb', 'tv_tc_1793760698636_psei67_cb0b57b0afbc',
    'tv_tc_1793759094098_ftahf0_40e97a89faed');

UPDATE testimonial_verifications
SET status = 'aprobado', motivo = NULL, motivo_detalle = NULL, updated_at = now()
WHERE motivo = 'nota_baja' AND status = 'descartado'
  AND id IN (
    'tv_tc_1793759145234_dncvys_8fe768a959cb', 'tv_tc_1793759419871_o7huz8_90e30dc71c06',
    'tv_tc_1793760590516_a9w9gk_ea54b1d562fb', 'tv_tc_1793760698636_psei67_cb0b57b0afbc',
    'tv_tc_1793759094098_ftahf0_40e97a89faed');

-- Comprobación: 7 claves con su valor nuevo y 5 parejas aprobadas de los 3 alumnos.
SELECT key, value FROM testimonial_config
WHERE key IN ('juez_nota_min', 'despues_pausa_max_s', 'contraste_pausas_factor', 'retencion_dias', 'testimonios_por_alumno', 'progreso_medio_min', 'parejas_por_alumno')
ORDER BY key;

SELECT student_name, juez_nota, status FROM testimonial_verifications
WHERE id IN (
  'tv_tc_1793759145234_dncvys_8fe768a959cb', 'tv_tc_1793759419871_o7huz8_90e30dc71c06',
  'tv_tc_1793760590516_a9w9gk_ea54b1d562fb', 'tv_tc_1793760698636_psei67_cb0b57b0afbc',
  'tv_tc_1793759094098_ftahf0_40e97a89faed')
ORDER BY student_name, juez_nota DESC;
