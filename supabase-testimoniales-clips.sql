-- ── Testimoniales: clips cortos por alumno (oct/2026) ──────────────────────
--
-- Hasta 3 momentos MALOS (primeras clases) y 3 BUENOS (últimas clases) por
-- pareja, elegidos por Haiku y comprobados por el código (lib/testimonialStore):
--
--   { "malos":  [ { analysisId, classDate, teacherId, start, end, excerpt, why, fathomUrl }, … ],
--     "buenos": [ … ] }
--
-- start/end en segundos desde el inicio de la grabación; fathomUrl ya lleva
-- ?timestamp=start. NULL = aún sin preparar: las parejas activas preparadas antes
-- de este cambio vuelven solas a la cola al abrir la pestaña Testimoniales.
--
-- Aditivo e idempotente. Reversible: ALTER TABLE testimonial_candidates DROP COLUMN clips;

ALTER TABLE testimonial_candidates ADD COLUMN IF NOT EXISTS clips jsonb;

-- Las parejas activas que fallaron con el sistema de un solo clip (la cita no
-- aparecía literal) vuelven a la cola. Como ya pasaron la comparación a ciegas
-- (ai_is_real = true), solo se les generan los clips.
UPDATE testimonial_candidates
   SET ai_review_status = 'pending', ai_error = NULL, updated_at = '2000-01-01T00:00:00Z'
 WHERE status <> 'descartado' AND ai_review_status = 'failed' AND clips IS NULL;

-- PostgREST tiene que ver la columna nueva.
NOTIFY pgrst, 'reload schema';
