-- ── RECORDATORIO DIARIO DE TRANSCRIPTS ───────────────────────────────────────
-- El cron de fin de día (app/api/cron/daily-transcript-reminder) avisa al
-- profesor de las clases que HOY entraron a finanzas por su ingreso ("Unirse a
-- clase") pero siguen sin transcript, así que están en "pendiente" y todavía no
-- se le pagan.
--
-- OJO: esta tabla YA EXISTE en la base de producción (se creó antes que el
-- endpoint). Este script está escrito para ser idempotente y NO hace falta
-- correrlo si la tabla ya está: sirve para levantar el entorno desde cero y para
-- dejar documentado el esquema del que depende el cron.
--
-- ANTI-DUPLICADOS — una fila por profesor y día. El endpoint trabaja en modo
-- "reservar y luego enviar": inserta la fila ANTES de mandar el correo y, si ya
-- existía, no envía nada. Así dos corridas solapadas (el cron y un disparo
-- manual, por ejemplo) no pueden mandar el email dos veces. Si el envío falla,
-- la fila se borra para que la próxima corrida lo reintente.
--
-- El id es determinista — drl_transcript_<teacher_id>_<YYYY-MM-DD> — y es lo que
-- convierte el insert en una reserva atómica, sin necesidad de transacción. El
-- tipo de aviso viaja DENTRO del id (no hay columna para él), así que si algún
-- día se añade otro recordatorio diario basta con otro prefijo.

create table if not exists daily_reminder_log (
  id             text primary key,          -- drl_transcript_<teacher_id>_<YYYY-MM-DD>
  teacher_id     text not null,
  reminder_date  date not null,
  classes_count  integer not null default 0,
  sent_at        timestamptz not null default now()
);

create index if not exists daily_reminder_log_fecha_idx
  on daily_reminder_log (reminder_date desc);

-- Mismo criterio que el resto de tablas internas del proyecto.
alter table daily_reminder_log disable row level security;

-- Variables de entorno que necesita el cron (Vercel → Settings → Environment):
--   · CRON_SECRET          → protege el endpoint (el mismo valor va en el cron)
--   · RESEND_API_KEY       → envío del correo
--   · NEXT_PUBLIC_APP_URL  → enlace "Subir transcript" del email
