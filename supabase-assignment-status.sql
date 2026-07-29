-- ===========================================================================
-- assignments.status  --  retirar un alumno sin perder su historial
--
-- ASCII puro a proposito (ver el incidente del 29/07/2026: los acentos y los
-- guiones largos en los comentarios rompian el parser al pegar en el editor).
--
-- Un alumno pertenece a un profesor si y solo si tiene al menos una celda en el
-- grid de teacher_calendars. Cuando se libera su ULTIMA celda, el assignment se
-- marca 'inactive' en vez de borrarse, para conservar el contador de clases y el
-- historial contable. Si se le vuelve a asignar una celda, vuelve a 'active'.
--
-- Es idempotente: se puede correr varias veces sin efecto.
--
-- IMPORTANTE: todas las filas existentes quedan en 'active'. Esta migracion NO
-- retira a nadie. Los 22 assignments hoy huerfanos siguen 'active' hasta que se
-- decida caso por caso (ver scripts/diagnose-orphan-assignments.mjs).
-- ===========================================================================


alter table assignments add column if not exists status text default 'active';

-- Las filas anteriores a la columna quedan con status null: se normalizan a
-- 'active' para que ningun listado tenga que tratar el null como caso aparte.
update assignments set status = 'active' where status is null;

create index if not exists idx_assignments_status on assignments (status);

create index if not exists idx_assignments_teacher_status
  on assignments (teacher_id, status);


-- Comprobacion: debe devolver una fila con status='active' y el total.
select status, count(*) as total
from assignments
group by status
order by status;
