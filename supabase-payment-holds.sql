-- supabase-payment-holds.sql — alumnos con pago fallido (on-hold de WooCommerce)
-- Corrido en Supabase el 26/10/2026. Ver lib/paymentHolds.ts y lib/paymentHoldStore.ts.

create table if not exists public.student_payment_holds (
  id                  text primary key,                 -- 'hold_<student_id>_<epoch>'
  student_id          text not null,                    -- sin FK a propósito
  student_email       text not null,
  student_name        text not null,
  started_at          timestamptz not null,
  ended_at            timestamptz,                      -- null = sigue en on-hold
  start_source        text not null check (start_source in
                        ('webhook','barrido','verificacion','inicial_nota','inicial_pedido','inicial_hoy')),
  end_source          text check (end_source in ('webhook','barrido','verificacion','admin')),
  end_status          text,                             -- estado con el que salió (active, cancelled…)
  woo_subscription_id bigint,
  is_initial          boolean not null default false,   -- ya estaba en on-hold al activar: sin emails
  created_at          timestamptz not null default now(),
  constraint student_payment_holds_rango check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists student_payment_holds_una_abierta
  on public.student_payment_holds (student_id) where ended_at is null;
create index if not exists student_payment_holds_alumno
  on public.student_payment_holds (student_id, started_at desc);

alter table public.student_payment_holds enable row level security;
drop policy if exists "holds_lectura" on public.student_payment_holds;
create policy "holds_lectura" on public.student_payment_holds
  for select to anon, authenticated using (true);      -- solo lectura; escribe el servidor

create table if not exists public.payment_hold_notices (
  id            text primary key,                       -- '<hold_id>|<teacher_id>|<kind>' = anti-duplicado
  hold_id       text not null references public.student_payment_holds(id) on delete cascade,
  student_id    text not null,
  student_name  text not null,
  teacher_id    text not null,
  teacher_name  text not null,
  assignment_id text,                                   -- assignments.id es TEXT
  kind          text not null check (kind in ('suspendido','reactivado')),
  sent_to       text,
  email_status  text not null default 'pendiente' check (email_status in ('pendiente','enviado','fallido','omitido')),
  attempts      int not null default 0,
  email_error   text,
  bell_id       text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index if not exists payment_hold_notices_alumno
  on public.payment_hold_notices (student_id, created_at desc);
alter table public.payment_hold_notices enable row level security;  -- sin políticas: solo service role
