-- ── El ancla de inicio deja de ser exclusiva de los planes de empresa ────────
--
-- `company_plan_start` nació (supabase-company-plans.sql) como "fecha del pedido
-- que originó el plan de EMPRESA". Desde el 31/08/2026 guarda la fecha del pedido
-- de CUALQUIER producto de pago único, porque es el ancla que necesita
-- `lib/billing.facturacionMensualDe` para repartir el importe mes a mes.
--
-- POR QUÉ. Sin ancla, la ventana se contaba hacia atrás desde
-- `manual_active_until`, que el admin pone CON COLCHÓN. Un colchón que cruza el
-- fin de mes corre la ventana entera un mes hacia adelante: en agosto/2026 Izaro
-- Gaztañaga, Laia Pi y Héctor Guerra facturaron 0 € habiendo dado 20, 18 y 11
-- clases ese mes, y otros ~10 alumnos se comieron julio en silencio.
--
-- La fecha ya venía en la respuesta de WooCommerce que `check-subscription` pide
-- para todos los alumnos (`rich.orderDate`); solo se persistía dentro de la rama
-- de `detectCompanyPlan`. Por eso 24 de 29 alumnos de pago único no tenían ancla.
--
-- NO HAY CAMBIO DE ESQUEMA: las dos columnas ya existen y los tipos no cambian.
-- Este archivo solo corrige los COMMENT, que son la documentación de la tabla y
-- decían algo que ya no es cierto. Correrlo es seguro e idempotente.
--
-- NOMBRE. Se mantiene `company_plan_*` en vez de renombrar a `one_time_*`: el
-- rename obligaría a tocar a la vez la tabla, lib/db, lib/billing,
-- useSubscriptionStatus, los dos endpoints de sync y el endpoint externo, con la
-- base en producción. El comentario corrige el significado sin ese riesgo.

COMMENT ON COLUMN students.company_plan_start IS
  'Fecha del pedido de WooCommerce del producto de PAGO ÚNICO vigente (empresas e intensivos). Ancla de la ventana de facturación en lib/billing. El fin del plan de empresa = company_plan_start + company_plan_months meses.';

COMMENT ON COLUMN students.company_plan_months IS
  'Duración en meses leída de la variación del producto de EMPRESA en WooCommerce. NULL = no es un plan de empresa con duración detectable; para los intensivos la duración la manda billing_months de product_prices. Un alumno puede tener company_plan_start sin company_plan_months.';
