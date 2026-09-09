-- ─────────────────────────────────────────────────────────────────────────────
-- Reprogramar una clase de 2 h en DOS días distintos
--
-- POR QUÉ ESTE SQL. La función en sí no necesita base nueva: dos celdas de
-- recuperación en días distintos ya son dos sesiones de 1 h, y el saldo de horas
-- (lib/recoveryLedger) se deriva de lo que ya existe. Lo que sí hace falta es
-- SELLAR cuántas horas valía la clase al perderse.
--
-- Hoy ese número se re-deduce del calendario de HOY, y `teacher_calendars` no
-- guarda historia: si al alumno le cambian el horario, un crédito viejo cambia de
-- tamaño solo. Una clase de 2 h reprogramada en dos horas y luego un cambio de
-- horario dejaba el crédito en 1 h con 2 h ya repuestas.
--
-- IDEMPOTENTE: se puede correr dos veces sin romper nada.
--
-- SE PUEDE CORRER DESPUÉS DEL DEPLOY. El código detecta que la columna no está y
-- cae al cálculo derivado (que es el comportamiento de siempre), así que no hay
-- ventana de error entre el deploy y este script.
-- ─────────────────────────────────────────────────────────────────────────────

alter table class_records
  add column if not exists lost_hours int;

comment on column class_records.lost_hours is
  'Horas que valía esta clase cuando se perdió (falta con aviso, cancelación, reprogramación). '
  'Se sella al crear la constancia y NO se recalcula. Es el tamaño del crédito de recuperación, '
  'no la duración de una clase dada. NULL = constancia anterior a esta columna: el crédito se '
  'deduce del calendario, como hasta ahora.';

-- Rango sensato para lost_hours: ninguna clase vale 0 ni 40 horas.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'class_records_lost_hours_rango') then
    alter table class_records
      add constraint class_records_lost_hours_rango
      check (lost_hours is null or (lost_hours >= 1 and lost_hours <= 6));
  end if;
end $$;

-- Fechas imposibles: cinturón para que un año mal tipeado no entre más. La
-- auditoría de septiembre de 2026 encontró recuperaciones apuntando a 0266-09-04
-- y a 2006-09-02, las dos entradas por la salida del modal ("registrar que el
-- alumno avisó"), que da por buena cualquier fecha pasada con formato correcto.
--
-- `not valid`: valida lo NUEVO y no revalida el histórico, así las filas que ya
-- están mal no bloquean la migración ni se corrigen solas (son decisión del
-- admin, caso por caso).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'class_records_recovery_for_date_sensata') then
    alter table class_records
      add constraint class_records_recovery_for_date_sensata
      check (
        recovery_for_date is null
        or (recovery_for_date >= date '2024-01-01' and recovery_for_date <= date '2030-12-31')
      ) not valid;
  end if;
end $$;

-- El crédito de recuperación se consulta por (alumno, clase perdida).
create index if not exists class_records_recovery_for_date_idx
  on class_records (student_name, recovery_for_date)
  where recovery_for_date is not null;
