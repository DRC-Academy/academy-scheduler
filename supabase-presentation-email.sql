-- ── SEGUIMIENTO DEL EMAIL DE PRESENTACIÓN ────────────────────────────────────
-- Los profesores deben enviar el email de bienvenida al alumno dentro de las
-- primeras 24 horas tras la asignación. Estas columnas registran si se envió y
-- cuándo, para el contador del panel del profesor, el resumen del admin, el cron
-- de alertas y el impacto en el scoring (-5 puntos si se envía fuera de tiempo).

alter table assignments add column if not exists presentation_email_sent_at timestamptz;
alter table assignments add column if not exists presentation_email_sent    boolean default false;

-- Nota: no hace falta tabla nueva.
--   · El retraso se registra en scoring_events con event_type
--     'email_presentacion_tardio' (points -5, euros 0).
--   · Las alertas del cron se guardan en la tabla notifications con un id
--     determinista por assignment (ver app/api/cron/check-presentation-emails)
--     para evitar duplicados.
