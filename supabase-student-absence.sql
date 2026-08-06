-- ─────────────────────────────────────────────────────────────────────────────
-- Falta sin aviso DEL ALUMNO — reversión por el admin. Idempotente.
--
-- El profesor entró a la clase y el alumno no se presentó: no hay transcript
-- posible, así que la clase se marca como falta y se le paga a tarifa normal.
-- Se guarda como un class_records con class_type = 'falta_sin_aviso' (el mismo
-- que ya usaba el selector "Falta del alumno sin aviso" de "Añadir clase"): un
-- solo tipo, un solo camino. No hace falta ninguna columna nueva para marcarla.
--
-- Lo que sí se añade acá es el rastro de la REVERSIÓN. El admin no borra la
-- fila: le cambia el class_type a 'falta_sin_aviso_revertida', un valor que el
-- cálculo de finanzas ignora, con lo que la clase vuelve sola a "pendiente de
-- transcript" y deja de contar para el pago, para el tope de 2 del mes y para
-- el cupo mensual del alumno. Estas dos columnas dicen quién la deshizo y cuándo.
--
-- OJO — no confundir con 'cancelada_por_profesor', el tipo NUEVO que se lleva la
-- cancelación del profesor con menos de 24 h de antelación (botón "Cancelar
-- clase"). Ese caso NO se cobra y sí penaliza -5 €: es el reverso exacto. Hasta
-- ago/2026 los dos casos compartían el tipo 'falta_sin_aviso', que es justamente
-- lo que hacía que la falta del alumno arrastrara una penalización ajena.
--
-- El scoring_event de esa penalización conserva el nombre viejo
-- ('falta_sin_aviso_penalizacion') para no orfanar los 17 eventos ya emitidos ni
-- romper el botón "Revertir" de Penalizaciones del mes, en el panel de finanzas.
--
-- Los class_records de 'falta_sin_aviso' anteriores a ago/2026 son una MEZCLA de
-- los dos casos y no se migran automáticamente: hoy se leen todos como falta del
-- alumno (cobrable). Ver la consulta de auditoría al final.
-- ─────────────────────────────────────────────────────────────────────────────

alter table class_records add column if not exists reverted_at timestamptz;
alter table class_records add column if not exists reverted_by text;

-- El cálculo filtra faltas por (teacher_id, class_type, class_date) al contar el
-- tope mensual de cada alumno.
create index if not exists idx_class_records_type_date on class_records (teacher_id, class_type, class_date);

-- ── AUDITORÍA (solo lectura): faltas históricas, ¿del alumno o del profesor? ──
-- Si hay un ingreso ese día, el profesor entró: fue el alumno el que no vino.
-- Si no lo hay, lo más probable es que la clase la cancelara él por adelantado y
-- que ese registro debiera ser 'cancelada_por_profesor'. No cambia nada: es para
-- decidir a mano cuáles de las penalizaciones viejas conviene revertir.
--
--   select r.teacher_name, r.student_name, r.class_date, r.comment,
--          exists (select 1 from class_join_logs l
--                  where l.teacher_id = r.teacher_id
--                    and lower(trim(l.student_name)) = lower(trim(r.student_name))
--                    and l.scheduled_date between r.class_date - 1 and r.class_date + 1
--                 ) as hubo_ingreso
--   from class_records r
--   where r.class_type = 'falta_sin_aviso'
--   order by r.class_date;
