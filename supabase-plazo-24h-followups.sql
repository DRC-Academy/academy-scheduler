-- ─────────────────────────────────────────────────────────────────────────────
-- PLAZO DE 24 H PARA EL TRANSCRIPT + FOLLOW-UPS DE LA PRUEBA DE NIVEL
-- (septiembre de 2026, rama plazo-24h-y-followups)
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase, ANTES de desplegar
-- el código de esa rama. Es idempotente: todo lleva IF NOT EXISTS y se puede
-- correr dos veces sin romper nada. Incluye al final el contenido completo de
-- supabase-form-reminders.sql por si nunca se aplicó.
--
-- QUÉ SE GUARDA Y QUÉ NO
--   · El estado "vencida" NO se guarda: se calcula al vuelo comparando la hora
--     actual (España) con el fin de la clase + 24 h. Ver lib/transcriptDeadline.ts.
--   · Lo único que no se puede derivar es la REAPERTURA del admin: una fecha
--     límite nueva, con motivo, quién y cuándo. Vive en el ingreso
--     (class_join_logs), que es la identidad de la clase en finanzas, y deja
--     historial en transcript_deadline_reopenings.
--   · Las notificaciones de campanita (quedan < 6 h / vencida) NO necesitan
--     tabla: usan un id determinista en `notifications` con upsert
--     ignoreDuplicates, igual que las alertas de bono de 6 meses.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══ 1) REAPERTURA DEL PLAZO (Bloque 1) ══════════════════════════════════════

-- Fecha límite fijada a mano por el admin. NULL = la deriva el código
-- (fin de la clase + 24 h). Cuando está, manda sobre la derivada.
alter table class_join_logs add column if not exists transcript_deadline_at     timestamptz;
alter table class_join_logs add column if not exists transcript_deadline_reason text;
alter table class_join_logs add column if not exists transcript_deadline_by     text;
alter table class_join_logs add column if not exists transcript_deadline_set_at timestamptz;

comment on column class_join_logs.transcript_deadline_at is
  'Plazo reabierto por el admin para subir el transcript. NULL = fin de clase + 24 h (lib/transcriptDeadline.ts).';

-- Historial: cada reapertura deja una fila, aunque el ingreso solo conserve la última.
create table if not exists transcript_deadline_reopenings (
  id                   uuid primary key default gen_random_uuid(),
  join_log_id          text references class_join_logs(id) on delete set null,
  teacher_id           text,
  student_name         text,
  class_date           date,
  previous_deadline_at timestamptz,
  new_deadline_at      timestamptz not null,
  reason               text not null,
  admin_name           text not null,
  created_at           timestamptz not null default now()
);

create index if not exists idx_tdr_join_log on transcript_deadline_reopenings (join_log_id);
create index if not exists idx_tdr_created  on transcript_deadline_reopenings (created_at desc);

alter table transcript_deadline_reopenings disable row level security;


-- ═══ 2) RECORDATORIO DIARIO DE TRANSCRIPTS (ya existe en producción) ═════════
-- El cron de fin de día reserva una fila por profesor y día antes de escribir.
-- Se repite acá con IF NOT EXISTS solo para dejar el esquema completo.

create table if not exists daily_reminder_log (
  id             text primary key,          -- drl_transcript_<teacher_id>_<YYYY-MM-DD>
  teacher_id     text not null,
  reminder_date  date not null,
  classes_count  integer not null default 0,
  sent_at        timestamptz not null default now()
);

create index if not exists daily_reminder_log_fecha_idx on daily_reminder_log (reminder_date desc);

alter table daily_reminder_log disable row level security;


