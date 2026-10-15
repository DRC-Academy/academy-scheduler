-- ── Posibles ausencias del profesor: tabla + reloj cada 5 minutos ─────────────
--
-- A los 30 minutos del inicio de una clase sin "Ingresar a clase", Gestión avisa
-- a Zapier (WhatsApp al alumno + Slack) y lo anota aquí. Lógica en
-- lib/teacherAbsences.ts (reglas) y lib/teacherAbsenceStore.ts (base + Zapier);
-- el endpoint es /api/cron/ausencias.
--
-- CUÁNDO CORRERLO: DESPUÉS de publicar el código y de cargar en Vercel
-- CRON_AUSENCIAS_SECRET. Si se corre antes, el reloj llama cada 5 minutos a un
-- endpoint que todavía no existe (no rompe nada, pero ensucia los registros).
--
-- ANTES DE CORRERLO, reemplazar abajo PEGAR_AQUI_EL_SECRETO por el MISMO valor
-- de CRON_AUSENCIAS_SECRET que se cargó en Vercel. Queda guardado en el Vault de
-- Supabase (cifrado), no en texto plano dentro del reloj.
--
-- Idempotente: se puede volver a correr (por ejemplo, para cambiar el secreto).
--
-- Reversible:
--   select cron.unschedule('ausencias-profesor');
--   drop table teacher_absence_alerts;
--   (el secreto: delete from vault.secrets where name = 'cron_ausencias_secret';)


-- ── 1) La tabla ───────────────────────────────────────────────────────────────
-- Una fila por clase. El id es FIJO por clase (profesor + fecha + hora + alumno):
-- es la clave primaria, y es lo que impide avisar dos veces por la misma clase.
-- Sin FK a students/assignments/teachers, a propósito (como class_recoveries): el
-- borrado total de un alumno descubre las FK del catálogo y una nueva lo bloquearía.

CREATE TABLE IF NOT EXISTS teacher_absence_alerts (
  id                  text PRIMARY KEY,
  teacher_id          text NOT NULL,
  teacher_name        text,
  student_id          text,
  student_name        text NOT NULL,
  student_email       text,
  student_phone       text,                    -- formato internacional (+34…), o null
  class_date          date NOT NULL,           -- hora de España
  class_hour          text NOT NULL,           -- 'HH:00' de inicio
  duration_hours      smallint NOT NULL DEFAULT 1,
  is_recovery         boolean NOT NULL DEFAULT false,

  status              text NOT NULL
                      CHECK (status IN ('posible_ausencia', 'llego_tarde', 'no_verificado', 'descartada')),
  status_reason       text,                    -- p. ej. "Alumno en pausa." o "WooCommerce no respondió…"
  subscription_status text,                    -- lo que dijo la verificación (active, paused, error…)
  detected_at         timestamptz NOT NULL DEFAULT now(),
  late_joined_at      timestamptz,             -- hora del "Ingresar" posterior (llegó tarde)

  zapier_status       text NOT NULL DEFAULT 'pendiente'
                      CHECK (zapier_status IN ('pendiente', 'enviado', 'sin_webhook', 'error', 'no_enviado')),
  zapier_attempts     smallint NOT NULL DEFAULT 0,
  zapier_sent_at      timestamptz,
  zapier_error        text,
  payload             jsonb,                   -- exactamente lo que se mandó a Zapier

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Guarda teléfonos: RLS ACTIVADO y sin políticas. Solo la lee y escribe el
-- servidor con la service role (el cron y /api/admin/posibles-ausencias).
ALTER TABLE teacher_absence_alerts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_teacher_absence_alerts_date    ON teacher_absence_alerts (class_date);
CREATE INDEX IF NOT EXISTS idx_teacher_absence_alerts_teacher ON teacher_absence_alerts (teacher_id, class_date);


-- ── 2) Las extensiones del reloj ─────────────────────────────────────────────
-- pg_cron (el reloj) y pg_net (la llamada HTTP). En Supabase también se pueden
-- activar desde Database → Extensions; esto hace lo mismo.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;


-- ── 3) El secreto, en el Vault ───────────────────────────────────────────────

DO $$
DECLARE
  v_secret text := 'PEGAR_AQUI_EL_SECRETO';
  v_id uuid;
BEGIN
  IF v_secret = 'PEGAR_AQUI_EL_SECRETO' OR length(v_secret) < 32 THEN
    RAISE EXCEPTION 'Reemplazá PEGAR_AQUI_EL_SECRETO por el valor de CRON_AUSENCIAS_SECRET antes de correr el script.';
  END IF;
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'cron_ausencias_secret';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(v_secret, 'cron_ausencias_secret', 'Secreto de /api/cron/ausencias (CRON_AUSENCIAS_SECRET en Vercel)');
  ELSE
    PERFORM vault.update_secret(v_id, v_secret);
  END IF;
END $$;


-- ── 4) El reloj: cada 5 minutos, lunes a sábado, 07:00–23:30 de España ───────
-- pg_cron trabaja en UTC y España cambia de hora, así que el job corre cada 5
-- minutos y la FRANJA se comprueba dentro, en hora de Madrid: fuera de ella no
-- se llama a Vercel (no gasta nada). Hasta las 23:34 para que entre la vuelta de
-- las 23:30, la que mira las clases de las 23:00.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ausencias-profesor') THEN
    PERFORM cron.unschedule('ausencias-profesor');
  END IF;
END $$;

SELECT cron.schedule(
  'ausencias-profesor',
  '*/5 * * * *',
  $job$
  SELECT net.http_get(
    url := 'https://academy-scheduler-aqpt.vercel.app/api/cron/ausencias',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_ausencias_secret')
    ),
    timeout_milliseconds := 30000
  )
  WHERE extract(isodow FROM (now() AT TIME ZONE 'Europe/Madrid')) BETWEEN 1 AND 6
    AND (now() AT TIME ZONE 'Europe/Madrid')::time BETWEEN time '07:00' AND time '23:34';
  $job$
);


-- ── Comprobaciones ────────────────────────────────────────────────────────────
-- El job existe (debe devolver una fila):
--   select jobid, jobname, schedule, active from cron.job where jobname = 'ausencias-profesor';
-- Las últimas vueltas del reloj (status 'succeeded'):
--   select start_time, status, return_message from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'ausencias-profesor')
--    order by start_time desc limit 10;
-- Lo que respondió Vercel (status_code 200 y el resumen en content):
--   select created, status_code, left(content, 300) from net._http_response order by created desc limit 10;
-- Las posibles ausencias anotadas hoy:
--   select class_hour, teacher_name, student_name, status, zapier_status from teacher_absence_alerts
--    where class_date = (now() at time zone 'Europe/Madrid')::date order by class_hour;
