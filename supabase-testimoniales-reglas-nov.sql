-- Testimoniales: reglas nuevas para "Reanalizar todo" (03/11/2026, decisión de Facundo).
--   · El DESPUÉS ya no tiene que durar más que el ANTES; sí al menos 10 s de habla.
--   · ANTES: 2 pausas o más (antes 3).
--   · "Ejercicio de repetición": solo frases enteras (3+ palabras) repetidas casi
--     seguidas, 2 veces o más, o muy poca variedad. "I I" o "but but" ya no cuentan.
--   · Nota mínima del juez: 60. Mismo profe y 4+ semanas, como siempre.
-- Cada cambio queda en el historial de umbrales (se puede deshacer desde la pestaña).
-- Se puede correr más de una vez.

-- 1. Claves nuevas.
INSERT INTO testimonial_config (key, value, description, motivo, paso, limite) VALUES
  ('despues_habla_min_s', 10,
   'DESPUÉS válido: al menos estos segundos de habla.', NULL, NULL, NULL),
  ('contraste_despues_mas_largo', 0,
   '1 = el DESPUÉS tiene que durar más que el ANTES (regla vieja); 0 = no se mira.', NULL, NULL, NULL),
  ('repeticion_frases_min', 2,
   'Ejercicio de repetición: a partir de cuántas frases de 3+ palabras repetidas casi seguidas ("I would like a coffee. I would like a coffee."). "I I" o "but but" no cuentan.',
   'ejercicio_repeticion', -1, 1)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description,
  motivo = EXCLUDED.motivo, paso = EXCLUDED.paso, limite = EXCLUDED.limite, updated_at = now();

-- 2. Cambios de valor (con su historial).
INSERT INTO testimonial_config_changes (key, antes, despues, motivo, detalle)
SELECT key, value, v.nuevo, 'manual', 'Reglas nuevas del 03/11/2026 (Reanalizar todo)'
FROM testimonial_config
JOIN (VALUES ('antes_pausas_min', 2::numeric), ('juez_nota_min', 60::numeric)) AS v(k, nuevo) ON v.k = key
WHERE value <> v.nuevo;

UPDATE testimonial_config SET value = 2, updated_at = now() WHERE key = 'antes_pausas_min';
UPDATE testimonial_config SET value = 60, updated_at = now() WHERE key = 'juez_nota_min';

-- 3. La regla vieja de repetición (palabras sueltas repetidas) ya no se usa.
DELETE FROM testimonial_config WHERE key = 'repeticion_distintas_min';

SELECT key, value FROM testimonial_config
WHERE key IN ('despues_habla_min_s', 'contraste_despues_mas_largo', 'repeticion_frases_min', 'antes_pausas_min',
              'juez_nota_min', 'semanas_min', 'despues_ppm_min', 'despues_pausa_max_s', 'contraste_ppm_factor')
ORDER BY key;
