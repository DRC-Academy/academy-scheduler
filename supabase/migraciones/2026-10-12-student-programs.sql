-- ===========================================================================
-- student_programs  --  programas de la nueva oferta (oct/2026) y su aviso de
-- renovacion
--
-- Una fila por PEDIDO DE ORIGEN de WooCommerce de uno de los 7 productos de
-- programa (lib/programs.ts, PROGRAM_PRODUCTS). Las renovaciones de suscripcion
-- NO crean fila: el pedido de origen de un fraccionado es el de alta.
--
--   start_date  fecha de pago del pedido (date_paid), en hora de Madrid.
--   end_date    pago unico: start_date + 6 o 9 meses.
--               fraccionado: end_date de la suscripcion en Woo (expira sola en
--               el mes 6). Si Woo no la da, start_date + meses y
--               end_date_source = 'calculada'.
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
-- El panel lo lee por /api/programas.
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
