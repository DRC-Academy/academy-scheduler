-- Motivo escrito por el admin al "Pagar igualmente" una clase retenida
-- (excede el cupo del plan o la 3.ª clase perdida del mes). 02/11/2026.
--
-- Quién y cuándo ya se guardaban (approved_by / approved_at). Sin esta columna
-- la app sigue funcionando: guarda el motivo dentro de `reason` como
-- "excede_limite_aprobado: <motivo>" y lo separa al leer (lib/db.ts).
--
-- Reversión: ALTER TABLE finance_manual_approvals DROP COLUMN note;

ALTER TABLE finance_manual_approvals ADD COLUMN IF NOT EXISTS note text;
