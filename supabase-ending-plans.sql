-- ─────────────────────────────────────────────────────────────────────────────
-- Aviso interno de fin de plan ("Próximos a cancelar")
--
-- Dos columnas en `students` para saber si el equipo de ventas ya recibió el
-- aviso de un alumno, y PARA QUÉ CICLO. Sin la segunda, un alumno que renueva
-- nunca volvería a avisarse: `ending_notice_sent_at` seguiría relleno del ciclo
-- anterior y el cron lo saltaría para siempre.
--
--   ending_notice_sent_at   → cuándo se mandó el aviso (null = nunca).
--   ending_notice_for_date  → la fecha de fin DE ESE CICLO (= manual_active_until
--                             en el momento del envío).
--
-- El aviso cuenta como enviado solo si las dos condiciones se cumplen:
--   ending_notice_sent_at is not null  AND  ending_notice_for_date = manual_active_until
--
-- Así, cuando el admin alarga la activación manual (renovación), la fecha deja
-- de coincidir, el alumno vuelve a estar "sin avisar" y se le avisará de nuevo
-- al final del ciclo nuevo. La regla vive en lib/endingPlans.noticeSentForCycle:
-- este comentario describe el dato, no lo decide.
--
-- USO
--   Ejecutar una vez en el editor SQL de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table students add column if not exists ending_notice_sent_at  timestamptz;
alter table students add column if not exists ending_notice_for_date date;

-- El cron barre por fecha de fin todos los días: sin índice es un seq scan sobre
-- la tabla entera. Con 184 alumnos da igual, pero cuesta una línea.
create index if not exists idx_students_manual_active_until
  on students (manual_active_until)
  where manual_active_until is not null;

comment on column students.ending_notice_sent_at is
  'Cuándo se envió el aviso interno de fin de plan. Ver supabase-ending-plans.sql.';
comment on column students.ending_notice_for_date is
  'Fecha de fin del ciclo por el que se avisó. Si ya no coincide con manual_active_until, el alumno renovó y vuelve a poder avisarse.';
