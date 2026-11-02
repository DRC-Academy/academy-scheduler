-- Testimoniales: textos de la tabla "Umbrales" con "testimonio" en vez de "pareja"
-- (02/11/2026). Solo cambia la columna description: ningún valor ni clave.
-- Opcional: el panel funciona igual sin correrlo. Se puede correr varias veces.

UPDATE testimonial_config SET description = 'Nota mínima del juez (0-100) para aprobar un testimonio.' WHERE key = 'juez_nota_min';
UPDATE testimonial_config SET description = 'La tanda se para al reunir estos testimonios aprobados.' WHERE key = 'parejas_por_tanda';
UPDATE testimonial_config SET description = 'Combinaciones que se prueban como mucho por alumno, en orden, hasta que una se aprueba (no se elige en el panel).' WHERE key = 'parejas_por_alumno';
UPDATE testimonial_config SET description = 'Veces que un mismo momento (ANTES o DESPUÉS) puede salir entre los testimonios de un alumno.' WHERE key = 'momento_max_parejas';
UPDATE testimonial_config SET description = 'Buscador viejo (V6) que rehace UN testimonio por alumno al subir un transcript: 1 = encendido, 0 = apagado (manda el panel de análisis).' WHERE key = 'buscador_v6_activo';
UPDATE testimonial_config SET description = 'Coste por testimonio verificado para el contador (hasta tener 20 verificaciones con gasto; luego se usa la media real).' WHERE key = 'coste_pareja_estimado_usd';
UPDATE testimonial_config SET description = 'Panel de análisis: alumnos que se verifican a la vez (una llamada al servidor por testimonio).' WHERE key = 'analisis_en_paralelo';

SELECT key, description FROM testimonial_config WHERE description ILIKE '%pareja%';   -- debe salir vacío
