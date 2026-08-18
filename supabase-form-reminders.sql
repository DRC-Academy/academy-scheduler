-- ─────────────────────────────────────────────────────────────────────────────
-- Follow-up automático del formulario inicial + prueba de nivel
--
-- El cron diario (app/api/cron/form-reminders) persigue por email a los alumnos
-- que recibieron su enlace y no lo completaron. Son DOS secuencias encadenadas,
-- porque son dos tokens distintos:
--
--   1) FORMULARIO → form_tokens.status = 'pending'
--      Reloj: form_tokens.created_at (cuándo recibió el enlace).
--   2) PRUEBA DE NIVEL → formulario completado pero sin level_test_sessions
--      en estado 'completed'.
--      Reloj: form_tokens.completed_at (cuándo terminó el formulario).
--
-- Cada secuencia manda 3 recordatorios como máximo y luego calla.
--
-- POR QUÉ EL CONTADOR VIVE EN form_tokens Y NO EN students
-- El enlace es lo que se persigue, no la persona. Si el profesor regenera el
-- link del formulario ("Regenerar enlace"), nace un form_token nuevo con su
-- contador en 0 y la secuencia vuelve a empezar sola, que es justo lo que hay
-- que hacer: el alumno tiene un enlace nuevo que nunca ha visto. Con el contador
-- en students ese alumno quedaría marcado como "ya recibió 3" para siempre.
-- Además hay tokens sin fila en students (bajas), y ahí no habría dónde escribir.
--
-- Las columnas de students son un ESPEJO para pintar la columna "Último
-- follow-up" del panel sin cruzar tablas: guardan el último envío de cualquiera
-- de las dos secuencias.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Fuente de verdad: una secuencia por enlace ───────────────────────────────
alter table form_tokens add column if not exists form_reminder_count     int default 0;
alter table form_tokens add column if not exists form_reminder_last_sent timestamptz;
alter table form_tokens add column if not exists test_reminder_count     int default 0;
alter table form_tokens add column if not exists test_reminder_last_sent timestamptz;

-- Los tokens que ya existían quedan en 0 (nunca recibieron nada), así que entran
-- a la secuencia por el primer recordatorio aunque su enlace sea de hace semanas.
update form_tokens set form_reminder_count = 0 where form_reminder_count is null;
update form_tokens set test_reminder_count = 0 where test_reminder_count is null;

-- El cron filtra por status y ordena por created_at; el índice de status ya
-- existe (supabase-form-tokens.sql). Este cubre la búsqueda del último token
-- completado de cada alumno para la secuencia del test.
create index if not exists idx_form_tokens_completed_at on form_tokens (completed_at desc);

-- ── Espejo para el panel ("Último follow-up" en Tests de nivel) ──────────────
-- stage dice de qué secuencia fue el último envío, para que la celda pueda
-- distinguir "2º recordatorio del formulario" de "2º recordatorio de la prueba".
alter table students add column if not exists form_reminder_count     int default 0;
alter table students add column if not exists form_reminder_last_sent timestamptz;
alter table students add column if not exists form_reminder_stage     text;   -- 'formulario' | 'test'

update students set form_reminder_count = 0 where form_reminder_count is null;

-- ── Variables de entorno que necesita el cron (Vercel → Settings) ────────────
--   · CRON_SECRET          → protege el endpoint (Vercel lo manda como Bearer)
--   · RESEND_API_KEY       → envío de los correos
--   · NEXT_PUBLIC_APP_URL  → base de los enlaces del email
--   · STUDENT_REPLY_TO_EMAIL (opcional) → a dónde contesta el alumno si responde
--     al correo. Sin ella se usa alumnos@drcacademy.com.
