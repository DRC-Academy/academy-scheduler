'use client';
// ── Pestaña "Bonos" del admin ────────────────────────────────────────────────
//
// Una fila por alumno+profesor con su estado (lib/bonuses.buildBonusRows): la
// MISMA lista que ve el profesor en Mi Scoring y que usa Seguimiento, así el
// "disponible" no puede diferir entre pantallas.
//
// Qué hace el admin acá:
//   · reclamado        → Aprobar (suma al mes de la aprobación) o Rechazar (motivo).
//   · disponible/próximo → "Ya pagado fuera del sistema" (uno o varios a la vez):
//                        crea la fila pagado_externo, que bloquea el par y no suma.
//   · pagado_externo   → el alumno es editable (históricos "SIN NOMBRE — …").
//   · cualquier fila con asignación → "con el profe desde" editable (teacher_since).
//   · Cargar upsell    → filas 'aprobado' directas (el profesor no reclama upsells).
//
// Mismo lenguaje visual que Finanzas (clases fz-* → acá bz-*). En el teléfono
// cada fila es una tarjeta; nada se desliza en horizontal.

import { useMemo, useState } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import {
  buildBonusRows, bonusCounters, bonusEurosFor, BONUS_STATE_LABEL,
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

// "Todos" es todo lo que ya es (o está por ser) un bono. Los pares a los que les
// falta más de un mes van aparte, en "En curso": solo sirven para ver y corregir
// la fecha "con el profe desde".
const ESTADOS: Array<{ id: 'todos' | BonusRowState; label: string }> = [
  { id: 'todos', label: 'Todos' },
  { id: 'reclamado', label: 'Reclamados' },
  { id: 'disponible', label: 'Disponibles' },
  { id: 'proximo', label: 'Próximos' },
  { id: 'aprobado', label: 'Aprobados' },
  { id: 'pagado', label: 'Pagados' },
  { id: 'pagado_externo', label: 'Pagados fuera' },
  { id: 'rechazado', label: 'Rechazados' },
  { id: 'en_curso', label: 'En curso' },
];

const PILL: Record<BonusRowState, string> = {
  reclamado: 'ambar', disponible: 'verde', proximo: 'azul', en_curso: 'gris',
  aprobado: 'verde', pagado: 'gris', pagado_externo: 'gris', rechazado: 'rojo',
};

// ─── Componente ──────────────────────────────────────────────────────────────

export default function BonusesTab() {
  const {
    teachers, assignments, teacherBonuses,
    approveBonus, rejectBonus, markBonusesPaidExternal, addUpsellBonuses,
    updateBonusStudentName, updateAssignmentTeacherSince, loadTeacherBonuses,
  } = useTeachers();
  const { user } = useAuth();
  const adminName = user?.displayName || user?.username || 'admin';

  const [estado, setEstado]     = useState<'todos' | BonusRowState>('todos');
  const [profe, setProfe]       = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [sel, setSel]           = useState<Set<string>>(new Set());
  const [busy, setBusy]         = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [aviso, setAviso]       = useState<string | null>(null);

  // Modales
  const [rechazo, setRechazo]       = useState<BonusRow | null>(null);
  const [externo, setExterno]       = useState<BonusRow[] | null>(null);
  const [upsellOpen, setUpsellOpen] = useState(false);

  // Edición inline
  const [editNombre, setEditNombre] = useState<{ key: string; value: string } | null>(null);
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
    (estado === 'todos' ? r.estado !== 'en_curso' : r.estado === estado) &&
    (!q || normName(r.studentName).includes(q) || normName(r.teacherName).includes(q)));

  // Profesores del desplegable: los vigentes más los que tengan bonos (archivados).
  const conBonos = new Set(teacherBonuses.map(b => b.teacherId));
  const profesores = teachers
    .filter(t => !t.archivedAt || conBonos.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const seleccionables = visibles.filter(r => r.estado === 'disponible' || r.estado === 'proximo');
  const seleccionadas  = seleccionables.filter(r => sel.has(r.key));

  async function correr(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setError(null); setAviso(null);
    try { await fn(); }
    catch (err) {
      setError(err instanceof BonusAlreadyExistsError
        ? `${err.message} Recargá la lista.`
        : err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally { setBusy(null); }
  }

  async function aprobar(r: BonusRow) {
    if (!r.bonus) return;
    await correr(r.key, () => approveBonus(r.bonus!.id, adminName));
  }

  async function confirmarRechazo(motivo: string) {
    if (!rechazo?.bonus) return;
    const r = rechazo;
    setRechazo(null);
    await correr(r.key, () => rejectBonus(r.bonus!.id, motivo, adminName));
  }

  async function confirmarExterno(paidMonth: string, note: string) {
    if (!externo) return;
    const lote = externo;
    setExterno(null);
    await correr('lote', async () => {
      const duplicados = await markBonusesPaidExternal(lote.map(r => ({
        teacherId: r.teacherId,
        assignmentId: r.assignment?.id ?? null,
        studentName: r.studentName,
        bonusType: 'retencion_6m' as const,
        dueDate: r.dueDate,
        paidMonth: paidMonth || null,
        note: note.trim() || null,
      })));
      setSel(new Set());
      if (duplicados.length > 0) setAviso(`Ya tenían bono cargado (se saltaron): ${duplicados.join(', ')}.`);
      else setAviso(`${lote.length} bono${lote.length === 1 ? '' : 's'} marcado${lote.length === 1 ? '' : 's'} como pagado${lote.length === 1 ? '' : 's'} fuera del sistema.`);
    });
  }

  async function guardarNombre(r: BonusRow) {
    if (!editNombre || !r.bonus) return;
    const value = editNombre.value.trim();
    setEditNombre(null);
    if (!value || value === r.studentName) return;
    await correr(r.key, () => updateBonusStudentName(r.bonus!.id, value, r.teacherId));
  }

  async function guardarSince(r: BonusRow) {
    if (!editSince || !r.assignment) return;
    const value = editSince.value;
    setEditSince(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value === r.teacherSince) return;
    await correr(r.key, () => updateAssignmentTeacherSince(r.assignment!.id, value));
  }

  function toggleSel(key: string) {
    setSel(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }
  function toggleTodas() {
    if (seleccionadas.length === seleccionables.length) setSel(new Set());
    else setSel(new Set(seleccionables.map(r => r.key)));
  }

  return (
    <div className="bz">
      <style dangerouslySetInnerHTML={{ __html: ESTILOS }} />

      <div className="bz-head">
        <div>
          <h2 className="bz-h1">Bonos</h2>
          <p className="bz-sub">Retención a los 6 meses con el profesor y upsells. Un bono aprobado suma en el mes en que se aprueba.</p>
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
        <button type="button" className={`adm-card bz-kpi${estado === 'reclamado' ? ' is-on' : ''}`} onClick={() => setEstado(estado === 'reclamado' ? 'todos' : 'reclamado')}>
          <span className="bz-kpi-l">Reclamados sin aprobar</span>
          <span className="bz-kpi-v" style={{ color: cifras.reclamados > 0 ? '#B45309' : undefined }}>{cifras.reclamados}</span>
          <span className="bz-kpi-def">El profesor ya pidió el bono. Aprobalo o rechazalo.</span>
        </button>
        <button type="button" className={`adm-card bz-kpi${estado === 'proximo' ? ' is-on' : ''}`} onClick={() => setEstado(estado === 'proximo' ? 'todos' : 'proximo')}>
          <span className="bz-kpi-l">Próximos a cobrar</span>
          <span className="bz-kpi-v">{cifras.proximos}</span>
          <span className="bz-kpi-def">Cumplen 6 meses con su profesor en los próximos 30 días.</span>
        </button>
        <button type="button" className={`adm-card bz-kpi${estado === 'disponible' ? ' is-on' : ''}`} onClick={() => setEstado(estado === 'disponible' ? 'todos' : 'disponible')}>
          <span className="bz-kpi-l">Disponibles sin reclamar</span>
          <span className="bz-kpi-v" style={{ color: cifras.disponibles > 0 ? '#167A2D' : undefined }}>{cifras.disponibles}</span>
          <span className="bz-kpi-def">Ya cumplieron y el profesor todavía no reclamó. Si ya se pagó por email, marcalo como pagado fuera.</span>
        </button>
      </div>

      {/* Filtros */}
      <div className="bz-filtros">
        <div className="bz-chips" role="group" aria-label="Estado">
          {ESTADOS.map(e => {
            const n = e.id === 'todos' ? rows.filter(r => r.estado !== 'en_curso').length : rows.filter(r => r.estado === e.id).length;
            return (
              <button key={e.id} type="button" className="bz-chip" aria-pressed={estado === e.id} onClick={() => setEstado(e.id)}>
                {e.label} <span className="n">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="bz-filtros-r">
          <select className="bz-sel" value={profe} onChange={e => { setProfe(e.target.value); setSel(new Set()); }} aria-label="Profesor">
            <option value="">Todos los profesores</option>
            {profesores.map(t => <option key={t.id} value={t.id}>{t.name}{t.archivedAt ? ' (archivado)' : ''}</option>)}
          </select>
          <input className="bz-in" type="search" placeholder="Buscar alumno o profesor" value={busqueda} onChange={e => setBusqueda(e.target.value)} aria-label="Buscar" />
        </div>
      </div>

      {/* Acción masiva */}
      {seleccionables.length > 0 && (
        <div className="bz-lote">
          <label className="bz-lote-l">
            <input type="checkbox" checked={seleccionadas.length > 0 && seleccionadas.length === seleccionables.length} onChange={toggleTodas} />
            {seleccionadas.length > 0 ? `${seleccionadas.length} seleccionado${seleccionadas.length === 1 ? '' : 's'}` : `Seleccionar los ${seleccionables.length} disponibles/próximos a la vista`}
          </label>
          <button type="button" className="adm-btn adm-btn-ghost bz-btn-sm" disabled={seleccionadas.length === 0 || busy === 'lote'} onClick={() => setExterno(seleccionadas)}>
            Marcar como pagados fuera del sistema
          </button>
        </div>
      )}

      {/* Tabla */}
      <div className="adm-card bz-tabla">
        <div className="bz-row head" aria-hidden>
          <span className="bz-chk-h" />
          <span>Alumno</span><span>Profesor</span><span>Tipo</span><span>Importe</span>
          <span>Con el profe desde</span><span>Cumple el</span><span>Estado</span><span>Acciones</span>
        </div>
        {visibles.length === 0 && (
          <div className="bz-vacio">Nada que mostrar con estos filtros.</div>
        )}
        {visibles.map(r => {
          const ocupado = busy === r.key || busy === 'lote';
          const seleccionable = r.estado === 'disponible' || r.estado === 'proximo';
          const nombreEditable = r.estado === 'pagado_externo' && !!r.bonus;
          const editandoNombre = editNombre?.key === r.key;
          const editandoSince = editSince?.key === r.key;
          return (
            <div key={r.key} className={`bz-row is-${r.estado}${ocupado ? ' is-busy' : ''}`}>
              <span className="bz-chk">
                {seleccionable && <input type="checkbox" checked={sel.has(r.key)} onChange={() => toggleSel(r.key)} aria-label={`Seleccionar ${r.studentName}`} />}
              </span>

              <span className="bz-nom">
                {editandoNombre ? (
                  <input
                    className="bz-in bz-in-inline" autoFocus value={editNombre.value}
                    onChange={e => setEditNombre({ key: r.key, value: e.target.value })}
                    onBlur={() => guardarNombre(r)}
                    onKeyDown={e => { if (e.key === 'Enter') guardarNombre(r); if (e.key === 'Escape') setEditNombre(null); }}
                    aria-label="Nombre del alumno"
                  />
                ) : (
                  <>
                    <b className={r.studentName.toUpperCase().startsWith('SIN NOMBRE') ? 'bz-sinnombre' : ''}>{r.studentName}</b>
                    {nombreEditable && (
                      <button type="button" className="bz-lapiz" title="Corregir el alumno" onClick={() => setEditNombre({ key: r.key, value: r.studentName })}>✎</button>
                    )}
                    {r.bonus?.note && r.estado !== 'rechazado' && <small className="bz-nota">{r.bonus.note}</small>}
                    {r.estado === 'rechazado' && r.bonus?.note && <small className="bz-nota">Motivo: {r.bonus.note}</small>}
                  </>
                )}
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
                      <button type="button" className="bz-lapiz" title="Corregir desde cuándo está con este profesor" onClick={() => setEditSince({ key: r.key, value: r.teacherSince ?? spainTodayIso() })}>✎</button>
                    </>
                  )
                ) : <span className="bz-muted">sin asignación</span>}
              </span>

              <span className="bz-due">
                {r.dueDate ? (
                  <>
                    {fecha(r.dueDate)}
                    {r.daysLeft !== null && (r.estado === 'proximo' || r.estado === 'disponible' || r.estado === 'en_curso') && (
                      <small className="bz-nota">{r.daysLeft > 0 ? `faltan ${r.daysLeft} día${r.daysLeft === 1 ? '' : 's'}` : r.daysLeft === 0 ? 'hoy' : `hace ${-r.daysLeft} día${r.daysLeft === -1 ? '' : 's'}`}</small>
                    )}
                  </>
                ) : <span className="bz-muted">—</span>}
              </span>

              <span className="bz-est">
                <span className={`bz-pill ${PILL[r.estado]}`}>{BONUS_STATE_LABEL[r.estado]}</span>
                {r.bonus?.status === 'pagado' && r.bonus.paidMonth && <small className="bz-nota">mes {r.bonus.paidMonth}</small>}
                {r.bonus?.status === 'pagado_externo' && r.bonus.paidMonth && <small className="bz-nota">mes {r.bonus.paidMonth}</small>}
                {r.bonus?.status === 'aprobado' && r.bonus.approvedAt && <small className="bz-nota">aprobado el {fecha(r.bonus.approvedAt)}</small>}
                {r.bonus?.status === 'reclamado' && r.bonus.claimedAt && <small className="bz-nota">reclamado el {fecha(r.bonus.claimedAt)}</small>}
              </span>

              <span className="bz-act">
                {r.estado === 'reclamado' && (
                  <>
                    <button type="button" className="adm-btn bz-btn-ok" disabled={ocupado} onClick={() => aprobar(r)}>{ocupado ? '…' : 'Aprobar'}</button>
                    <button type="button" className="adm-btn adm-btn-ghost bz-btn-sm" disabled={ocupado} onClick={() => setRechazo(r)}>Rechazar</button>
                  </>
                )}
                {seleccionable && (
                  <button type="button" className="adm-btn adm-btn-ghost bz-btn-sm" disabled={ocupado} onClick={() => setExterno([r])}>Ya pagado fuera del sistema</button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {rechazo && (
        <RechazoModal row={rechazo} onClose={() => setRechazo(null)} onConfirm={confirmarRechazo} />
      )}
      {externo && (
        <ExternoModal rows={externo} onClose={() => setExterno(null)} onConfirm={confirmarExterno} />
      )}
      {upsellOpen && (
        <UpsellModal
          onClose={() => setUpsellOpen(false)}
          onConfirm={async p => {
            setUpsellOpen(false);
            await correr('upsell', async () => {
              await addUpsellBonuses({ ...p, approvedBy: adminName });
              setAviso(`${p.quantity} upsell${p.quantity === 1 ? '' : 's'} de ${p.studentName} cargado${p.quantity === 1 ? '' : 's'} (${eur(bonusEurosFor('upsell') * p.quantity)}).`);
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

function RechazoModal({ row, onClose, onConfirm }: { row: BonusRow; onClose: () => void; onConfirm: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState('');
  return (
    <Modal onClose={onClose}>
      <div className="bz-mod-t">Rechazar el bono de {row.studentName}</div>
      <p className="bz-mod-s">El profesor ({row.teacherName}) verá el motivo en Mi Scoring. El par vuelve a quedar disponible: si fue un error, puede reclamar de nuevo.</p>
      <label className="bz-mod-l" htmlFor="bz-motivo">Motivo</label>
      <textarea id="bz-motivo" className="bz-mod-ta" rows={3} value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Por ejemplo: el alumno cambió de profesor en julio." />
      <div className="bz-mod-b">
        <button type="button" className="adm-btn adm-btn-ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="adm-btn adm-btn-primary" disabled={!motivo.trim()} onClick={() => onConfirm(motivo)}>Rechazar</button>
      </div>
    </Modal>
  );
}

function ExternoModal({ rows, onClose, onConfirm }: { rows: BonusRow[]; onClose: () => void; onConfirm: (paidMonth: string, note: string) => void }) {
  const [mes, setMes]   = useState(spainTodayIso().slice(0, 7));
  const [nota, setNota] = useState('');
  return (
    <Modal onClose={onClose}>
      <div className="bz-mod-t">{rows.length === 1 ? `Bono de ${rows[0].studentName} pagado fuera del sistema` : `${rows.length} bonos pagados fuera del sistema`}</div>
      <p className="bz-mod-s">Queda registrado como <b>pagado fuera del sistema</b>: el profesor no podrá reclamarlo y <b>no suma</b> a ninguna liquidación. Es para lo que ya se pagó por email antes de existir esta pestaña.</p>
      {rows.length > 1 && (
        <ul className="bz-mod-lista">{rows.map(r => <li key={r.key}>{r.studentName} · {r.teacherName}</li>)}</ul>
      )}
      <label className="bz-mod-l" htmlFor="bz-mes">Mes en que se pagó</label>
      <input id="bz-mes" className="bz-in" type="month" value={mes} onChange={e => setMes(e.target.value)} style={{ marginBottom: 14 }} />
      <label className="bz-mod-l" htmlFor="bz-nota">Nota (opcional)</label>
      <textarea id="bz-nota" className="bz-mod-ta" rows={2} value={nota} onChange={e => setNota(e.target.value)} />
      <div className="bz-mod-b">
        <button type="button" className="adm-btn adm-btn-ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="adm-btn adm-btn-primary" onClick={() => onConfirm(mes, nota)}>Confirmar</button>
      </div>
    </Modal>
  );
}

function UpsellModal({ onClose, onConfirm }: {
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
      <p className="bz-mod-s">Queda <b>aprobado</b> directamente y suma {eur(bonusEurosFor('upsell'))} por upsell a la liquidación de este mes del profesor.</p>
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
// tarjeta: alumno y estado arriba, datos en una línea, acciones abajo.
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
.bz-in { width: 100%; max-width: 260px; } .bz-in-inline { max-width: 200px; min-height: 32px; padding: 4px 8px; }
.bz-lote { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; background: #FAFAF8; border: 1px solid #ECECE8; border-radius: 10px; padding: 8px 12px; margin-bottom: 10px; font-size: 13px; }
.bz-lote-l { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; flex: 1; min-width: 0; }
.bz-tabla { overflow: hidden; }
.bz-row { display: grid; grid-template-columns: 28px minmax(0, 1.4fr) minmax(0, 0.9fr) 92px 70px 130px 130px minmax(0, 1fr) minmax(0, 1.1fr); align-items: center; gap: 10px; min-height: 52px; padding: 6px 14px; border-top: 1px solid #ECECE8; font-size: 13.5px; }
.bz-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; }
.bz-row.is-busy { opacity: 0.6; }
.bz-row.is-reclamado { background: #FFFBEB; }
.bz-chk { display: flex; align-items: center; } .bz-chk input { width: 18px; height: 18px; cursor: pointer; }
.bz-meta { display: contents; }
.bz-nom { min-width: 0; display: flex; flex-direction: column; } .bz-nom b { font-weight: 600; display: inline-flex; align-items: center; gap: 4px; }
.bz-sinnombre { color: #B45309; }
.bz-nota { display: block; font-size: 11.5px; color: #6E6E66; line-height: 1.3; margin-top: 1px; }
.bz-muted { color: #a4a7a1; }
.bz-lapiz { background: none; border: 0; cursor: pointer; color: #6E6E66; font-size: 13px; padding: 0 4px; min-height: 0; line-height: 1; font-family: inherit; } .bz-lapiz:hover { color: #1E9E3A; }
.bz-since, .bz-due { display: flex; flex-direction: column; align-items: flex-start; }
.bz-since { flex-direction: row; align-items: center; gap: 2px; flex-wrap: wrap; }
.bz-imp { font-weight: 600; white-space: nowrap; }
.bz-est { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.bz-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.bz-pill.verde { background: #EAF5EC; color: #167A2D; } .bz-pill.ambar { background: #FFF6E0; color: #B45309; }
.bz-pill.azul { background: #E8F0FE; color: #1D4ED8; } .bz-pill.gris { background: #F0F0ED; color: #4A4A4A; } .bz-pill.rojo { background: #FDECEC; color: #C81E1E; }
.bz-act { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.bz-btn-ok { border: 1px solid rgba(22,122,45,0.30); background: #EAF5EC; color: #167A2D; min-height: 32px; padding: 5px 11px; font-size: 12.5px; border-radius: 7px; }
.bz-btn-ok:hover:not(:disabled) { background: #1E9E3A; color: #fff; } .bz-btn-ok:disabled { opacity: 0.5; cursor: default; }
.bz-btn-sm { min-height: 32px; padding: 5px 11px; font-size: 12.5px; border-radius: 7px; }
.bz-vacio { padding: 28px 16px; text-align: center; color: #6E6E66; font-size: 13.5px; }
.bz-scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(3px); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 16px; }
.bz-mod { background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 22px; width: 100%; max-width: 460px; max-height: 90vh; overflow-y: auto; }
.bz-mod-t { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
.bz-mod-s { font-size: 13.5px; color: #4A4A4A; line-height: 1.55; margin: 0 0 16px; }
.bz-mod-l { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
.bz-mod-ta { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border); font-size: 13px; background: #fff; color: var(--text-primary); font-family: inherit; box-sizing: border-box; resize: vertical; margin-bottom: 14px; }
.bz-mod-lista { margin: 0 0 14px; padding-left: 18px; font-size: 13px; color: #4A4A4A; max-height: 160px; overflow-y: auto; }
.bz-mod-b { display: flex; gap: 10px; } .bz-mod-b .adm-btn { flex: 1; }
.bz-mod .bz-in { max-width: none; }
@media (max-width: 1100px) {
  .bz-row { grid-template-columns: 28px minmax(0, 1.3fr) minmax(0, 0.8fr) 80px 60px 110px 110px minmax(0, 1fr) minmax(0, 1fr); gap: 8px; font-size: 13px; }
}
@media (max-width: 767px) {
  .bz-head { margin-bottom: 12px; } .bz-sub { display: none; }
  .bz-head-r { width: 100%; } .bz-head-r .adm-btn { flex: 1; min-height: 44px; }
  .bz-kpis { display: flex; flex-direction: column; gap: 10px; }
  .bz-kpi { padding: 12px 14px; gap: 4px; } .bz-kpi-v { font-size: 24px; }
  .bz-filtros-r { width: 100%; } .bz-filtros-r .bz-sel, .bz-filtros-r .bz-in { flex: 1; max-width: none; min-height: 44px; }
  .bz-lote .adm-btn { width: 100%; min-height: 44px; }
  .bz-tabla { background: transparent; border: 0; box-shadow: none; overflow: visible; }
  .bz-row.head { display: none; }
  .bz-row { grid-template-columns: 28px minmax(0, 1fr) auto; grid-template-areas: "chk nom est" "chk meta meta" "chk since due" "chk act act"; gap: 6px 10px; padding: 12px 12px 12px 14px; min-height: 0; background: #fff; border: 1px solid #E0E0DA; border-radius: 10px; margin-bottom: 8px; }
  .bz-row.is-reclamado { border-color: #D97706; }
  .bz-chk { grid-area: chk; align-self: start; padding-top: 2px; } .bz-chk input { width: 22px; height: 22px; }
  .bz-nom { grid-area: nom; } .bz-nom b { font-size: 15px; }
  .bz-est { grid-area: est; align-items: flex-end; }
  .bz-meta { grid-area: meta; display: flex; gap: 6px; flex-wrap: wrap; font-size: 12.5px; color: #6E6E66; }
  .bz-meta > span + span::before { content: '· '; }
  .bz-imp { font-weight: 600; color: #1a1c1a; }
  .bz-since { grid-area: since; font-size: 12.5px; color: #4A4A4A; flex-wrap: nowrap; white-space: nowrap; } .bz-since::before { content: 'Desde '; color: #6E6E66; margin-right: 2px; }
  .bz-due { grid-area: due; font-size: 12.5px; color: #4A4A4A; flex-direction: row; gap: 6px; flex-wrap: wrap; justify-content: flex-end; } .bz-due::before { content: 'Cumple '; color: #6E6E66; }
  .bz-due .bz-nota { display: inline; margin: 0; }
  .bz-act { grid-area: act; justify-content: flex-start; margin-top: 4px; }
  .bz-act .adm-btn { min-height: 40px; flex: 1; }
  .bz-lapiz { min-height: 32px; min-width: 32px; }
  .bz-scrim { align-items: flex-end; padding: 0; }
  .bz-mod { border-radius: 16px 16px 0 0; max-width: none; padding: 18px 16px calc(16px + env(safe-area-inset-bottom)); }
  .bz-mod-b .adm-btn { min-height: 44px; }
}
`;
