'use client';

// /finanzas → "Datos de pago": IBAN y titular de TODOS los profesores, para
// poder pagarles. Se monta solo al elegir esa vista, y es lo único que pide
// estos datos (por /api/admin/payment-details, con la service role).
//
// Una fila por profesor no archivado; los que no cargaron nada van primero con
// el badge "Sin datos de pago", y el filtro deja ver solo esos. El admin puede
// editar (o cargar) los datos de cualquiera con el mismo formulario del profe.
// Por debajo de 768 px la fila se vuelve tarjeta; nada se desliza en horizontal.

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatIban } from '@/lib/iban';
import { fetchAllPaymentDetails, updatedAtLabel, type PaymentDetails, type TeacherPaymentRow } from '@/lib/paymentDetails';
import { PaymentDetailsForm } from '@/components/PaymentDetailsForm';

type Filtro = 'todos' | 'faltan';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Sin permiso de portapapeles (o sin HTTPS): el truco del textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

export default function PaymentDetailsTab() {
  const [rows, setRows] = useState<TeacherPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noConfigurado, setNoConfigurado] = useState(false);
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [copiado, setCopiado] = useState<string | null>(null);
  const [editando, setEditando] = useState<TeacherPaymentRow | null>(null);

  const apply = useCallback((r: Awaited<ReturnType<typeof fetchAllPaymentDetails>>) => {
    if (r.ok) { setRows(r.value); setError(''); setNoConfigurado(false); }
    else if (r.noConfigurado) setNoConfigurado(true);
    else setError(r.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAllPaymentDetails().then(r => { if (!cancelled) apply(r); });
    return () => { cancelled = true; };
  }, [apply]);

  async function load() {
    setLoading(true); setError('');
    apply(await fetchAllPaymentDetails());
  }

  useEffect(() => {
    if (!copiado) return;
    const t = setTimeout(() => setCopiado(null), 2000);
    return () => clearTimeout(t);
  }, [copiado]);

  async function copiar(teacherId: string, iban: string) {
    if (await copyText(iban)) setCopiado(teacherId);
  }

  function guardado(teacherId: string, details: PaymentDetails) {
    setRows(rs => rs.map(r => (r.teacherId === teacherId ? { ...r, details } : r)));
    setEditando(null);
  }

  const faltan = rows.filter(r => !r.details).length;
  const visibles = filtro === 'faltan' ? rows.filter(r => !r.details) : rows;

  return (
    <div className="adm-card pdt">
      <div className="pdt-lh">
        <div className="fz-chips" role="group" aria-label="Filtrar">
          <button type="button" className="fz-chip" aria-pressed={filtro === 'todos'} onClick={() => setFiltro('todos')}>Todos<span className="n">{rows.length}</span></button>
          <button type="button" className="fz-chip" aria-pressed={filtro === 'faltan'} onClick={() => setFiltro('faltan')}>Sin datos de pago<span className="n">{faltan}</span></button>
        </div>
        <span className="pdt-nota">Copiar pega el IBAN sin espacios, listo para el banco.</span>
      </div>

      {loading && rows.length === 0 && !error ? (
        <div className="pdt-vacio">Cargando…</div>
      ) : noConfigurado ? (
        <div className="pdt-vacio">Falta correr <b>supabase-teacher-payment-details.sql</b> en Supabase.</div>
      ) : error ? (
        <div className="pdt-vacio">
          <span style={{ color: '#C81E1E' }}>{error}</span>{' '}
          <button type="button" className="pdt-link" onClick={load}>Reintentar</button>
        </div>
      ) : visibles.length === 0 ? (
        <div className="pdt-vacio">{filtro === 'faltan' ? 'Todos los profesores cargaron sus datos de pago.' : 'No hay profesores.'}</div>
      ) : (
        <>
          <div className="pdt-row head" aria-hidden><span>Profesor</span><span>Destinatario</span><span>IBAN</span><span>Última actualización</span><span /></div>
          {visibles.map(r => (
            <div key={r.teacherId} className={`pdt-row${r.details ? '' : ' falta'}`}>
              <span className="pdt-nom">{r.teacherName}</span>
              {r.details ? (
                <>
                  <span className="pdt-dest"><span className="pdt-ml">Destinatario</span>{r.details.recipientName}</span>
                  <span className="pdt-iban">
                    <span className="pdt-ml">IBAN</span>
                    <span className="pdt-iban-v">{formatIban(r.details.iban)}</span>
                    <button type="button" className="pdt-copy" onClick={() => copiar(r.teacherId, r.details!.iban)} aria-label={`Copiar el IBAN de ${r.teacherName}`}>
                      {copiado === r.teacherId ? <><Check size={14} strokeWidth={3} aria-hidden /> Copiado</> : <><Copy size={14} aria-hidden /> Copiar</>}
                    </button>
                  </span>
                  <span className="pdt-fecha"><span className="pdt-ml">Última actualización</span>{updatedAtLabel(r.details.updatedAt)}</span>
                </>
              ) : (
                <>
                  <span className="pdt-dest"><span className="pdt-badge">Sin datos de pago</span></span>
                  <span className="pdt-iban pdt-cero">—</span>
                  <span className="pdt-fecha pdt-cero">—</span>
                </>
              )}
              <span className="pdt-acc">
                <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setEditando(r)}>{r.details ? 'Editar' : 'Añadir'}</button>
              </span>
            </div>
          ))}
        </>
      )}

      {editando && (
        <div className="pdt-scrim" onClick={e => { if (e.target === e.currentTarget) setEditando(null); }}>
          <div className="pdt-mod" role="dialog" aria-label={`Datos de pago de ${editando.teacherName}`}>
            <div className="pdt-mod-t">Datos de pago de {editando.teacherName}</div>
            {editando.details && <p className="pdt-mod-s">Última actualización: {updatedAtLabel(editando.details.updatedAt)}</p>}
            <PaymentDetailsForm
              teacherId={editando.teacherId}
              initial={editando.details}
              admin
              onSaved={d => guardado(editando.teacherId, d)}
              onCancel={() => setEditando(null)}
            />
          </div>
        </div>
      )}
      <style>{ESTILOS}</style>
    </div>
  );
}

