'use client';

// Finanzas del profesor (/mis-clases) → "Datos de pago".
//
// La carga la hace la página (una sola fila, la del profe) porque también decide
// el aviso amarillo de arriba; esta tarjeta solo pinta y guarda. Si la tabla
// todavía no existe (falta el SQL) la página no monta ni el aviso ni la tarjeta.

import { useState } from 'react';
import { formatIban } from '@/lib/iban';
import { updatedAtLabel, type LoadResult, type PaymentDetails } from '@/lib/paymentDetails';
import { PaymentDetailsForm, PD_FORM_STYLES } from '@/components/PaymentDetailsForm';

export const PAYMENT_DETAILS_ANCHOR = 'datos-de-pago';

/** Aviso amarillo de arriba de Finanzas: solo cuando el profe no cargó nada. */
export function PaymentDetailsBanner() {
  return (
    <div className="mcf-card" role="status" style={{ borderLeft: '4px solid #FFC400', background: '#fffdf5', padding: '14px 18px', marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>💳</span>
      <div style={{ flex: 1, minWidth: 180, fontWeight: 700, fontSize: 14, color: '#1a1c1a' }}>
        Añade tus datos de pago para que podamos pagarte
      </div>
      <button
        type="button"
        onClick={() => document.getElementById(PAYMENT_DETAILS_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        style={{ background: '#FFC400', color: '#1a1c1a', border: 'none', borderRadius: 10, padding: '0 16px', minHeight: 40, fontFamily: 'inherit', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
      >
        Añadir ahora
      </button>
    </div>
  );
}

export function PaymentDetailsCard({ teacherId, load, onSaved, onRetry }: {
  teacherId: string;
  /** null mientras carga. */
  load: LoadResult<PaymentDetails | null> | null;
  onSaved: (details: PaymentDetails) => void;
  onRetry: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const details = load?.ok ? load.value : null;
  const showForm = load?.ok && (editing || !details);

  return (
    <section id={PAYMENT_DETAILS_ANCHOR} className="mcf-card mcf-card-pad pd-card" style={{ marginTop: 16, scrollMarginTop: 80 }}>
      <div className="pd-card-head">
        <div>
          <h2 className="pd-card-title">Datos de pago</h2>
          <p className="pd-card-sub">La cuenta donde te transferimos lo que cobras cada mes.</p>
        </div>
        {load?.ok && details && !editing && (
          <button type="button" className="pd-btn pd-btn-ghost" onClick={() => { setEditing(true); setJustSaved(false); }}>Editar</button>
        )}
      </div>

      {load === null && <p className="pd-muted">Cargando…</p>}

      {load && !load.ok && !load.noConfigurado && (
        <div className="pd-server-err" role="alert">
          {load.error}{' '}
          <button type="button" className="pd-link" onClick={onRetry}>Reintentar</button>
        </div>
      )}

      {showForm && (
        <PaymentDetailsForm
          teacherId={teacherId}
          initial={details}
          onSaved={d => { setEditing(false); setJustSaved(true); onSaved(d); }}
          onCancel={details ? () => setEditing(false) : undefined}
        />
      )}

      {load?.ok && details && !editing && (
        <>
          {justSaved && <div className="pd-ok" role="status">✓ Datos guardados. Los usaremos para tu próximo pago.</div>}
          <dl className="pd-dl">
            <div><dt>Destinatario</dt><dd>{details.recipientName}</dd></div>
            <div><dt>IBAN</dt><dd className="pd-mono">{formatIban(details.iban)}</dd></div>
          </dl>
          <p className="pd-muted">Última actualización: {updatedAtLabel(details.updatedAt)}</p>
        </>
      )}
      <style>{PD_FORM_STYLES + PD_CARD_STYLES}</style>
    </section>
  );
}

const PD_CARD_STYLES = `
.pd-card { font-family: var(--font-app); }
.pd-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.pd-card-title { font-size: 16px; font-weight: 700; margin: 0; color: #1a1c1a; }
.pd-card-sub { font-size: 13px; color: #6E6E66; margin: 3px 0 0; }
.pd-muted { font-size: 12.5px; color: #6E6E66; margin: 10px 0 0; }
.pd-ok { background: #EAF5EC; color: #167A2D; border-radius: 10px; padding: 10px 14px; font-size: 13px; font-weight: 600; margin-top: 10px; }
.pd-dl { display: grid; gap: 10px; margin: 12px 0 0; }
.pd-dl > div { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; background: #F7F7F5; border-radius: 10px; }
.pd-dl dt { font-size: 11.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; }
.pd-dl dd { margin: 0; font-size: 15px; color: #1a1c1a; word-break: break-word; }
.pd-link { background: none; border: 0; padding: 0; min-height: 0; color: #2563eb; font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; }
`;
