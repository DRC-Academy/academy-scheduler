-- ── Testimoniales V4 (07/10/2026): empezar de cero con las reglas nuevas ─────
--
-- Las parejas que hay ahora se hicieron con la V3, que mezclaba clases de otra
-- persona (clase guardada en el alumno equivocado), dejaba pasar audios y
-- lecturas puestos en clase, y descartaba a casi todos por la nota. Se borran
-- para que la pestaña Testimoniales las vuelva a detectar y preparar con la V4
-- (lib/testimonialRules).
--
-- SE CONSERVAN: lo que el admin marcó "No sirve" (bloquea al alumno) y lo que
-- marcó "Sirve" (listo / revisado / permiso_alumno). Al 07/10/2026 no había
-- ninguna de las dos cosas.
-- testimonial_recording_requests se borra en cascada (estaba vacía).
--
-- Correr DESPUÉS de desplegar el código nuevo: si se corre antes, el código viejo
-- volvería a crear las parejas con la V3 en cuanto alguien abra la pestaña.

-- Comprobación previa (cuántas se borran):
-- select status, discarded_by, count(*) from testimonial_candidates group by 1, 2;

DELETE FROM testimonial_candidates
 WHERE discarded_by IS DISTINCT FROM 'admin'
   AND status NOT IN ('listo', 'revisado', 'permiso_alumno');