const ESTILOS = `
.pdt { overflow: clip; font-family: var(--font-app); }
.pdt-lh { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #E0E0DA; flex-wrap: wrap; }
.pdt-nota { margin-left: auto; font-size: 12.5px; color: #6E6E66; }
.pdt-vacio { padding: 32px 16px; text-align: center; font-size: 13.5px; color: #6E6E66; }
.pdt-link { background: none; border: 0; padding: 0; min-height: 0; color: #2563eb; font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; }
.pdt-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1.9fr) minmax(0, 1fr) 96px; align-items: center; gap: 12px; min-height: 56px; padding: 6px 16px; border-top: 1px solid #ECECE8; font-size: 13.5px; color: #1a1c1a; }
.pdt-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; }
.pdt-row.falta { background: #FFFCF0; }
.pdt-nom { font-weight: 600; font-size: 14.5px; min-width: 0; overflow-wrap: anywhere; }
.pdt-dest { min-width: 0; overflow-wrap: anywhere; }
.pdt-iban { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.pdt-iban-v { font-variant-numeric: tabular-nums; letter-spacing: 0.03em; overflow-wrap: anywhere; }
.pdt-copy { display: inline-flex; align-items: center; gap: 4px; min-height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid #E0E0DA; background: #fff; font-family: inherit; font-size: 12.5px; font-weight: 600; color: #2563eb; cursor: pointer; white-space: nowrap; }
.pdt-copy:hover { background: #EFF4FF; }
.pdt-fecha { color: #4A4A4A; font-size: 12.5px; }
.pdt-cero { color: #a4a7a1; }
.pdt-acc { text-align: right; }
.pdt-badge { display: inline-block; background: #FFC400; color: #1a1c1a; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.pdt-ml { display: none; }
.pdt-scrim { position: fixed; inset: 0; background: rgba(20,22,20,0.45); display: grid; place-items: center; padding: 16px; z-index: 1000; }
.pdt-mod { background: #fff; border-radius: 14px; padding: 20px 22px; width: min(460px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; box-shadow: 0 12px 40px rgba(0,0,0,0.18); }
.pdt-mod-t { font-size: 17px; font-weight: 700; color: #1a1c1a; }
.pdt-mod-s { font-size: 12.5px; color: #6E6E66; margin: 4px 0 0; }
@media (max-width: 767px) {
  .pdt-nota { margin-left: 0; }
  .pdt-row.head { display: none; }
  .pdt-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "nom acc" "dest dest" "iban iban" "fecha fecha"; gap: 6px 12px; padding: 12px 16px; }
  .pdt-nom { grid-area: nom; } .pdt-acc { grid-area: acc; } .pdt-dest { grid-area: dest; } .pdt-iban { grid-area: iban; } .pdt-fecha { grid-area: fecha; }
  .pdt-row.falta .pdt-iban, .pdt-row.falta .pdt-fecha { display: none; }
  .pdt-ml { display: block; width: 100%; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; margin-bottom: 1px; }
}
`;
