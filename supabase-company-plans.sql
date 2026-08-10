-- ── Planes de EMPRESA con duración automática ────────────────────────────────
--
-- Los productos "Empresas *" de WooCommerce son de PAGO ÚNICO y llevan la
-- duración contratada en el nombre de la variación ("B1 · 1h semanal · 6 Meses").
-- Woo no gestiona vencimiento para un pago único, así que hasta ahora el admin
-- activaba a estos alumnos a mano con `manual_active_until`.
--
-- Estas dos columnas guardan lo DETECTADO en WooCommerce. La fecha de acceso
-- sigue viviendo en `manual_active_until` (que es lo que lee la regla única de
-- "activo" en lib/subscriptionAccess y la pestaña "Próximos a cancelar"): estas
-- solo dicen de dónde salió esa fecha, para que el badge pueda distinguir una
-- activación automática por plan de empresa de una puesta a dedo.
--
-- El fin del plan NO se guarda: es derivable (company_plan_start + N meses) y
-- tener la misma fecha en dos columnas es la forma habitual de que acaben
-- discrepando. Ver lib/productUtils.addCalendarMonths.

ALTER TABLE students ADD COLUMN IF NOT EXISTS company_plan_months int;
ALTER TABLE students ADD COLUMN IF NOT EXISTS company_plan_start  date;

COMMENT ON COLUMN students.company_plan_months IS
  'Duración en meses leída de la variación del producto de empresa en WooCommerce. NULL = no es un plan de empresa con duración detectable.';
COMMENT ON COLUMN students.company_plan_start IS
  'Fecha del pedido de WooCommerce que originó el plan de empresa. El fin = company_plan_start + company_plan_months meses.';
