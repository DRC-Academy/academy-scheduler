-- ─────────────────────────────────────────────────────────────────────────────
-- Onboarding guiado del profesor (tutorial interactivo)
--
-- Dos vías de acceso, y solo UNA de las dos mira estas columnas:
--   · AUTOMÁTICO (profesores nuevos): el recorrido salta solo durante sus
--     primeras 5 clases. Es lo que gobiernan estas tres columnas.
--   · BAJO DEMANDA: el botón "Tutorial" del header lo puede abrir CUALQUIER
--     profesor, nuevo o antiguo, las veces que quiera. NO consulta nada de acá.
--
-- Por qué `onboarding_active` arranca en `true`:
--   dbAddTeacher (lib/db.ts) inserta un profesor nuevo con una lista EXPLÍCITA de
--   columnas (id, name, email, avatar, username, password, specialties) y no
--   menciona ninguna de estas. Por eso el default se aplica solo a las filas
--   nuevas, y basta con apagarlo una vez para los profesores que ya existen: los
--   que se creen de ahora en adelante nacen en onboarding sin tocar código.
--
-- El orden importa: primero el ALTER, después el UPDATE. En ese instante las
-- únicas filas de la tabla son las de los profesores actuales.
--
-- `onboarding_started_at` queda NULL a propósito (sin `default now()`): lo escribe
-- la app la primera vez que le muestra el tutorial al profesor. Con un default
-- los profesores actuales quedarían con la fecha de esta migración, que es un
-- dato falso.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table teachers add column if not exists onboarding_active            boolean default true;
alter table teachers add column if not exists onboarding_classes_completed int     default 0;
alter table teachers add column if not exists onboarding_started_at        timestamptz;

-- Los profesores que YA existen no reciben el tutorial automático. El `where`
-- no es imprescindible (en este momento todas las filas son las suyas), pero deja
-- el script a salvo de volver a correrse por error más adelante: un profesor nuevo
-- que ya avanzó en su formación nunca tiene el contador en 0 y en cero.
update teachers
   set onboarding_active = false
 where onboarding_classes_completed = 0
   and onboarding_started_at is null;

-- Filas viejas creadas antes del default: sin esto quedarían en NULL y la app
-- las trataría como "sin decidir".
update teachers set onboarding_classes_completed = 0 where onboarding_classes_completed is null;

-- ── Verificación ─────────────────────────────────────────────────────────────
-- Debería devolver 0 profesores en onboarding automático justo después de correrlo:
--
--   select count(*) filter (where onboarding_active) as en_onboarding,
--          count(*)                                  as total
--     from teachers;
