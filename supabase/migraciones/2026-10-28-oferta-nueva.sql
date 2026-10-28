-- Oferta nueva (oct/2026): catálogo por ID de producto + activación de pedidos.
-- Ver lib/productCatalog.ts, lib/planOrders.ts y lib/planOrderStore.ts.
--
-- Idempotente: se puede correr más de una vez.

-- 1) Producto de la oferta nueva que tiene el alumno (ID de WooCommerce).
--    Lo escribe SOLO la activación de pedidos/suscripciones. Con un producto del
--    catálogo, el cupo mensual sale de sus horas semanales. NULL = como siempre.
alter table public.students add column if not exists woo_product_id bigint;

-- 2) Registro de lo procesado: un evento por pedido/suscripción y producto.
--    Es lo que hace idempotente la activación (un pedido aplicado no se vuelve
--    a aplicar) y la fuente de los avisos del admin (needs_admin sin resolver).
create table if not exists public.woo_plan_events (
  source_type     text   not null check (source_type in ('order', 'subscription')),
  source_id       bigint not null,
  product_id      bigint not null,
  product_name    text,
  kind            text,
  woo_status      text,
  email           text,
  billing_name    text,
  student_id      text,
  start_date      date,
  computed_until  date,
  previous_until  date,
  final_until     date,
  result          text   not null,
  needs_admin     boolean not null default false,
  note            text,
  applied_at      timestamptz,
  resolved_at     timestamptz,
  resolved_by     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (source_type, source_id, product_id)
);

create index if not exists idx_woo_plan_events_alerts
  on public.woo_plan_events (created_at desc)
  where needs_admin and resolved_at is null;

-- Solo el servidor (service role) la lee y la escribe, igual que student_programs.
alter table public.woo_plan_events enable row level security;
revoke all on public.woo_plan_events from anon, authenticated;
grant select, insert, update, delete on public.woo_plan_events to service_role;

-- Comprobación
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'students' and column_name = 'woo_product_id') as columna_woo_product_id,
  (select relrowsecurity from pg_class where relname = 'woo_plan_events') as rls_woo_plan_events;
