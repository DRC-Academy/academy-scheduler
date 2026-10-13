-- ─────────────────────────────────────────────────────────────────────────────
-- Cuándo avisó el alumno (y quién canceló la clase)
--
-- POR QUÉ ESTE SQL. El LMS va a calcular si cada alumno mantiene la garantía de
-- su plan, y una de las reglas es que una clase que el ALUMNO cancela con menos
-- de 24 h de antelación cuenta como no asistida. Gestión no guardaba ese dato:
--   · class_records.created_at es cuándo el profesor sube la constancia, a
--     menudo horas después de la clase;
--   · "avisó con anticipación" (→ 'reprogramada') y "avisó sobre la hora"
--     (→ 'cancelacion_hora') los elegía el profesor a ojo, sin umbral.
-- Desde ahora el profesor dice CUÁNDO le avisaron y el tipo se deduce de la
-- antelación (lib/avisoAlumno). Este SQL crea las dos columnas donde se guarda.
--
--   · avisado_en    → instante real del aviso. NULL = no consta.
--   · cancelado_por → 'alumno' | 'profesor' | 'academia'. NULL = no consta.
--
-- RELLENO: SOLO lo que se sabe con certeza. No se inventan horas: lo que el
-- histórico no dice se queda en NULL.
--   1) Reprogramadas del autoservicio del LMS: la constancia se crea en el
--      mismo instante en que el alumno mueve la clase → avisado_en = created_at.
--   2) Cancelaciones del botón "No puedo dar esta clase" (class_recoveries):
--      el aviso es la propia cancelación → avisado_en = cancelled_at. Las
--      reclasificaciones del admin (origin = 'admin_reclasificacion') solo
--      reciben cancelado_por: su cancelled_at es la hora de la clase puesta a
--      mano, no un aviso.
--   3) Reprogramadas con "Motivo: Yo (el profesor)…": cancelado_por = 'profesor',
--      sin hora (no consta cuándo avisó).
--
-- Requiere supabase-class-recoveries.sql y supabase-class-recoveries-b.sql (la
-- columna class_recoveries.origin) ya corridos.
--
-- IDEMPOTENTE: se puede correr dos veces sin romper nada. El relleno solo toca
-- filas con el dato en NULL, así que no pisa lo que el código ya haya guardado.
--
-- SE PUEDE CORRER DESPUÉS DEL DEPLOY. El código detecta que las columnas no
-- están y guarda la constancia sin ellas (lib/classRecordStore), así que no hay
-- ventana de error entre el deploy y este script. Lo que se guarde en esa
-- ventana se pierde: conviene correrlo ANTES.
-- ─────────────────────────────────────────────────────────────────────────────

alter table class_records
  add column if not exists avisado_en timestamptz;

alter table class_records
  add column if not exists cancelado_por text;

comment on column class_records.avisado_en is
  'Instante en que se avisó de que la clase no se daba (el alumno al profesor, o el profesor '
  'al cancelar). NO es created_at, que es cuándo se subió la constancia. Con la hora de la '
  'clase da la antelación: menos de 24 h = cancelación sobre la hora (lib/avisoAlumno). '
  'NULL = no consta.';

comment on column class_records.cancelado_por is
  'Quién canceló la clase: alumno, profesor o academia. NULL = no consta (constancias '
  'anteriores a esta columna, o clases dadas).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'class_records_cancelado_por_valido') then
    alter table class_records
      add constraint class_records_cancelado_por_valido
      check (cancelado_por is null or cancelado_por in ('alumno', 'profesor', 'academia'));
  end if;
end $$;

-- ── Relleno ──────────────────────────────────────────────────────────────────

-- 1) Autoservicio del LMS: el alumno movió la clase desde la plataforma.
update class_records
   set avisado_en    = coalesce(avisado_en, created_at),
       cancelado_por = coalesce(cancelado_por, 'alumno')
 where class_type = 'reprogramada'
   and comment like '%Motivo: el alumno la movió desde la plataforma (autoservicio)%'
   and (avisado_en is null or cancelado_por is null);

-- 2) "No puedo dar esta clase": una constancia puede tener varias filas en
--    class_recoveries (una por trozo), todas con el mismo cancelled_at.
update class_records cr
   set avisado_en    = coalesce(cr.avisado_en, rec.cancelled_at),
       cancelado_por = coalesce(cr.cancelado_por, 'profesor')
  from (
    select cancel_record_id, min(cancelled_at) as cancelled_at
      from class_recoveries
     where cancel_record_id is not null
       and origin <> 'admin_reclasificacion'
     group by cancel_record_id
  ) rec
 where rec.cancel_record_id = cr.id
   and (cr.avisado_en is null or cr.cancelado_por is null);

--    Reclasificaciones del admin: quién sí, cuándo no.
update class_records cr
   set cancelado_por = 'profesor'
 where cr.cancelado_por is null
   and exists (
     select 1 from class_recoveries rec
      where rec.cancel_record_id = cr.id
        and rec.origin = 'admin_reclasificacion'
   );

-- 3) Reprogramadas porque el PROFESOR lo pidió (modal "Reprogramar", motivo
--    "Yo (el profesor) necesito cambiarla"; también la versión partida en dos).
update class_records
   set cancelado_por = 'profesor'
 where class_type = 'reprogramada'
   and comment like '%Motivo: Yo (el profesor)%'
   and cancelado_por is null;

-- ── Comprobación ─────────────────────────────────────────────────────────────

-- Las dos columnas existen (debe devolver 2 filas).
-- select column_name, data_type from information_schema.columns
--  where table_name = 'class_records' and column_name in ('avisado_en', 'cancelado_por');

-- Qué quedó relleno, por tipo y por quién canceló.
-- select class_type, cancelado_por, count(*) as filas, count(avisado_en) as con_aviso
--   from class_records
--  where class_type <> 'normal'
--  group by 1, 2 order by 1, 2;

-- Ningún aviso posterior a la creación de su constancia: el formulario no deja
-- poner un aviso futuro y el relleno usa instantes anteriores (debe devolver 0).
-- select count(*) from class_records
--  where avisado_en is not null and avisado_en > created_at + interval '1 minute';

-- ── Vuelta atrás ─────────────────────────────────────────────────────────────
-- El código sigue funcionando sin las columnas (las quita al insertar).
--
-- alter table class_records drop constraint if exists class_records_cancelado_por_valido;
-- alter table class_records drop column if exists cancelado_por;
-- alter table class_records drop column if exists avisado_en;
