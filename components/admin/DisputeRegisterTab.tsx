'use client';
// ── Pestaña admin "Registro para disputas" ────────────────────────────────────
//
// Todas las clases del rango con su estado, filtrables, y el PDF de lo filtrado
// para una disputa de Stripe ("no recibí las clases"). Las filas las arma el
// SERVIDOR (/api/admin/registros, lib/classRegister): aquí solo se pintan.
//
// La pantalla lo enseña TODO, incluidas "Sin registro" y "Posible ausencia del
// profe (sin confirmar)"; el PDF no lleva esas dos (lib/classRegister.pdfRows).
//
// Las dos rutas exigen la sesión de admin del servidor (lib/adminSession). Si
// responde 401, adminFetch la reabre una vez con el usuario ya logueado.

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { adminFetch } from '@/lib/adminSessionClient';
import {
  REGISTER_STATUS_LABEL, REGISTER_STATUSES, NOT_IN_PDF, SCHEDULE_HISTORY_START, dmy, joinedLabel,
  type RegisterRow, type RegisterStatus,
} from '@/lib/classRegister';
import { getSpainParts } from '@/lib/spainTime';

interface RegisterResponse {
  rows: RegisterRow[];
  profes: Array<{ id: string; name: string }>;
  alumnos: string[];
  alumno: { name: string; email: string | null; teachers: string[] } | null;
  horarioAproximado: boolean;
  filtro: { desde: string; hasta: string };
}

/** Filas que se pintan de una vez (el recuento y el PDF cubren todas). */
const PAGINA = 200;

const TONO: Record<RegisterStatus, { color: string; bg: string }> = {
  realizada:              { color: '#067647', bg: '#ecfdf3' },
  recuperada:             { color: '#067647', bg: '#ecfdf3' },
  reprogramada:           { color: '#475467', bg: '#f2f4f7' },
  cancelada_alumno_aviso: { color: '#475467', bg: '#f2f4f7' },
  cancelada_alumno_tarde: { color: '#175cd3', bg: '#eff4ff' },
  alumno_no_conecto:      { color: '#175cd3', bg: '#eff4ff' },
  cancelada_profesor:     { color: '#b54708', bg: '#fffaeb' },
  profesor_no_conecto:    { color: '#b42318', bg: '#fef3f2' },
  posible_ausencia:       { color: '#b54708', bg: '#fffaeb' },
  sin_registro:           { color: '#667085', bg: '#f9fafb' },
};

