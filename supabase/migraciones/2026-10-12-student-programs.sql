-- ===========================================================================
-- student_programs  --  programas de la nueva oferta (oct/2026) y su aviso de
-- renovacion
--
-- ESTADO (10/11/2026): la tabla YA EXISTE en produccion (vacia, con todas estas
-- columnas). Este archivo no cambia nada del esquema: se puede correr igual,
-- porque todo es "if not exists" y los grants se repiten sin efecto.
--
-- Una fila por PEDIDO DE ORIGEN de WooCommerce de uno de los 8 programas con
-- aviso de renovacion (lib/programRenewal.ts, RENEWAL_PROGRAMS, sobre el
-- catalogo de lib/productCatalog.ts). Las renovaciones de suscripcion NO crean
-- fila: el pedido de origen de un fraccionado es el de alta.
--
-- Solo la usa el aviso de renovacion. NO decide el acceso de nadie.
--
--   start_date  inicio del programa, en hora de Madrid: pago unico = fecha de
--               pago o, si Gestion tiene el inicio real (setter), ese;
--               fraccionado = start_date_gmt de la suscripcion.
--   end_date    pago unico: inicio + 6 o 9 meses, o el acceso de Gestion
--               (students.manual_active_until) si es mas tarde.
--               fraccionado: end_date_gmt de la suscripcion en Woo. Si Woo no
--               la da, inicio + meses y end_date_source = 'calculada'.
--
-- ENLACE CON EL ALUMNO (student_id)
--   link_source = 'email'  -> lo puso la sincronizacion (email de facturacion =
--                             students.email). La sincronizacion lo recalcula.
--   link_source = 'manual'  -> lo puso el admin a mano (programas de menores: el
--                             email de facturacion es del padre). La
--                             sincronizacion NUNCA lo pisa.
--   student_id null         -> pedido sin alumno en Gestion. Igual se avisa,
--                             con "Profe: sin asignar" y una advertencia.
--   Sin FK a students a proposito: una FK nueva entra en la cadena de borrado
--   del alumno (delete_student_cascade). Si el alumno se borra, la fila queda
--   huerfana y el aviso sale como "no enlazado", que es lo correcto.
--
-- AVISO DE RENOVACION
--   renewal_notified_for = la end_date por la que se aviso. Cuenta como avisado
--   solo si coincide con end_date: si Woo corrige la fecha, vuelve a avisarse.
--
-- RLS activado y SIN politicas: solo el servidor (service role) lee y escribe.
--
-- Idempotente: se puede correr varias veces. ASCII puro a proposito.
-- ===========================================================================

create table if not exists public.student_programs (
  id                    uuid primary key default gen_random_uuid(),
  order_id              bigint not null unique,
  customer_id           bigint,
  email                 text,
  billing_name          text,
  billing_phone         text,

  student_id            text,
  link_source           text check (link_source in ('email', 'manual')),
  linked_by             text,
  linked_at             timestamptz,

  product_id            bigint not null,
  program               text not null check (program in ('desbloqueo', 'fluidez', 'acelerado', 'platino')),
  payment_mode          text not null check (payment_mode in ('unico', 'fraccionado')),
  months                int  not null,

  start_date            date,
  end_date              date,
  end_date_source       text check (end_date_source in ('woo', 'calculada')),

  order_status          text,
  subscription_id       bigint,
  subscription_status   text,

  renewal_notified_at   timestamptz,
  renewal_notified_for  date,

  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create index if not exists idx_student_programs_student on public.student_programs (student_id);
create index if not exists idx_student_programs_email   on public.student_programs (lower(email));
create index if not exists idx_student_programs_end     on public.student_programs (end_date);

alter table public.student_programs enable row level security;
revoke all on public.student_programs from anon, authenticated;
grant select, insert, update, delete on public.student_programs to service_role;

-- Comprobacion: debe devolver la tabla con RLS activado.
select relname, relrowsecurity
from pg_class
where relname = 'student_programs';
