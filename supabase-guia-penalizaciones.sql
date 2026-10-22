-- ─────────────────────────────────────────────────────────────────────────────
-- Guía del profesor: cancelaciones, recuperaciones y faltas (oct/2026)
--
-- Una columna: cuándo terminó el profesor la guía (botón "Entendido" del último
-- paso). La escribe lib/penaltyGuideStore y la lee el admin en la pestaña
-- Profesores ("Guía ✓ dd/mm"). NULL = todavía no la terminó, y mientras sea NULL
-- le sale el panel inferior hasta el 01/11/2026.
--
-- Sin `default`: nadie la "vio" por correr este script. Cerrar la guía a mitad no
-- escribe nada.
--
-- Idempotente: se puede correr dos veces sin efecto.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.teachers
  add column if not exists penalty_guide_completed_at timestamptz;

comment on column public.teachers.penalty_guide_completed_at is
  'Cuándo terminó el profesor la guía de penalizaciones ("Entendido"). NULL = no la vio.';

-- Comprobación: debe devolver una fila con data_type = timestamp with time zone.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'teachers' and column_name = 'penalty_guide_completed_at';
