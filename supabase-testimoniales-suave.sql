-- Testimoniales: reglas más suaves (04/11/2026, pedido de Facundo: que no salga casi nada
-- era peor que revisar de más). "Leyendo" y las 4 semanas no se tocan.
-- Cada cambio queda en el historial y se puede deshacer desde "Detalles de la última tanda".
-- Se puede correr más de una vez.

-- 1. Reglas.
INSERT INTO testimonial_config_changes (key, antes, despues, motivo, detalle)
SELECT key, value, v.nuevo, 'manual', 'Reglas más suaves del 04/11/2026'
FROM testimonial_config
JOIN (VALUES
  ('juez_nota_min', 40::numeric),
  ('despues_pausa_max_s', 2.5::numeric),
  ('despues_ppm_min', 70::numeric),
  ('contraste_ppm_factor', 1.3::numeric),
  ('contraste_pausas_factor', 0.85::numeric),
  ('antes_ppm_max', 120::numeric),
  ('antes_tercio_ppm_max', 170::numeric)
) AS v(k, nuevo) ON v.k = key
WHERE value <> v.nuevo;

UPDATE testimonial_config SET value = 40, updated_at = now() WHERE key = 'juez_nota_min';
UPDATE testimonial_config SET value = 2.5, updated_at = now() WHERE key = 'despues_pausa_max_s';
UPDATE testimonial_config SET value = 70, updated_at = now() WHERE key = 'despues_ppm_min';
UPDATE testimonial_config SET value = 1.3, updated_at = now() WHERE key = 'contraste_ppm_factor';
UPDATE testimonial_config SET value = 0.85, updated_at = now() WHERE key = 'contraste_pausas_factor';
UPDATE testimonial_config SET value = 120, updated_at = now() WHERE key = 'antes_ppm_max';
UPDATE testimonial_config SET value = 170, updated_at = now() WHERE key = 'antes_tercio_ppm_max';

-- 2. A Por revisar: 12 parejas ya juzgadas con nota 42 (máximo 3 por alumno, sin repetir clip).
UPDATE testimonial_candidates c
SET status = 'detectado', discarded_by = NULL, status_changed_at = now(), updated_at = now()
FROM testimonial_verifications v
WHERE v.candidate_id = c.id AND c.status = 'descartado' AND v.motivo = 'nota_baja' AND v.status = 'descartado'
  AND v.id IN (
    'tv_tc_1793758228495_bi0pk2_254eb652171f', 'tv_tc_1793758408431_fxsok9_f814e673b5b7',
    'tv_tc_1793759576226_pq3dfr_18b1aba5a7c4', 'tv_tc_1793759751012_nmg4hk_1e95743839bf',
    'tv_tc_1793760037258_kyqliq_0e9eb005059f', 'tv_tc_1793760193223_xqyixv_200b238e7dee',
    'tv_tc_1793760229003_alx541_8a9c6210a499', 'tv_tc_1793760419944_cukxzv_b096acbff867',
    'tv_tc_1793760691117_092qtk_69a6efa54525', 'tv_tc_1793760754372_p2fo5t_c336054619e6',
    'tv_tc_1793760853432_tbtn8q_d45916d4b54b', 'tv_tc_1793761051496_yqdde6_b6bb82b14752');

UPDATE testimonial_verifications
SET status = 'aprobado', motivo = NULL, motivo_detalle = NULL, updated_at = now()
WHERE motivo = 'nota_baja' AND status = 'descartado'
  AND id IN (
    'tv_tc_1793758228495_bi0pk2_254eb652171f', 'tv_tc_1793758408431_fxsok9_f814e673b5b7',
    'tv_tc_1793759576226_pq3dfr_18b1aba5a7c4', 'tv_tc_1793759751012_nmg4hk_1e95743839bf',
    'tv_tc_1793760037258_kyqliq_0e9eb005059f', 'tv_tc_1793760193223_xqyixv_200b238e7dee',
    'tv_tc_1793760229003_alx541_8a9c6210a499', 'tv_tc_1793760419944_cukxzv_b096acbff867',
    'tv_tc_1793760691117_092qtk_69a6efa54525', 'tv_tc_1793760754372_p2fo5t_c336054619e6',
    'tv_tc_1793760853432_tbtn8q_d45916d4b54b', 'tv_tc_1793761051496_yqdde6_b6bb82b14752');

-- Comprobación: los 7 valores nuevos y 28 testimonios por revisar.
SELECT key, value FROM testimonial_config
WHERE key IN ('juez_nota_min', 'despues_pausa_max_s', 'despues_ppm_min', 'contraste_ppm_factor', 'contraste_pausas_factor', 'antes_ppm_max', 'antes_tercio_ppm_max')
UNION ALL
SELECT 'POR REVISAR', count(*) FROM testimonial_verifications
WHERE kind = 'busqueda' AND status = 'aprobado' AND review IS NULL
ORDER BY 1;