-- ═══ 3) FOLLOW-UPS DE LA PRUEBA DE NIVEL (Bloque 3) ══════════════════════════
--
-- Un solo reloj por alumno: día 0 = form_tokens.created_at del enlace vigente
-- (para los que nunca tuvieron enlace, el día en que el cron se lo genera).
-- Cadencia: días 1, 2, 3, 6, 9, 16, 23, 30, 37, 44, 51, 58 y 65 (13 envíos).
-- Se corta al completar la prueba, al darse de baja, al eliminar al alumno
-- (cascade) o con students.followup_opt_out.
--
-- IDEMPOTENCIA — "reservar y luego enviar": el cron inserta la fila con
-- status 'reservado' ANTES de mandar el correo. El índice único
-- (student_id, numero_envio) hace que dos corridas solapadas no puedan mandar
-- el mismo envío dos veces. Si el correo falla, la fila se borra y la próxima
-- corrida lo reintenta.

create table if not exists level_test_followups (
  id            uuid primary key default gen_random_uuid(),
  -- students.id es TEXT (no uuid), igual que assignments.id.
  student_id    text not null references students(id) on delete cascade,
  token_id      text references form_tokens(id) on delete set null,
  -- A dónde se mandó (students.email normalizado). Si assignments.student_email
  -- era distinto, queda en email_alt para poder revisarlo.
  email         text not null,
  email_alt     text,
  numero_envio  int  not null,     -- 1..13
  dia_relativo  int  not null,     -- día de la cadencia que le tocaba (1, 2, 3, 6, 9, 16…)
  etapa         text not null,     -- 'recordatorio' (días 1-3) | 'espera' (6-9) | 'semanal' (16+)
  sent_at       timestamptz not null default now(),
  resend_id     text,
  status        text not null default 'reservado'   -- 'reservado' | 'sent' | 'failed'
);

create unique index if not exists uq_level_test_followups_envio
  on level_test_followups (student_id, numero_envio);
create index if not exists idx_level_test_followups_student
  on level_test_followups (student_id);
create index if not exists idx_level_test_followups_sent
  on level_test_followups (sent_at desc);

alter table level_test_followups disable row level security;

-- Toggle "No enviar más" de la pestaña Tests de nivel del admin.
alter table students add column if not exists followup_opt_out    boolean default false;
alter table students add column if not exists followup_opt_out_at timestamptz;
alter table students add column if not exists followup_opt_out_by text;

update students set followup_opt_out = false where followup_opt_out is null;


-- ═══ 4) supabase-form-reminders.sql COMPLETO (por si nunca se aplicó) ════════
-- El sistema de follow-up (lib/formReminders.ts) sigue leyendo estas columnas:
-- reminder_variant decide el texto ('veterano' / 'reactivado') y los contadores
-- del token quedan como espejo para el botón "Recordar" y las vistas antiguas.

alter table form_tokens add column if not exists form_reminder_count     int default 0;
alter table form_tokens add column if not exists form_reminder_last_sent timestamptz;
alter table form_tokens add column if not exists test_reminder_count     int default 0;
alter table form_tokens add column if not exists test_reminder_last_sent timestamptz;
alter table form_tokens add column if not exists reminder_variant        text;

update form_tokens set form_reminder_count = 0 where form_reminder_count is null;
update form_tokens set test_reminder_count = 0 where test_reminder_count is null;

create index if not exists idx_form_tokens_completed_at on form_tokens (completed_at desc);

-- Espejo en students para pintar el panel sin cruzar tablas.
alter table students add column if not exists form_reminder_count     int default 0;
alter table students add column if not exists form_reminder_last_sent timestamptz;
alter table students add column if not exists form_reminder_stage     text;   -- 'formulario' | 'test'

update students set form_reminder_count = 0 where form_reminder_count is null;


-- ═══ VARIABLES DE ENTORNO (Vercel → Settings → Environment Variables) ════════
--   · CRON_SECRET               → ya existe; protege los tres crons y el endpoint
--                                 suelto /api/cron/transcripts-vencidos (Zapier).
--   · SUPABASE_SERVICE_ROLE_KEY → los crons pasan a usar getSupabaseAdmin(); sin
--                                 ella responden 500 y no hacen nada.
--   · RESEND_API_KEY            → envío de correos (ya existe).
--   · NEXT_PUBLIC_APP_URL       → base de los enlaces del alumno (ya existe).
--   · STUDENT_REPLY_TO_EMAIL    → opcional; sin ella, alumnos@drcacademy.com.