export default function DisputeRegisterTab() {
  const { user } = useAuth();
  const creds = useMemo(() => (user ? { username: user.username, password: user.password } : null), [user]);
  const hoy = getSpainParts(new Date()).dateStr;

  const [desde, setDesde] = useState(`${hoy.slice(0, 7)}-01`);
  const [hasta, setHasta] = useState(hoy);
  const [alumno, setAlumno] = useState('');
  const [profe, setProfe] = useState('');
  const [estado, setEstado] = useState<'' | RegisterStatus>('');
  // Resultado de la ÚLTIMA consulta pedida: mientras su `query` no coincide con
  // la actual, está cargando. El estado solo se toca al llegar la respuesta.
  const [result, setResult] = useState<{ query: string; data: RegisterResponse | null; error: string } | null>(null);
  const [pdfError, setPdfError] = useState('');
  // Cuántas filas se ven, ligado a la consulta: un filtro nuevo vuelve a la primera página.
  const [limite, setLimite] = useState({ query: '', n: PAGINA });
  const [bajando, setBajando] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams({ desde, hasta });
    if (alumno) q.set('alumno', alumno);
    if (profe) q.set('profe', profe);
    if (estado) q.set('estado', estado);
    return q.toString();
  }, [desde, hasta, alumno, profe, estado]);

  useEffect(() => {
    let vivo = true;
    adminFetch(`/api/admin/registros?${query}`, { cache: 'no-store' }, creds)
      .then(async res => {
        const d = await res.json().catch(() => ({}));
        if (!vivo) return;
        if (res.ok) setResult({ query, data: d as RegisterResponse, error: '' });
        else setResult({ query, data: null, error: res.status === 401 ? 'Tu sesión de admin caducó. Cierra sesión y vuelve a entrar.' : d.error ?? 'No se pudo cargar el registro.' });
      })
      .catch(() => { if (vivo) setResult({ query, data: null, error: 'No se pudo conectar con el servidor.' }); });
    return () => { vivo = false; };
  }, [query, creds]);

  const loading = result?.query !== query;
  // Mientras carga la consulta nueva se sigue viendo la anterior.
  const data = result?.data ?? null;
  const error = pdfError || (loading ? '' : result?.error ?? '');

  async function descargar() {
    setBajando(true);
    setPdfError('');
    try {
      const res = await adminFetch(`/api/admin/registros/pdf?${query}`, { cache: 'no-store' }, creds);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setPdfError(d.error ?? 'No se pudo generar el PDF.');
      } else {
        const blob = await res.blob();
        const nombre = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'registro.pdf';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombre;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch {
      setPdfError('No se pudo conectar con el servidor.');
    }
    setBajando(false);
  }

  const rows = data?.rows ?? [];
  const visibles = limite.query === query ? limite.n : PAGINA;
  const enPdf = rows.filter(r => !NOT_IN_PDF.has(r.status)).length;
  const fuera = rows.length - enPdf;

  return (
    <div className="rd">
      <style>{CSS}</style>
      <div className="rd-head">
        <div>
          <h2 className="rd-title">Registro para disputas</h2>
          <p className="rd-sub">Todas las clases con su estado, para responder a una disputa de pago. El PDF descarga exactamente lo filtrado.</p>
        </div>
        <button className="rd-pdf" onClick={descargar} disabled={bajando || loading || !data}>
          {bajando ? 'Generando…' : 'Descargar PDF'}
        </button>
      </div>

      <div className="rd-filtros">
        <label>Desde<input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" value={hasta} min={desde} max={hoy} onChange={e => setHasta(e.target.value)} /></label>
        <label>Alumno
          <select value={alumno} onChange={e => setAlumno(e.target.value)}>
            <option value="">Todos</option>
            {(data?.alumnos ?? []).map(a => <option key={a} value={a}>{a}</option>)}
            {alumno && !(data?.alumnos ?? []).includes(alumno) && <option value={alumno}>{alumno}</option>}
          </select>
        </label>
        <label>Profe
          <select value={profe} onChange={e => setProfe(e.target.value)}>
            <option value="">Todos</option>
            {(data?.profes ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Estado
          <select value={estado} onChange={e => setEstado(e.target.value as '' | RegisterStatus)}>
            <option value="">Todos</option>
            {REGISTER_STATUSES.map(s => <option key={s} value={s}>{REGISTER_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
      </div>

      {data?.horarioAproximado && (
        <div className="rd-aviso">
          El rango empieza antes del {dmy(SCHEDULE_HISTORY_START)}: para esas fechas no hay historial de horarios y el calendario
          se proyecta con el horario actual, así que las filas «Sin registro» de esos días son aproximadas.
        </div>
      )}
      {error && <div className="rd-error" role="alert">{error}</div>}

      {data && data.alumno && (
        <div className="rd-alumno">
          <b>{data.alumno.name}</b> · {data.alumno.email ?? 'sin email'} · Profe: {data.alumno.teachers.join(', ') || '—'}
        </div>
      )}

      {data && (
        <div className="rd-cuenta">
          {loading && <span className="rd-cargando">Cargando… </span>}
          {rows.length} clase{rows.length === 1 ? '' : 's'}
          {fuera > 0 && <> · <b>{enPdf}</b> irán al PDF (no se incluyen «Sin registro» ni «Posible ausencia del profe»)</>}
        </div>
      )}

      {loading && !data ? (
        <div className="rd-vacio">Cargando…</div>
      ) : rows.length === 0 && data ? (
        <div className="rd-vacio">No hay clases con estos filtros.</div>
      ) : (
        <table className="rd-tabla">
          <thead>
            <tr>
              <th>Fecha</th><th>Hora programada</th><th>Alumno</th><th>Profe</th><th>Estado</th>
              <th>Ingreso del profe</th><th>IP del ingreso</th><th>Transcripción</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, visibles).map(r => (
              <tr key={r.id} className={NOT_IN_PDF.has(r.status) ? 'is-fuera' : undefined}>
                <td data-l="Fecha">{dmy(r.date)}</td>
                <td data-l="Hora">{r.hoursLabel}</td>
                <td data-l="Alumno">{r.studentName}</td>
                <td data-l="Profe">{r.teacherName}</td>
                <td data-l="Estado">
                  <span className="rd-pill" style={TONO[r.status]}>
                    {REGISTER_STATUS_LABEL[r.status]}{r.rescheduledTo ? ` al ${dmy(r.rescheduledTo)}` : ''}
                  </span>
                </td>
                <td data-l="Ingreso">{joinedLabel(r.joinedAt, r.date) || '—'}</td>
                <td data-l="IP">{r.ip || '—'}</td>
                <td data-l="Transcripción">{r.hasTranscript ? 'Sí' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > visibles && (
        <button className="rd-mas" onClick={() => setLimite({ query, n: visibles + PAGINA })}>
          Mostrar {Math.min(PAGINA, rows.length - visibles)} más ({visibles} de {rows.length})
        </button>
      )}
      <p className="rd-nota">Horas en hora de España. «Ingreso del profe»: clic en «Ingresar a clase». La IP se guarda desde el 22/10/2026.</p>
    </div>
  );
}

const CSS = `
.rd { display: flex; flex-direction: column; gap: 14px; }
.rd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.rd-title { margin: 0; font-size: 22px; font-weight: var(--fw-semibold, 600); color: var(--text-primary); }
.rd-sub { margin: 4px 0 0; font-size: 13.5px; color: var(--text-secondary); max-width: 640px; }
.rd-pdf { padding: 10px 18px; border-radius: 9px; border: none; background: #1E9E3A; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; font-family: inherit; }
.rd-pdf:disabled { opacity: .6; cursor: not-allowed; }
.rd-filtros { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.rd-filtros label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-secondary); }
.rd-filtros input, .rd-filtros select { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: #fff; font-size: 13.5px; font-family: inherit; color: var(--text-primary); min-width: 0; }
.rd-aviso { font-size: 13px; color: #8a6d00; background: #FFF9E0; border: 1px solid rgba(255,196,0,.55); border-radius: 10px; padding: 10px 14px; }
.rd-error { font-size: 13px; color: #b42318; background: #fef3f2; border-radius: 10px; padding: 10px 14px; }
.rd-alumno { font-size: 13.5px; color: var(--text-primary); }
.rd-cuenta { font-size: 13px; color: var(--text-secondary); }
.rd-vacio { padding: 28px; text-align: center; color: var(--text-muted); font-size: 14px; }
.rd-tabla { width: 100%; border-collapse: collapse; font-size: 13px; }
.rd-tabla th { text-align: left; font-weight: 600; color: var(--text-secondary); font-size: 12px; padding: 8px; border-bottom: 1px solid var(--border); }
.rd-tabla td { padding: 8px; border-bottom: 1px solid var(--border); color: var(--text-primary); vertical-align: top; }
.rd-tabla tr.is-fuera td { color: var(--text-muted); }
.rd-pill { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 12px; font-weight: 600; }
.rd-nota { font-size: 12px; color: var(--text-muted); margin: 0; }
.rd-cargando { color: #b54708; font-weight: 600; }
.rd-mas { align-self: center; padding: 9px 18px; border-radius: 9px; border: 1px solid var(--border); background: #fff; font-size: 13.5px; font-weight: 600; cursor: pointer; font-family: inherit; color: var(--text-primary); }
@media (max-width: 768px) { .rd-title { display: none; } }
@media (max-width: 900px) {
  .rd-filtros { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rd-tabla thead { display: none; }
  .rd-tabla, .rd-tabla tbody, .rd-tabla tr, .rd-tabla td { display: block; width: 100%; }
  .rd-tabla tr { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; }
  .rd-tabla td { border: none; padding: 3px 0; display: flex; gap: 8px; }
  .rd-tabla td::before { content: attr(data-l); color: var(--text-muted); font-size: 12px; min-width: 96px; }
}
`;
