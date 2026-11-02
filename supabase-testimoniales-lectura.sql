-- Testimoniales: ¿el DESPUÉS es habla espontánea o lectura en voz alta? (02/11/2026)
-- Haiku clasifica una vez cada tramo escuchado que podría ser un DESPUÉS
-- (lib/testimonialReading). Una lectura nunca entra como DESPUÉS.
-- Se puede correr más de una vez.

ALTER TABLE testimonial_listen_segments ADD COLUMN IF NOT EXISTS lectura text
  CHECK (lectura IS NULL OR lectura IN ('espontaneo', 'lectura'));
ALTER TABLE testimonial_listen_segments ADD COLUMN IF NOT EXISTS lectura_motivo text;

-- Empate por tope en el contraste: si ANTES y DESPUÉS llegan los dos al tope de
-- duración del clip (escucha_clip_max_s menos este margen), vale.
INSERT INTO testimonial_config (key, value, description)
VALUES ('contraste_tope_tolerancia_s', 1,
  'Si el ANTES y el DESPUÉS duran los dos al menos el tope del clip menos estos segundos, no hace falta que el DESPUÉS sea más largo.')
ON CONFLICT (key) DO NOTHING;

SELECT count(*) FILTER (WHERE lectura IS NULL) AS sin_clasificar,
       count(*) FILTER (WHERE lectura = 'lectura') AS lecturas,
       count(*) FILTER (WHERE lectura = 'espontaneo') AS espontaneos
FROM testimonial_listen_segments;
