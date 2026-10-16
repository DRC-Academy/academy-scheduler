'use client';

// Formulario de datos de pago (titular + IBAN). Lo usan la tarjeta del profesor
// (components/PaymentDetailsCard) y el modal de edición del admin
// (components/admin/PaymentDetailsTab). Valida en el navegador con lib/iban para
// avisar al momento; la ruta vuelve a validar antes de guardar.
//
// El IBAN se escribe libre y se agrupa de a 4 al salir del campo (agruparlo en
// cada tecla movía el cursor al corregir un dígito del medio).

import { useState } from 'react';
import { formatIban, validatePaymentDetails, isValidIban, isValidRecipient, IBAN_ERROR, RECIPIENT_ERROR, RECIPIENT_MAX, type PaymentDetailsErrors } from '@/lib/iban';
import { savePaymentDetailsRequest, type PaymentDetails } from '@/lib/paymentDetails';

export function PaymentDetailsForm({ teacherId, initial, admin = false, onSaved, onCancel }: {
  teacherId: string;
  initial: PaymentDetails | null;
  admin?: boolean;
  onSaved: (details: PaymentDetails) => void;
  onCancel?: () => void;
}) {
  const [recipientName, setRecipientName] = useState(initial?.recipientName ?? '');
  const [iban, setIban] = useState(initial ? formatIban(initial.iban) : '');
  const [errors, setErrors] = useState<PaymentDetailsErrors>({});
  const [serverError, setServerError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const v = validatePaymentDetails({ iban, recipientName });
    if (!v.ok) { setErrors(v.errors); return; }
    setSaving(true); setServerError('');
    const r = await savePaymentDetailsRequest({ teacherId, iban: v.iban, recipientName: v.recipientName }, admin);
    setSaving(false);
    if (!r.ok) {
      if (r.fieldErrors) setErrors(r.fieldErrors);
      setServerError(r.fieldErrors ? '' : r.error);
      return;
    }
    onSaved(r.details);
  }

  return (
    <form className="pd-form" onSubmit={submit} noValidate>
      <label className="pd-label" htmlFor={`pd-name-${teacherId}`}>Nombre del destinatario</label>
      <span className="pd-hint">{admin ? 'El titular de la cuenta, tal como figura en el banco.' : 'El titular de la cuenta, tal como figura en tu banco.'}</span>
      <input
        id={`pd-name-${teacherId}`} className="pd-input" type="text" autoComplete="name" maxLength={RECIPIENT_MAX}
        value={recipientName} aria-invalid={!!errors.recipientName}
        onChange={e => { setRecipientName(e.target.value); if (errors.recipientName) setErrors(x => ({ ...x, recipientName: undefined })); }}
        onBlur={() => { if (recipientName.trim() && !isValidRecipient(recipientName)) setErrors(x => ({ ...x, recipientName: RECIPIENT_ERROR })); }}
        placeholder="Nombre y apellidos"
      />
      {errors.recipientName && <span className="pd-err" role="alert">{errors.recipientName}</span>}

      <label className="pd-label" htmlFor={`pd-iban-${teacherId}`}>IBAN</label>
      <input
        id={`pd-iban-${teacherId}`} className="pd-input pd-mono" type="text" autoComplete="off" spellCheck={false} autoCapitalize="characters"
        maxLength={42} value={iban} aria-invalid={!!errors.iban}
        onChange={e => { setIban(e.target.value.toUpperCase()); if (errors.iban) setErrors(x => ({ ...x, iban: undefined })); }}
        onBlur={() => {
          if (!iban.trim()) return;
          setIban(formatIban(iban));
          if (!isValidIban(iban)) setErrors(x => ({ ...x, iban: IBAN_ERROR }));
        }}
        placeholder="ES12 3456 7890 1234 5678 9012"
      />
      {errors.iban && <span className="pd-err" role="alert">{errors.iban}</span>}

      {serverError && <div className="pd-server-err" role="alert">{serverError}</div>}

      <div className="pd-actions">
        {onCancel && <button type="button" className="pd-btn pd-btn-ghost" onClick={onCancel} disabled={saving}>Cancelar</button>}
        <button type="submit" className="pd-btn pd-btn-primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
      </div>
      <style>{PD_FORM_STYLES}</style>
    </form>
  );
}

// Clases pd-*: compartidas por la tarjeta del profe y la vista del admin.
export const PD_FORM_STYLES = `
.pd-form { display: flex; flex-direction: column; gap: 6px; font-family: var(--font-app); }
.pd-label { font-size: 13px; font-weight: 600; color: #1a1c1a; margin-top: 8px; }
.pd-hint { font-size: 12.5px; color: #6E6E66; margin-top: -2px; }
.pd-input { width: 100%; box-sizing: border-box; min-height: 44px; padding: 10px 12px; border: 1.5px solid #E0E0DA; border-radius: 10px; background: #fff; font-family: inherit; font-size: 15px; color: #1a1c1a; }
.pd-input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
.pd-input[aria-invalid="true"] { border-color: #C81E1E; }
.pd-mono { font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
.pd-err { font-size: 12.5px; color: #C81E1E; }
.pd-server-err { background: #FDECEC; color: #C81E1E; border: 1px solid rgba(200,30,30,0.3); border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-top: 6px; }
.pd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.pd-btn { min-height: 40px; padding: 0 18px; border-radius: 10px; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.pd-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.pd-btn-primary { border: none; background: #1E9E3A; color: #fff; }
.pd-btn-primary:hover:not(:disabled) { background: #167A2D; }
.pd-btn-ghost { border: 1px solid #E0E0DA; background: #fff; color: #4A4A4A; }
.pd-btn-ghost:hover:not(:disabled) { background: #F7F7F5; color: #1a1c1a; }
`;
