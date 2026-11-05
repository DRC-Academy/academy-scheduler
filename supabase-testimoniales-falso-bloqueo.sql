-- Testimoniales: qué endurece "Falso bloqueo" (05/11/2026, pedido de Facundo).
-- Antes subía el mínimo de pausas del ANTES; ahora baja su velocidad máxima de 5 en 5, hasta 50.
-- El mínimo de pausas se queda en su valor actual y ya no sube solo.
-- No cambia ningún valor de hoy: solo qué umbral se mueve a partir de ahora.
-- Solo cuentan los "Falso bloqueo" marcados desde el último cambio de antes_ppm_max.
-- Se puede correr más de una vez.

UPDATE testimonial_config SET motivo = NULL, paso = NULL, limite = NULL, updated_at = now() WHERE key = 'antes_pausas_min';
UPDATE testimonial_config SET motivo = 'falso_bloqueo', paso = -5, limite = 50, updated_at = now() WHERE key = 'antes_ppm_max';

-- Comprobación: antes_pausas_min sin motivo y antes_ppm_max con falso_bloqueo, -5, 50.
SELECT key, value, motivo, paso, limite FROM testimonial_config WHERE key IN ('antes_pausas_min', 'antes_ppm_max') ORDER BY key;
