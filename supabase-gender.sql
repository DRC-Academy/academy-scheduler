-- ─────────────────────────────────────────────────────────────────────────────
-- Género para copys de email personalizados ("Estimado" / "Estimada",
-- "bienvenido" / "bienvenida", "profesor" / "profesora").
--
-- Columna OPCIONAL: null = desconocido. La app detecta el género por el nombre
-- cuando la columna está vacía (ver lib/gender.ts), así que este dato solo hace
-- falta para forzar/overridear la detección automática.
--
-- Idempotente: se puede correr varias veces sin error.
-- ─────────────────────────────────────────────────────────────────────────────

alter table if exists public.students
  add column if not exists gender text
  check (gender is null or gender in ('male', 'female'));

alter table if exists public.teachers
  add column if not exists gender text
  check (gender is null or gender in ('male', 'female'));
