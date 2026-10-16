-- ── Datos de pago de los profesores (IBAN + titular) ─────────────────────────
--
-- Una fila por profesor. La carga el profe en Finanzas → "Datos de pago"
-- (/mis-clases) y el admin la ve y la edita en /finanzas → "Datos de pago".
-- Validación (formato + mod-97) en lib/iban.ts; lectura y escritura en
-- lib/paymentDetailsStore.ts, solo desde /api/payment-details y
-- /api/admin/payment-details.
--
-- CUÁNDO CORRERLO: ANTES de publicar el código. Si el código sale primero, la
-- tarjeta del profesor no se muestra y el admin ve "falta correr el SQL"; no
-- rompe nada más.
--
-- Idempotente: se puede correr dos veces sin error.
--
-- Reversible:
--   drop table teacher_payment_details;

CREATE TABLE IF NOT EXISTS teacher_payment_details (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- teachers.id es text ('t1', 't2'…). Los profesores se archivan, no se
  -- borran; si alguna vez se borra uno, sus datos de pago se van con él.
  teacher_id      text NOT NULL UNIQUE REFERENCES teachers(id) ON DELETE CASCADE,
  iban            text NOT NULL,           -- normalizado: sin espacios y en mayúsculas
  recipient_name  text NOT NULL,           -- titular de la cuenta
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Guarda IBANs: RLS ACTIVADO y sin políticas. La anon key del navegador no la
-- puede leer ni escribir; solo el servidor con la service role.
ALTER TABLE teacher_payment_details ENABLE ROW LEVEL SECURITY;
