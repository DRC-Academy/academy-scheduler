'use client';
// ── Pestaña "Bonos" del admin ────────────────────────────────────────────────
//
// Una fila por alumno+profesor con su estado (lib/bonuses.buildBonusRows): la
// MISMA lista que ve el profesor en Mi Scoring y que usa Seguimiento, así el
// "disponible" no puede diferir entre pantallas.
//
// Una sola acción: "Marcar pagado". Solo se puede pulsar cuando el bono ya
// cumplió (disponible, o reclamado por el profesor); mientras no cumpla, el
// botón está deshabilitado y dice cuántos días faltan. Al marcarlo, el bono
// entra en la liquidación del mes en curso (o del siguiente si Finanzas ya
// cerró el mes) y el profesor lo ve como pagado. "Pagado" es uno solo: los
// históricos que se pagaron por email antes de la app se ven igual.
//
// Además: "con el profe desde" (teacher_since) es editable con el lápiz, porque
// la semilla asumió que nadie cambió de profesor; y "Cargar upsell" crea filas
// ya pagadas (el profesor no reclama upsells).
//
// Mismo lenguaje visual que Finanzas (clases fz-* → acá bz-*). En el teléfono
// cada fila es una tarjeta; nada se desliza en horizontal.

import { useMemo, useState } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import {
  buildBonusRows, bonusCounters, bonusEurosFor, bonusIsPayable, accrualMonthFor, BONUS_STATE_LABEL,
  type BonusRow, type BonusRowState,
} from '@/lib/bonuses';
import { normName, spainTodayIso, isActiveAssignmentLike } from '@/lib/retention';
import { BonusAlreadyExistsError } from '@/lib/db';

// ─── Utilidades ──────────────────────────────────────────────────────────────

