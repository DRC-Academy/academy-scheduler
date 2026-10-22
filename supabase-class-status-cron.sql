-- Reloj de las clases SIN ESTADO: cada hora llama a /api/cron/estado-clases.
--
-- A las 24 h del final de una clase sin estado se avisa al profesor (campanita +
-- email) y a las 48 h al admin. Reglas en lib/classStatus, avisos en
-- lib/classStatusStore. NO crea tablas: el anti-duplicado son los ids fijos de
-- `notifications` (estado_<…> y estado_<…>_admin).
--
-- REQUISITOS (ya están si corre el chequeo de ausencias, supabase-teacher-absences.sql):
--   · extensiones pg_cron y pg_net;
--   · el secreto 'cron_ausencias_secret' en Vault, igual a CRON_AUSENCIAS_SECRET
--     en Vercel. Este reloj usa el MISMO secreto.
--
-- Corre a los 5 minutos de cada hora, de 08:00 a 22:59 de España, todos los
-- días: así no salen correos de madrugada (lo de la noche se avisa a las 08:05).
-- Es idempotente: se puede volver a ejecutar.
--
-- VUELTA ATRÁS:
--   select cron.unschedule('estado-clases');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'estado-clases') THEN
    PERFORM cron.unschedule('estado-clases');
  END IF;
END $$;

SELECT cron.schedule(
  'estado-clases',
  '5 * * * *',
  $job$
  SELECT net.http_get(
    url := 'https://academy-scheduler-aqpt.vercel.app/api/cron/estado-clases',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_ausencias_secret')
    ),
    timeout_milliseconds := 55000
  )
  WHERE (now() AT TIME ZONE 'Europe/Madrid')::time BETWEEN time '08:00' AND time '22:59';
  $job$
);


-- ── Comprobaciones ────────────────────────────────────────────────────────────
-- El job existe (debe devolver una fila):
--   select jobid, jobname, schedule, active from cron.job where jobname = 'estado-clases';
-- Las últimas vueltas del reloj (status 'succeeded'):
--   select start_time, status, return_message from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'estado-clases')
--    order by start_time desc limit 10;
-- Lo que respondió Vercel (status_code 200 y el resumen en content):
--   select created, status_code, left(content, 300) from net._http_response order by created desc limit 10;
-- Los avisos creados:
--   select id, target_user, target_role, title, created_at from notifications
--    where type in ('clase_sin_estado', 'clase_sin_estado_admin') order by created_at desc limit 20;
