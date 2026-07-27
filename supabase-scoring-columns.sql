-- ─────────────────────────────────────────────────────────────────────────────
-- Columnas que faltaban en scoring_events
--
-- POR QUÉ: `dbAddScoringEvent` (lib/db.ts) escribe `student_ref` y `quantity`,
-- pero esas columnas nunca se crearon en la tabla. PostgREST rechazaba el INSERT
-- ENTERO con PGRST204 ("Could not find the 'quantity' column"), así que NINGÚN
-- evento de scoring se guardaba: ni faltas, ni bonos, ni upsells.
--
-- El fallo era invisible porque la función no comprobaba el error del insert y
-- el contexto metía el evento en el estado local, así que en pantalla parecía
-- guardado hasta recargar la página. Comprobado el 27/07/2026: la tabla tenía
-- UNA fila (un quarterly_reset de junio) pese a haberse cargado eventos a mano.
--
--   · student_ref → alumno al que se refiere el evento (falta, upsell, cambio).
--     Lo usa el contador interno de faltas del admin.
--   · quantity    → cantidad, sólo para 'upsell' (€20 por cada uno).
--
-- Ejecutá este script UNA vez en el SQL editor de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table scoring_events add column if not exists student_ref text;
alter table scoring_events add column if not exists quantity    int;

-- Estas tres ya existían, pero se incluyen por si se ejecuta en un entorno nuevo.
alter table scoring_events add column if not exists euros       numeric default 0;
alter table scoring_events add column if not exists reverted    boolean default false;
alter table scoring_events add column if not exists reverted_by text;
alter table scoring_events add column if not exists reverted_at timestamptz;

create index if not exists idx_scoring_events_teacher on scoring_events (teacher_id);
create index if not exists idx_scoring_events_type    on scoring_events (event_type);

-- Comprobación: las 6 columnas deben aparecer listadas.
select column_name, data_type
from information_schema.columns
where table_name = 'scoring_events'
  and column_name in ('student_ref', 'quantity', 'euros', 'reverted', 'reverted_by', 'reverted_at')
order by column_name;
