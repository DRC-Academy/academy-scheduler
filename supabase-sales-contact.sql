-- ─────────────────────────────────────────────────────────────────────────────
-- Contacto de VENTAS en "Próximos a cancelar" (repesca de intensivos)
--
-- OJO: esto NO es el aviso interno. Son dos marcadores distintos que conviven en
-- la misma pestaña y que no hay que confundir:
--
--   ending_notice_*  → lo pone EL SISTEMA cuando sale el email interno.
--                      Significa "el equipo ya se enteró de este alumno".
--                      Ver supabase-ending-plans.sql.
--   sales_contact_*  → lo pone UNA PERSONA de ventas cuando ya habló con el
--                      alumno, y guarda EN QUÉ QUEDÓ la gestión.
--                      Significa "esto ya está gestionado".
--
-- Que el sistema haya avisado no dice nada de si alguien llamó, y que ventas
-- haya llamado no dice nada de si el email salió. Por eso son cuatro columnas
-- nuevas y no un booleano pegado a las de arriba.
--
--   sales_contacted_at      → cuándo se marcó (null = nunca se contactó).
--   sales_contact_result    → 'interesado' | 'no_interesado' | 'renovo'.
--   sales_contacted_by      → quién lo marcó (el nombre de la sesión del panel),
--                             para trazabilidad. Texto libre a propósito: los
--                             usuarios del panel no son filas de ninguna tabla.
--   sales_contact_for_date  → la fecha de fin DEL CICLO gestionado
--                             (= manual_active_until en el momento de marcarlo).
--
-- EL CICLO. Igual que el aviso, el contacto cuenta solo para SU ciclo:
--
--   sales_contacted_at is not null AND sales_contact_for_date = manual_active_until
--
-- Si el alumno renueva y el admin alarga la activación manual, la fecha deja de
-- coincidir, el alumno vuelve a aparecer como "sin contactar" y ventas puede
-- gestionarlo otra vez al final del ciclo nuevo. Sin la segunda columna, quien
-- renovó quedaría marcado para siempre y nadie volvería a llamarle. La regla
-- vive en lib/endingPlans.salesContactForCycle: este comentario describe el
-- dato, no lo decide.
--
-- LO QUE NO GUARDA. Una sola gestión por alumno y ciclo, no un historial. Al
-- editar el resultado (de 'interesado' a 'renovo', el caso típico) se pisan las
-- tres columnas: `sales_contacted_at` pasa a ser la fecha de la ÚLTIMA gestión y
-- `sales_contacted_by` el último que la tocó. Se acepta a propósito: guardar el
-- primer contacto y el último a la vez pedía una tabla aparte, y hoy lo que
-- ventas necesita saber es en qué quedó, no cuántas veces se intentó.
--
-- USO
--   Ejecutar una vez en el editor SQL de Supabase. Es idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

alter table students add column if not exists sales_contacted_at     timestamptz;
alter table students add column if not exists sales_contact_result   text;
alter table students add column if not exists sales_contacted_by     text;
alter table students add column if not exists sales_contact_for_date date;

-- Los tres resultados posibles y nada más. El panel ya los limita, pero un valor
-- inventado a mano desde el editor de Supabase dejaría filas que ninguna vista
-- sabe pintar (y que no contarían en ningún resumen). NULL sigue permitido: es
-- exactamente "sin contactar".
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'students_sales_contact_result_check'
  ) then
    alter table students add constraint students_sales_contact_result_check
      check (
        sales_contact_result is null
        or sales_contact_result in ('interesado', 'no_interesado', 'renovo')
      );
  end if;
end $$;

comment on column students.sales_contacted_at is
  'Última vez que ventas marcó a mano la gestión de este alumno. NO es el aviso automático (ending_notice_sent_at). Ver supabase-sales-contact.sql.';
comment on column students.sales_contact_result is
  'En qué quedó la gestión de ventas: interesado | no_interesado | renovo.';
comment on column students.sales_contacted_by is
  'Quién marcó la gestión (nombre de la sesión del panel).';
comment on column students.sales_contact_for_date is
  'Fecha de fin del ciclo gestionado. Si ya no coincide con manual_active_until, el alumno renovó y vuelve a estar sin contactar.';