function fecha(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function eur(n: number): string {
  return `${Math.round(n)} €`;
}
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function mesLargo(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  return `${MESES[(m ?? 1) - 1]} ${y}`;
}

/** Los filtros. "Todos" es lo que ya es un bono; lo que aún no cumplió va aparte en "En curso". */
type Filtro = 'todos' | 'disponible' | 'reclamado' | 'pagado' | 'en_curso';
const FILTROS: Array<{ id: Filtro; label: string }> = [
  { id: 'todos', label: 'Todos' },
  { id: 'disponible', label: 'Disponibles' },
  { id: 'reclamado', label: 'Reclamados' },
  { id: 'pagado', label: 'Pagados' },
  { id: 'en_curso', label: 'En curso' },
];
const ES_PAGADO = new Set<BonusRowState>(['pagado', 'pagado_externo', 'aprobado']);
const ES_EN_CURSO = new Set<BonusRowState>(['en_curso', 'proximo']);
function pasaFiltro(r: BonusRow, f: Filtro): boolean {
  if (f === 'todos') return !ES_EN_CURSO.has(r.estado);
  if (f === 'pagado') return ES_PAGADO.has(r.estado);
  if (f === 'en_curso') return ES_EN_CURSO.has(r.estado);
  return r.estado === f;
}

const PILL: Record<BonusRowState, string> = {
  reclamado: 'ambar', disponible: 'verde', proximo: 'gris', en_curso: 'gris',
  aprobado: 'gris', pagado: 'gris', pagado_externo: 'gris', rechazado: 'rojo',
};

// ─── Componente ──────────────────────────────────────────────────────────────

export default function BonusesTab() {
  const {
    teachers, assignments, teacherBonuses, financePayments,
    markBonusPaid, addUpsellBonuses, updateAssignmentTeacherSince, loadTeacherBonuses,
  } = useTeachers();
  const { user } = useAuth();
  const adminName = user?.displayName || user?.username || 'admin';

  const [filtro, setFiltro]     = useState<Filtro>('todos');
  const [profe, setProfe]       = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [busy, setBusy]         = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [aviso, setAviso]       = useState<string | null>(null);
  const [aPagar, setAPagar]     = useState<BonusRow | null>(null);
  const [upsellOpen, setUpsellOpen] = useState(false);
  const [editSince, setEditSince]   = useState<{ key: string; value: string } | null>(null);

  // Lista global (sin cuentas de prueba): de acá salen las cifras. Con un
  // profesor elegido se pide SU lista, que sí incluye a t1/t2 para poder probar.
  const rowsGlobal = useMemo(
    () => buildBonusRows({ assignments, bonuses: teacherBonuses, teachers }),
    [assignments, teacherBonuses, teachers],
  );
  const rows = useMemo(
    () => (profe ? buildBonusRows({ assignments, bonuses: teacherBonuses, teachers, teacherId: profe }) : rowsGlobal),
    [assignments, teacherBonuses, teachers, profe, rowsGlobal],
  );
  const cifras = bonusCounters(rowsGlobal);

  const q = normName(busqueda);
  const visibles = rows.filter(r =>
    pasaFiltro(r, filtro) && (!q || normName(r.studentName).includes(q) || normName(r.teacherName).includes(q)));

  // Profesores del desplegable: los vigentes más los que tengan bonos (archivados).
  const conBonos = new Set(teacherBonuses.map(b => b.teacherId));
  const profesores = teachers
    .filter(t => !t.archivedAt || conBonos.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  /** Mes de liquidación en que entraría un bono marcado ahora para ese profesor. */
  function mesLiquidacion(teacherId: string): string {
    const mes = accrualMonthFor(null);
    return accrualMonthFor(financePayments.find(p => p.teacherId === teacherId && p.monthYear === mes) ?? null);
  }

  async function correr(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setError(null); setAviso(null);
    try { await fn(); }
    catch (err) {
      setError(err instanceof BonusAlreadyExistsError
        ? `${err.message} Recargá la lista.`
        : err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally { setBusy(null); }
  }

  async function confirmarPago() {
    if (!aPagar) return;
    const r = aPagar;
    setAPagar(null);
    await correr(r.key, async () => {
      await markBonusPaid(r, adminName);
      setAviso(`Bono de ${r.studentName} (${r.teacherName}) marcado como pagado: entra en la liquidación de ${mesLargo(mesLiquidacion(r.teacherId))}.`);
    });
  }

  async function guardarSince(r: BonusRow) {
    if (!editSince || !r.assignment) return;
    const value = editSince.value;
    setEditSince(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value === r.teacherSince) return;
    await correr(r.key, () => updateAssignmentTeacherSince(r.assignment!.id, value));
  }

  return (
    <div className="bz">
      <style dangerouslySetInnerHTML={{ __html: ESTILOS }} />

      <div className="bz-head">
        <div>
          <h2 className="bz-h1">Bonos</h2>
          <p className="bz-sub">Retención a los 6 meses con el profesor, y upsells. «Marcar pagado» lo suma a la liquidación del mes.</p>
        </div>
        <div className="bz-head-r">
          <button type="button" className="adm-btn adm-btn-ghost" onClick={() => { setError(null); loadTeacherBonuses(); }}>Recargar</button>
          <button type="button" className="adm-btn adm-btn-primary" onClick={() => setUpsellOpen(true)}>Cargar upsell</button>
        </div>
      </div>

      {error && <div className="bz-error">{error}</div>}
      {aviso && <div className="bz-aviso">{aviso}</div>}

      {/* Las tres cifras */}
      <div className="bz-kpis">
        <button type="button" className={`adm-card bz-kpi${filtro === 'reclamado' ? ' is-on' : ''}`} onClick={() => setFiltro(filtro === 'reclamado' ? 'todos' : 'reclamado')}>
          <span className="bz-kpi-l">Reclamados</span>
          <span className="bz-kpi-v" style={{ color: cifras.reclamados > 0 ? '#B45309' : undefined }}>{cifras.reclamados}</span>
          <span className="bz-kpi-def">El profesor ya pidió el bono. Falta marcarlo pagado.</span>
        </button>
        <button type="button" className={`adm-card bz-kpi${filtro === 'en_curso' ? ' is-on' : ''}`} onClick={() => setFiltro(filtro === 'en_curso' ? 'todos' : 'en_curso')}>
          <span className="bz-kpi-l">Próximos a cumplir</span>
          <span className="bz-kpi-v">{cifras.proximos}</span>
          <span className="bz-kpi-def">Cumplen 6 meses con su profesor en los próximos 30 días.</span>
        </button>
        <button type="button" className={`adm-card bz-kpi${filtro === 'disponible' ? ' is-on' : ''}`} onClick={() => setFiltro(filtro === 'disponible' ? 'todos' : 'disponible')}>
          <span className="bz-kpi-l">Disponibles</span>
          <span className="bz-kpi-v" style={{ color: cifras.disponibles > 0 ? '#167A2D' : undefined }}>{cifras.disponibles}</span>
          <span className="bz-kpi-def">Ya cumplieron y todavía no se pagaron.</span>
        </button>
      </div>

      {/* Filtros */}
      <div className="bz-filtros">
        <div className="bz-chips" role="group" aria-label="Estado">
          {FILTROS.map(f => (
            <button key={f.id} type="button" className="bz-chip" aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>
              {f.label} <span className="n">{rows.filter(r => pasaFiltro(r, f.id)).length}</span>
            </button>
          ))}
        </div>
        <div className="bz-filtros-r">
          <select className="bz-sel" value={profe} onChange={e => setProfe(e.target.value)} aria-label="Profesor">
            <option value="">Todos los profesores</option>
            {profesores.map(t => <option key={t.id} value={t.id}>{t.name}{t.archivedAt ? ' (archivado)' : ''}</option>)}
          </select>
          <input className="bz-in" type="search" placeholder="Buscar alumno o profesor" value={busqueda} onChange={e => setBusqueda(e.target.value)} aria-label="Buscar" />
        </div>
      </div>

      {/* Tabla */}
      <div className="adm-card bz-tabla">
        <div className="bz-row head" aria-hidden>
          <span>Alumno</span><span>Profesor</span><span>Tipo</span><span>Importe</span>
          <span>Con el profe desde</span><span>Cumple el</span><span>Estado</span><span>Acciones</span>
        </div>
        {visibles.length === 0 && (
          <div className="bz-vacio">Nada que mostrar con estos filtros.</div>
        )}
        {visibles.map(r => {
          const ocupado = busy === r.key;
          const pagable = bonusIsPayable(r.estado);
          const pagado = ES_PAGADO.has(r.estado);
          const editandoSince = editSince?.key === r.key;
          const faltan = r.daysLeft !== null && r.daysLeft > 0 ? r.daysLeft : null;
          return (
            <div key={r.key} className={`bz-row is-${r.estado}${ocupado ? ' is-busy' : ''}`}>
              <span className="bz-nom">
                <b>{r.studentName}</b>
                {r.bonus?.note && <small className="bz-nota">{r.bonus.note}</small>}
              </span>

              {/* En escritorio son tres columnas (display: contents); en el teléfono, una línea. */}
              <span className="bz-meta">
                <span className="bz-prof">{r.teacherName}</span>
                <span className="bz-tipo">{r.bonusType === 'upsell' ? 'Upsell' : 'Retención 6 m'}</span>
                <span className="bz-imp">{eur(r.euros)}</span>
              </span>

              <span className="bz-since">
                {r.assignment ? (
                  editandoSince ? (
                    <input
                      className="bz-in bz-in-inline" type="date" autoFocus value={editSince.value}
                      onChange={e => setEditSince({ key: r.key, value: e.target.value })}
                      onBlur={() => guardarSince(r)}
                      onKeyDown={e => { if (e.key === 'Enter') guardarSince(r); if (e.key === 'Escape') setEditSince(null); }}
                      aria-label="Con el profesor desde"
                    />
                  ) : (
                    <>
                      {fecha(r.teacherSince)}
                      {!pagado && (
                        <button type="button" className="bz-lapiz" title="Corregir desde cuándo está con este profesor" onClick={() => setEditSince({ key: r.key, value: r.teacherSince ?? spainTodayIso() })}>✎</button>
                      )}
                    </>
                  )
                ) : <span className="bz-muted">{r.teacherSince ? fecha(r.teacherSince) : 'sin asignación'}</span>}
              </span>

              <span className="bz-due">
                {r.dueDate ? (
                  <>
                    {fecha(r.dueDate)}
                    {faltan !== null && !pagado && <small className="bz-nota">faltan {faltan} día{faltan === 1 ? '' : 's'}</small>}
                  </>
                ) : <span className="bz-muted">—</span>}
              </span>

              <span className="bz-est">
                <span className={`bz-pill ${PILL[r.estado]}`}>{BONUS_STATE_LABEL[r.estado]}</span>
                {pagado && r.bonus?.paidMonth && <small className="bz-nota">{mesLargo(r.bonus.paidMonth)}</small>}
                {r.estado === 'reclamado' && r.bonus?.claimedAt && <small className="bz-nota">reclamado el {fecha(r.bonus.claimedAt)}</small>}
              </span>

              <span className="bz-act">
                {!pagado && (
                  <button
                    type="button" className="adm-btn bz-btn-ok" disabled={!pagable || ocupado}
                    title={pagable ? `Entra en la liquidación de ${mesLargo(mesLiquidacion(r.teacherId))}` : faltan !== null ? `Todavía no cumplió los 6 meses: faltan ${faltan} días` : 'Todavía no se puede pagar'}
                    onClick={() => setAPagar(r)}
                  >
                    {ocupado ? '…' : 'Marcar pagado'}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {aPagar && (
        <Modal onClose={() => setAPagar(null)}>
          <div className="bz-mod-t">Marcar pagado el bono de {aPagar.studentName}</div>
          <p className="bz-mod-s">
            {aPagar.bonusType === 'upsell' ? 'Upsell' : 'Bono de retención'} de <b>{eur(aPagar.euros)}</b> para <b>{aPagar.teacherName}</b>.
            Entra en la liquidación de <b>{mesLargo(mesLiquidacion(aPagar.teacherId))}</b> y el profesor lo ve como pagado.
          </p>
          <div className="bz-mod-b">
            <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setAPagar(null)}>Cancelar</button>
            <button type="button" className="adm-btn adm-btn-primary" onClick={confirmarPago}>Marcar pagado</button>
          </div>
        </Modal>
      )}
      {upsellOpen && (
        <UpsellModal
          mesDe={mesLiquidacion}
          onClose={() => setUpsellOpen(false)}
          onConfirm={async p => {
            setUpsellOpen(false);
            await correr('upsell', async () => {
              await addUpsellBonuses({ ...p, paidBy: adminName });
              setAviso(`${p.quantity} upsell${p.quantity === 1 ? '' : 's'} de ${p.studentName} cargado${p.quantity === 1 ? '' : 's'} (${eur(bonusEurosFor('upsell') * p.quantity)}) en la liquidación de ${mesLargo(mesLiquidacion(p.teacherId))}.`);
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Modales ─────────────────────────────────────────────────────────────────

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="bz-scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bz-mod" role="dialog">{children}</div>
    </div>
  );
}

function UpsellModal({ mesDe, onClose, onConfirm }: {
  mesDe: (teacherId: string) => string;
  onClose: () => void;
  onConfirm: (p: { teacherId: string; assignmentId: string | null; studentName: string; quantity: number; note?: string }) => void;
}) {
  const { teachers, assignments } = useTeachers();
  const [teacherId, setTeacherId] = useState('');
  const [asgId, setAsgId]         = useState('');
  const [cantidad, setCantidad]   = useState(1);
  const [nota, setNota]           = useState('');

  const profes = teachers.filter(t => !t.archivedAt).sort((a, b) => a.name.localeCompare(b.name));
  const alumnos = assignments
    .filter(a => a.teacherId === teacherId && isActiveAssignmentLike(a))
    .sort((a, b) => a.studentName.localeCompare(b.studentName));
  const asg = alumnos.find(a => a.id === asgId);

  return (
    <Modal onClose={onClose}>
      <div className="bz-mod-t">Cargar upsell</div>
      <p className="bz-mod-s">Queda pagado directamente: {eur(bonusEurosFor('upsell'))} por upsell en la liquidación de {teacherId ? mesLargo(mesDe(teacherId)) : 'este mes'}.</p>
      <label className="bz-mod-l" htmlFor="bz-up-p">Profesor</label>
      <select id="bz-up-p" className="bz-sel" value={teacherId} onChange={e => { setTeacherId(e.target.value); setAsgId(''); }} style={{ width: '100%', marginBottom: 14 }}>
        <option value="">— Elegir —</option>
        {profes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <label className="bz-mod-l" htmlFor="bz-up-a">Alumno</label>
      <select id="bz-up-a" className="bz-sel" value={asgId} onChange={e => setAsgId(e.target.value)} disabled={!teacherId} style={{ width: '100%', marginBottom: 14 }}>
        <option value="">— Elegir —</option>
        {alumnos.map(a => <option key={a.id} value={a.id}>{a.studentName}</option>)}
      </select>
      <label className="bz-mod-l" htmlFor="bz-up-n">Cantidad</label>
      <input id="bz-up-n" className="bz-in" type="number" min={1} max={20} value={cantidad} onChange={e => setCantidad(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))} style={{ marginBottom: 14 }} />
      <label className="bz-mod-l" htmlFor="bz-up-nota">Nota (opcional)</label>
      <textarea id="bz-up-nota" className="bz-mod-ta" rows={2} value={nota} onChange={e => setNota(e.target.value)} placeholder="Qué compró el alumno." />
      <div className="bz-mod-b">
        <button type="button" className="adm-btn adm-btn-ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="adm-btn adm-btn-primary" disabled={!asg}
          onClick={() => asg && onConfirm({ teacherId, assignmentId: asg.id, studentName: asg.studentName, quantity: cantidad, note: nota })}>
          Cargar {cantidad > 1 ? `${cantidad} upsells` : 'upsell'} · {eur(bonusEurosFor('upsell') * cantidad)}
        </button>
      </div>
    </Modal>
  );
}

// ─── Estilos ─────────────────────────────────────────────────────────────────
// Misma anatomía que Finanzas (fz-*). Por debajo de 768 px cada fila es una
// tarjeta: alumno y estado arriba, datos en una línea, acción abajo.
const ESTILOS = `
.bz { font-family: var(--font-app); color: #1a1c1a; position: relative; }
.bz-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.bz-head-r { display: flex; gap: 8px; flex-wrap: wrap; }
.bz-h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.015em; margin: 0; }
.bz-sub { font-size: 13px; color: var(--text-secondary); margin: 4px 0 0; }
.bz-error { background: #FDECEC; color: #C81E1E; border: 1px solid rgba(200,30,30,0.3); border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 12px; }
.bz-aviso { background: #EAF5EC; color: #167A2D; border: 1px solid rgba(22,122,45,0.3); border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 12px; }
.bz-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.bz-kpi { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; text-align: left; font-family: inherit; cursor: pointer; min-height: 0; }
.bz-kpi:hover { border-color: #C8C8C0; } .bz-kpi.is-on { border-color: #1E9E3A; box-shadow: inset 0 0 0 1px #1E9E3A; }
.bz-kpi-l { font-size: 12.5px; font-weight: 600; color: #4A4A4A; }
.bz-kpi-v { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
.bz-kpi-def { font-size: 12.5px; color: #4A4A4A; line-height: 1.45; padding-top: 8px; border-top: 1px dashed #E0E0DA; }
.bz-filtros { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 12px; }
.bz-filtros-r { display: flex; gap: 8px; flex-wrap: wrap; }
.bz-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.bz-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1.5px solid #E0E0DA; background: transparent; font-family: inherit; font-size: 13px; font-weight: 500; color: #4A4A4A; cursor: pointer; }
.bz-chip:hover { background: #f4f5f2; }
.bz-chip[aria-pressed="true"] { border-color: #1E9E3A; background: rgba(30,158,58,0.1); color: #1E9E3A; font-weight: 700; }
.bz-chip .n { font-size: 12px; font-weight: 700; color: #6E6E66; } .bz-chip[aria-pressed="true"] .n { color: #1E9E3A; }
.bz-sel, .bz-in { min-height: 36px; padding: 6px 10px; border-radius: 8px; border: 1.5px solid #E0E0DA; background: #fff; font-family: inherit; font-size: 13px; color: #1a1c1a; box-sizing: border-box; }
.bz-in { width: 100%; max-width: 260px; } .bz-in-inline { max-width: 170px; min-height: 32px; padding: 4px 8px; }
.bz-filtros-r .bz-sel { width: auto; max-width: 320px; flex: 0 0 auto; }
.bz-tabla { overflow: hidden; }
.bz-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.9fr) 92px 70px 150px 130px minmax(0, 1fr) 150px; align-items: center; gap: 10px; min-height: 52px; padding: 6px 14px; border-top: 1px solid #ECECE8; font-size: 13.5px; }
.bz-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; }
.bz-row.is-busy { opacity: 0.6; }
.bz-row.is-reclamado { background: #FFFBEB; }
.bz-meta { display: contents; }
.bz-nom { min-width: 0; display: flex; flex-direction: column; } .bz-nom b { font-weight: 600; }
.bz-nota { display: block; font-size: 11.5px; color: #6E6E66; line-height: 1.3; margin-top: 1px; }
.bz-muted { color: #a4a7a1; }
.bz-lapiz { background: none; border: 0; cursor: pointer; color: #6E6E66; font-size: 13px; padding: 0 4px; min-height: 0; line-height: 1; font-family: inherit; } .bz-lapiz:hover { color: #1E9E3A; }
.bz-since { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.bz-due { display: flex; flex-direction: column; align-items: flex-start; }
.bz-imp { font-weight: 600; white-space: nowrap; }
.bz-est { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.bz-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.bz-pill.verde { background: #EAF5EC; color: #167A2D; } .bz-pill.ambar { background: #FFF6E0; color: #B45309; }
.bz-pill.gris { background: #F0F0ED; color: #4A4A4A; } .bz-pill.rojo { background: #FDECEC; color: #C81E1E; }
.bz-act { display: flex; justify-content: flex-end; }
.bz-btn-ok { border: 1px solid rgba(22,122,45,0.30); background: #EAF5EC; color: #167A2D; min-height: 32px; padding: 5px 11px; font-size: 12.5px; border-radius: 7px; white-space: nowrap; }
.bz-btn-ok:hover:not(:disabled) { background: #1E9E3A; color: #fff; } .bz-btn-ok:disabled { opacity: 0.45; cursor: not-allowed; }
.bz-vacio { padding: 28px 16px; text-align: center; color: #6E6E66; font-size: 13.5px; }
.bz-scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(3px); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 16px; }
.bz-mod { background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 22px; width: 100%; max-width: 460px; max-height: 90vh; overflow-y: auto; }
.bz-mod-t { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
.bz-mod-s { font-size: 13.5px; color: #4A4A4A; line-height: 1.55; margin: 0 0 16px; }
.bz-mod-l { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
.bz-mod-ta { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border); font-size: 13px; background: #fff; color: var(--text-primary); font-family: inherit; box-sizing: border-box; resize: vertical; margin-bottom: 14px; }
.bz-mod-b { display: flex; gap: 10px; } .bz-mod-b .adm-btn { flex: 1; }
.bz-mod .bz-in { max-width: none; }
@media (max-width: 1100px) {
  .bz-row { grid-template-columns: minmax(0, 1.3fr) minmax(0, 0.8fr) 80px 60px 130px 110px minmax(0, 1fr) 130px; gap: 8px; font-size: 13px; }
}
@media (max-width: 767px) {
  .bz-head { margin-bottom: 12px; } .bz-sub { display: none; }
  .bz-head-r { width: 100%; } .bz-head-r .adm-btn { flex: 1; min-height: 44px; }
  .bz-kpis { display: flex; flex-direction: column; gap: 10px; }
  .bz-kpi { padding: 12px 14px; gap: 4px; } .bz-kpi-v { font-size: 24px; }
  .bz-filtros-r { width: 100%; } .bz-filtros-r .bz-sel, .bz-filtros-r .bz-in { flex: 1; max-width: none; min-height: 44px; }
  .bz-tabla { background: transparent; border: 0; box-shadow: none; overflow: visible; }
  .bz-row.head { display: none; }
  .bz-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "nom est" "meta meta" "since due" "act act"; gap: 6px 10px; padding: 12px 14px; min-height: 0; background: #fff; border: 1px solid #E0E0DA; border-radius: 10px; margin-bottom: 8px; }
  .bz-row.is-reclamado { border-color: #D97706; }
  .bz-nom { grid-area: nom; } .bz-nom b { font-size: 15px; }
  .bz-est { grid-area: est; align-items: flex-end; }
  .bz-meta { grid-area: meta; display: flex; gap: 6px; flex-wrap: wrap; font-size: 12.5px; color: #6E6E66; }
  .bz-meta > span + span::before { content: '· '; }
  .bz-imp { font-weight: 600; color: #1a1c1a; }
  .bz-since { grid-area: since; font-size: 12.5px; color: #4A4A4A; flex-wrap: nowrap; white-space: nowrap; } .bz-since::before { content: 'Desde '; color: #6E6E66; margin-right: 2px; }
  .bz-due { grid-area: due; font-size: 12.5px; color: #4A4A4A; flex-direction: row; gap: 6px; flex-wrap: wrap; justify-content: flex-end; } .bz-due::before { content: 'Cumple '; color: #6E6E66; }
  .bz-due .bz-nota { display: inline; margin: 0; }
  .bz-act { grid-area: act; justify-content: stretch; margin-top: 4px; } .bz-act:empty { display: none; }
  .bz-act .adm-btn { min-height: 40px; flex: 1; }
  .bz-lapiz { min-height: 32px; min-width: 32px; }
  .bz-scrim { align-items: flex-end; padding: 0; }
  .bz-mod { border-radius: 16px 16px 0 0; max-width: none; padding: 18px 16px calc(16px + env(safe-area-inset-bottom)); }
  .bz-mod-b .adm-btn { min-height: 44px; }
}
`;
