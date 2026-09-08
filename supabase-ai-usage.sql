-- ─────────────────────────────────────────────────────────────────────────────
-- Registro de uso de la GENERACIÓN DE CLASES CON IA.
--
-- QUÉ PROBLEMA RESUELVE. Hasta ahora no quedaba rastro de quién usaba la
-- herramienta. Lo único que se guardaba era `student_profiles.next_class_content`
-- y `next_class_generated_at`, que se SOBRESCRIBEN en cada generación: una fila
-- por alumno, solo la última vez, y sin el profesor por ningún lado. Con eso no
-- se puede contestar "¿qué profesores no la están usando?", que es justo la
-- pregunta que se quiere contestar.
--
-- QUÉ GUARDA: metadatos y nada más. Quién, qué alumno, cuándo y desde dónde.
--
-- QUÉ NO GUARDA, a propósito: ni la transcripción, ni la clase generada, ni la
-- ficha. Todo eso ya vive en `class_analyses` y `student_profiles`, pesa mucho y
-- duplicarlo aquí convertiría un listado de admin en una descarga de varios MB
-- cada vez que se abre la pestaña. Ver el mismo criterio en
-- supabase-has-transcript.sql.
--
-- SIN FK a `teachers`. Las claves foráneas son justamente lo que impide borrar
-- un profesor (por eso se archivan, ver supabase-teacher-archive.sql), y un log
-- de uso no es motivo para bloquear nada. `teacher_name` se guarda desnormalizado
-- por el mismo motivo que `teacher_confirmed_by` en student_profiles: es lo que
-- se enseña y sobrevive a que el profesor desaparezca de la tabla.
--
-- HISTÓRICO: no lo hay. El registro empieza en cuanto corras esto; lo anterior
-- no se puede reconstruir porque nunca se guardó.
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente. Como
-- el resto del sistema, RLS queda deshabilitado y se lee con la clave anónima.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ai_class_generations (
  id           uuid primary key default gen_random_uuid(),

  -- Quién. `teacher_id` puede venir null: NextClassModal se abre desde sitios
  -- que solo conocen el nombre del profesor.
  teacher_id   text,
  teacher_name text,

  -- Para qué alumno. Sin FK: se generan clases para alumnos que todavía no
  -- están en `students` (el alta va por otro lado y a veces llega después).
  student_id   text,
  student_name text not null,

  -- Desde dónde se pidió:
  --   transcript → el profesor pegó la transcripción de la clase dada y la
  --                plataforma encadenó la siguiente. Es LA acción que se quería
  --                medir.
  --   directa    → pulsó "Generar clase" sin pegar nada (primera clase del
  --                alumno, regenerar, clase genérica).
  -- Se distinguen en vez de registrar solo la primera porque las dos son "usar
  -- la herramienta": un profesor que genera clases sin transcript NO es un
  -- profesor que no la usa, y meterlo en esa lista sería un falso positivo.
  origin       text not null default 'directa' check (origin in ('transcript', 'directa')),

  created_at   timestamptz not null default now()
);

alter table ai_class_generations disable row level security;

-- El listado sale siempre ordenado por fecha descendente.
create index if not exists idx_aigen_created_at on ai_class_generations (created_at desc);
-- El resumen agrupa por profesor.
create index if not exists idx_aigen_teacher    on ai_class_generations (teacher_id, created_at desc);

comment on table  ai_class_generations         is 'Una fila por clase generada con IA. Solo metadatos: ni transcripción ni contenido.';
comment on column ai_class_generations.origin  is 'transcript = el profesor pegó la transcripción; directa = pulsó generar sin pegar nada.';

-- ── Verificación ─────────────────────────────────────────────────────────────
-- Después de correrlo, la tabla debería existir y estar vacía:
--
--   select count(*) from ai_class_generations;
--
-- Y en cuanto un profesor genere una clase, esto tiene que devolver su fila:
--
--   select teacher_name, student_name, origin, created_at
--     from ai_class_generations
--    order by created_at desc
--    limit 10;
