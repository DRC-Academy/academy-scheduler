-- ── RECORDATORIOS ESCALONADOS DEL EMAIL DE PRESENTACIÓN ──────────────────────
-- El cron horario (app/api/cron/check-presentation-emails) avisa al profesor —y,
-- a partir de las 12 h, también al admin— de que el email de bienvenida sigue sin
-- enviarse. Cada umbral (4 h / 12 h / 24 h) debe dispararse UNA sola vez por
-- asignación; estas columnas son el anti-duplicados: se comprueban en false antes
-- de enviar y se marcan en true después.
--
-- Requiere haber corrido antes supabase-presentation-email.sql (columnas
-- presentation_email_sent / presentation_email_sent_at).

alter table assignments add column if not exists presentation_reminder_4h_sent  boolean default false;
alter table assignments add column if not exists presentation_reminder_12h_sent boolean default false;
alter table assignments add column if not exists presentation_reminder_24h_sent boolean default false;

-- Nota: el destinatario de los avisos al admin sale de la variable de entorno
-- ADMIN_NOTIFICATION_EMAIL (fallback: pagos@drcacademy.com). Configúrala en Vercel.
