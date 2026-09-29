'use client';

// Pestaña admin "Fuera de calendario": alumnos cuya asignación dice que son de un
// profesor, pero que NO se ven en el calendario de ese profesor.
//
// La lista sale de lib/offCalendar (misma lógica que la consulta de diagnóstico
// de sep/2026). Desde acá se restaura: el alumno vuelve a las casillas de su
// ficha, con el nombre EXACTO de la asignación, y la asignación vuelve a activa.
// Nunca se pisa a otro alumno: las casillas ocupadas se saltan y se avisa.
//
// Regla de negocio (Facundo, sep/2026): si un profesor lo quitó a mano está bien
// que no esté; los que salieron por cualquier otro motivo tienen que volver. Por
// eso el orden por defecto pone primero a los que tienen suscripción activa y NO
// fueron quitados a mano.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import { checkSubscription, subBadge, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';
import { dbLoadOffCalendar, dbRestoreToCalendar, dbFixCalendarName, type CalendarActor, type RestoreResult } from '@/lib/db';
import { causeLabel, removalText, type OffCalendarRow, type SlotStatus } from '@/lib/offCalendar';
import { normLoose } from '@/lib/gridPatch';
import { isAssignableCell } from '@/lib/cells';
import type { AssignedSlot, Grid } from '@/types';

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

type Filtro = 'all' | 'restaurables' | 'nombre' | 'otro' | 'sin_libres';

/** Horarios de la ficha que hoy están libres en el calendario del profesor. */
function libres(r: OffCalendarRow): AssignedSlot[] {
  return r.slotStatus.filter(s => s.state === 'libre').map(({ day, hour }) => ({ day, hour }));
}

/** ¿Se puede restaurar desde la ficha (o eligiendo a mano)? */
function restaurable(r: OffCalendarRow): boolean {
  return r.cause.kind === 'sin_horario';
}

function fueQuitaManual(r: OffCalendarRow): boolean {
  return r.assignment.calendarRemovedManual === true;
}

function fechaCorta(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

function slotChip(s: SlotStatus): { texto: string; color: string; bg: string } {
  const h = `${s.day} ${s.hour}`;
  switch (s.state) {
    case 'libre':       return { texto: `${h} · libre`, color: '#15803d', bg: 'rgba(30,158,58,0.1)' };
    case 'ocupado':     return { texto: `${h} · ocupado por ${s.occupant ?? 'otro alumno'}`, color: '#b42318', bg: 'rgba(239,68,68,0.08)' };
    case 'no_work':     return { texto: `${h} · no trabaja`, color: '#6E6E66', bg: '#F1F1EE' };
    case 'sin_casilla': return { texto: `${h} · horario no habilitado`, color: '#6E6E66', bg: '#F1F1EE' };
  }
}

export default function FueraDeCalendarioTab() {
  const { classRecords, getTeacherGrid, reloadAll } = useTeachers();
  const { user } = useAuth();

  const [rows, setRows] = useState<OffCalendarRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<Record<string, SubscriptionInfo>>({});
  const [filtro, setFiltro] = useState<Filtro>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  /** Resultado de la última acción por asignación. */
  const [msgs, setMsgs] = useState<Record<string, { ok: boolean; texto: string }>>({});
  /** Asignación con el selector manual de día/hora abierto. */
  const [manual, setManual] = useState<OffCalendarRow | null>(null);

  const actor: CalendarActor = useMemo(() => ({
    role: user?.role ?? 'admin',
    name: user?.displayName || user?.username || 'admin',
    origin: 'restauracion',
  }), [user]);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setRows(await dbLoadOffCalendar());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Suscripciones: la regla real (lib/subscriptionAccess vía /api/check-subscription,
  // WooCommerce incluido), de a 5 para no saturar Woo.
  useEffect(() => {
    if (!rows) return;
    const emails = [...new Set(rows.map(r => r.assignment.studentEmail?.trim().toLowerCase()).filter(Boolean))] as string[];
    let cancelled = false;
    (async () => {
      for (let i = 0; i < emails.length; i += 5) {
        if (cancelled) return;
        const lote = emails.slice(i, i + 5);
        const infos = await Promise.all(lote.map(e => checkSubscription(e).catch(() => undefined)));
        if (cancelled) return;
        setSubs(prev => {
          const next = { ...prev };
          lote.forEach((e, j) => { if (infos[j]) next[e] = infos[j]!; });
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  const subDe = useCallback((r: OffCalendarRow) => subs[r.assignment.studentEmail?.trim().toLowerCase() ?? ''], [subs]);

  // Última clase DADA (normal o recuperación), con cualquier profesor.
  const ultimaClase = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of classRecords) {
      const t = c.classType ?? 'normal';
      if (t !== 'normal' && t !== 'recuperacion') continue;
      const k = normLoose(c.studentName);
      if (!m.has(k) || m.get(k)! < c.classDate) m.set(k, c.classDate);
    }
    return m;
  }, [classRecords]);

  // Orden: 0 = suscripción activa y NO quitado a mano (tienen que volver),
  // 1 = suscripción sin confirmar todavía, 2 = activa pero quitado a mano, 3 = el resto.
  const rango = useCallback((r: OffCalendarRow) => {
    const s = subDe(r);
    const activa = s?.active === true;
    if (activa && !fueQuitaManual(r)) return 0;
    if (!s || s.active === null) return 1;
    if (activa) return 2;
    return 3;
  }, [subDe]);

  const visibles = useMemo(() => {
    if (!rows) return [];
    const texto = normLoose(q);
    return rows
      .filter(r => {
        if (filtro === 'restaurables' && !(restaurable(r) && libres(r).length > 0)) return false;
        if (filtro === 'sin_libres' && !(restaurable(r) && libres(r).length === 0)) return false;
        if (filtro === 'nombre' && r.cause.kind !== 'nombre_distinto') return false;
        if (filtro === 'otro' && r.cause.kind !== 'otro_profesor') return false;
        if (texto && !normLoose(`${r.assignment.studentName} ${r.teacherName} ${r.assignment.studentEmail}`).includes(texto)) return false;
        return true;
      })
      .sort((a, b) => rango(a) - rango(b)
        || a.teacherName.localeCompare(b.teacherName, 'es')
        || a.assignment.studentName.localeCompare(b.assignment.studentName, 'es'));
  }, [rows, filtro, q, rango]);

  function describir(res: RestoreResult): { ok: boolean; texto: string } {
    const puestos = res.restored.map(s => `${s.day} ${s.hour}`).join(', ');
    const saltados = res.skipped.map(s => `${s.day} ${s.hour} (${s.reason})`).join('; ');
    if (res.restored.length === 0) return { ok: false, texto: `No se pudo poner ningún horario. ${saltados}` };
    return { ok: true, texto: `Restaurado en ${puestos}.${saltados ? ` Sin poner: ${saltados}.` : ''} Se avisó a ${res.teacherName}.` };
  }

  async function restaurar(r: OffCalendarRow, slots: AssignedSlot[]): Promise<boolean> {
    const id = r.assignment.id;
    setBusy(id);
    try {
      const res = await dbRestoreToCalendar(id, slots, actor);
      const m = describir(res);
      setMsgs(prev => ({ ...prev, [id]: m }));
      return m.ok;
    } catch (err) {
      setMsgs(prev => ({ ...prev, [id]: { ok: false, texto: err instanceof Error ? err.message : String(err) } }));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function confirmarRestaurar(r: OffCalendarRow) {
    const s = subDe(r);
    if (s?.active !== true && !confirm(
      `${r.assignment.studentName} no tiene la suscripción activa (${subBadge(s).label}).\n\n` +
      'Si ya no toma clases, restaurarlo le pondría a la profesora clases que no existen. ¿Restaurar igual?',
    )) return;
    if (await restaurar(r, libres(r))) { await cargar(); reloadAll(); }
  }

  async function restaurarSeleccion() {
    const elegidos = (rows ?? []).filter(r => sel.has(r.assignment.id));
    if (elegidos.length === 0) return;
    const inactivos = elegidos.filter(r => subDe(r)?.active !== true);
    const aviso = inactivos.length > 0
      ? `\n\nOJO: ${inactivos.length} no tienen la suscripción activa: ${inactivos.map(r => r.assignment.studentName).join(', ')}.`
      : '';
    if (!confirm(`¿Restaurar ${elegidos.length} alumno(s) al calendario de su profesor?${aviso}`)) return;
    for (const r of elegidos) await restaurar(r, libres(r));
    setSel(new Set());
    await cargar();
    reloadAll();
  }

  function seleccionarRecomendados() {
    setSel(new Set(visibles
      .filter(r => restaurable(r) && libres(r).length > 0 && subDe(r)?.active === true && !fueQuitaManual(r))
      .map(r => r.assignment.id)));
  }

  async function corregirNombre(r: OffCalendarRow, gridName: string) {
    const id = r.assignment.id;
    if (!confirm(`En el calendario de ${r.teacherName} figura como "${gridName}".\n\n¿Cambiarlo a "${r.assignment.studentName}" (el nombre de la asignación)?`)) return;
    setBusy(id);
    try {
      const res = await dbFixCalendarName(id, gridName, actor);
      setMsgs(prev => ({ ...prev, [id]: res.renamed > 0
        ? { ok: true, texto: `Nombre corregido en ${res.renamed} casilla(s).${res.conflicts ? ` ${res.conflicts} las cambió otra persona y no se tocaron.` : ''}` }
        : { ok: false, texto: 'No se encontró esa grafía en el calendario: puede que ya se haya corregido.' } }));
      await cargar();
      reloadAll();
    } catch (err) {
      setMsgs(prev => ({ ...prev, [id]: { ok: false, texto: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setBusy(null);
    }
  }

  const cuenta = rows ? {
    total: rows.length,
    restaurables: rows.filter(r => restaurable(r) && libres(r).length > 0).length,
    nombre: rows.filter(r => r.cause.kind === 'nombre_distinto').length,
    otro: rows.filter(r => r.cause.kind === 'otro_profesor').length,
  } : null;

  return (
    <div className="fc">
      <div className="fc-head">
        <div>
          <h2 className="fc-title">Fuera de calendario</h2>
          <p className="fc-sub">
            Alumnos asignados a un profesor que no aparecen en su calendario. Primero van los que tienen la
            suscripción activa y nadie quitó a mano: esos tienen que volver.
          </p>
        </div>
        <button type="button" className="adm-btn adm-btn-ghost" onClick={() => { setRows(null); cargar(); }}>
          <RefreshCw size={14} strokeWidth={2.25} aria-hidden /> Actualizar
        </button>
      </div>

      {error && <div className="fc-error" role="alert">No se pudo cargar la lista: {error}</div>}

      {cuenta && (
        <div className="fc-kpis">
          <div className="adm-card fc-kpi"><div className="fc-kpi-v">{cuenta.total}</div><div className="fc-kpi-l">Fuera de calendario</div></div>
          <div className="adm-card fc-kpi"><div className="fc-kpi-v" style={{ color: '#15803d' }}>{cuenta.restaurables}</div><div className="fc-kpi-l">Restaurables desde la ficha</div></div>
          <div className="adm-card fc-kpi"><div className="fc-kpi-v" style={{ color: '#b45309' }}>{cuenta.nombre}</div><div className="fc-kpi-l">Nombre escrito distinto</div></div>
          <div className="adm-card fc-kpi"><div className="fc-kpi-v" style={{ color: '#2563eb' }}>{cuenta.otro}</div><div className="fc-kpi-l">Con otro profesor</div></div>
        </div>
      )}

      <div className="fc-ctl">
        <label className="fc-sel">
          <span className="fc-sel-l">Mostrar</span>
          <select value={filtro} onChange={e => setFiltro(e.target.value as Filtro)}>
            <option value="all">Todos</option>
            <option value="restaurables">Restaurables desde la ficha</option>
            <option value="sin_libres">Sin horario libre (elegir a mano)</option>
            <option value="nombre">Nombre escrito distinto</option>
            <option value="otro">Con otro profesor</option>
          </select>
        </label>
        <label className="fc-search">
          <Search size={15} aria-hidden />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar alumno o profesor" />
        </label>
        <div className="fc-bulk">
          <button type="button" className="adm-btn adm-btn-ghost" onClick={seleccionarRecomendados}>Seleccionar recomendados</button>
          <button type="button" className="adm-btn adm-btn-primary" disabled={sel.size === 0 || !!busy} onClick={restaurarSeleccion}>
            Restaurar seleccionados ({sel.size})
          </button>
        </div>
      </div>

      {!rows && !error && <div className="adm-card fc-vacio">Cargando…</div>}
      {rows && visibles.length === 0 && <div className="adm-card fc-vacio">Nadie fuera de calendario con estos filtros.</div>}

      <div className="fc-lista">
        {visibles.map(r => {
          const a = r.assignment;
          const s = subDe(r);
          const badge = subBadge(s);
          const ult = ultimaClase.get(normLoose(a.studentName));
          const puedeRestaurar = restaurable(r) && libres(r).length > 0;
          const msg = msgs[a.id];
          const ocupado = busy === a.id;
          return (
            <div key={a.id} className={`adm-card fc-card${rango(r) === 0 ? ' is-prioridad' : ''}`}>
              <div className="fc-top">
                {puedeRestaurar && (
                  <input type="checkbox" className="fc-check" aria-label={`Seleccionar a ${a.studentName}`}
                    checked={sel.has(a.id)}
                    onChange={e => setSel(prev => { const n = new Set(prev); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} />
                )}
                <div className="fc-quien">
                  <div className="fc-nom">{a.studentName}</div>
                  <div className="fc-mail">{a.studentEmail}</div>
                </div>
                <div className="fc-badges">
                  <span className="fc-pill" style={{ color: badge.color, background: badge.bg }}>{badge.label}</span>
                  <span className="fc-pill" style={(a.status ?? 'active') === 'active'
                    ? { color: '#15803d', background: 'rgba(30,158,58,0.1)' }
                    : { color: '#6E6E66', background: '#F1F1EE' }}>
                    Asignación {(a.status ?? 'active') === 'active' ? 'activa' : 'inactiva'}
                  </span>
                </div>
              </div>

              <dl className="fc-datos">
                <div><dt>Profesor</dt><dd className="fc-prof">{r.teacherName}</dd></div>
                <div><dt>Causa probable</dt><dd>{causeLabel(r.cause)}</dd></div>
                <div><dt>Quitado</dt><dd>{a.calendarRemovedAt ? removalText(a) : 'Motivo desconocido'}</dd></div>
                <div><dt>Última clase dada</dt><dd>{ult ? fechaCorta(ult) : 'Ninguna registrada'}</dd></div>
                <div className="fc-full"><dt>Horarios de la ficha</dt><dd>
                  {r.slotStatus.length === 0
                    ? <span className="fc-pill" style={{ color: '#b45309', background: 'rgba(245,158,11,0.12)' }}>Sin horario en la ficha</span>
                    : <span className="fc-slots">{r.slotStatus.map(st => {
                        const c = slotChip(st);
                        return <span key={`${st.day}_${st.hour}`} className="fc-pill" style={{ color: c.color, background: c.bg }}>{c.texto}</span>;
                      })}</span>}
                </dd></div>
              </dl>

              <div className="fc-acciones">
                {r.cause.kind === 'sin_horario' && (
                  <>
                    {puedeRestaurar && (
                      <button type="button" className="adm-btn adm-btn-primary" disabled={ocupado} onClick={() => confirmarRestaurar(r)}>
                        {ocupado ? 'Restaurando…' : `Restaurar al calendario (${libres(r).length} h)`}
                      </button>
                    )}
                    <button type="button" className="adm-btn adm-btn-ghost" disabled={ocupado} onClick={() => setManual(r)}>
                      Elegir día y hora
                    </button>
                  </>
                )}
                {r.cause.kind === 'nombre_distinto' && r.cause.gridNames.map(g => (
                  <button key={g} type="button" className="adm-btn adm-btn-primary" disabled={ocupado} onClick={() => corregirNombre(r, g)}>
                    Corregir nombre (“{g}” → “{a.studentName}”)
                  </button>
                ))}
                {r.cause.kind === 'otro_profesor' && (
                  <span className="fc-nota">
                    Está con otro profesor ({r.cause.others.map(o => `${o.teacherName}, como "${o.gridName}"`).join('; ')}).
                    No se restaura: decidí desde Alumnos si cambiarlo de profesor.
                  </span>
                )}
                {r.cause.kind === 'oculto' && (
                  <span className="fc-nota">Está en su calendario en una casilla que no se dibuja ({r.cause.keys.join(', ')}). Revisar a mano.</span>
                )}
                {r.cause.kind === 'sin_calendario' && (
                  <span className="fc-nota">{r.teacherName} todavía no tiene calendario guardado: primero tiene que cargar su disponibilidad.</span>
                )}
              </div>

              {msg && <div className={`fc-msg ${msg.ok ? 'ok' : 'ko'}`} role="status">{msg.texto}</div>}
            </div>
          );
        })}
      </div>

      {manual && (
        <ElegirHorario
          row={manual}
          getTeacherGrid={getTeacherGrid}
          onCancel={() => setManual(null)}
          onConfirm={async slots => {
            const r = manual;
            setManual(null);
            if (await restaurar(r, slots)) { await cargar(); reloadAll(); }
          }}
        />
      )}

      <style>{ESTILOS}</style>
    </div>
  );
}

/**
 * Selector manual de día y hora para restaurar. Solo ofrece las casillas LIBRES
 * del calendario del profesor: nunca se pone a nadie encima de otro alumno.
 */
function ElegirHorario({ row, getTeacherGrid, onCancel, onConfirm }: {
  row: OffCalendarRow;
  getTeacherGrid: (id: string, force?: boolean) => Promise<Grid>;
  onCancel: () => void;
  onConfirm: (slots: AssignedSlot[]) => void;
}) {
  const [grid, setGrid] = useState<Grid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elegidos, setElegidos] = useState<AssignedSlot[]>([]);

  useEffect(() => {
    getTeacherGrid(row.assignment.teacherId, true)
      .then(setGrid)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  // Sin getTeacherGrid en las dependencias: el contexto la recrea en cada render
  // y leer el grid actualiza el contexto, así que relanzaría la lectura en bucle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.assignment.teacherId]);

  const libresPorDia = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [key, cell] of Object.entries(grid ?? {})) {
      if (!isAssignableCell(cell)) continue;
      const usc = key.lastIndexOf('_');
      const day = key.slice(0, usc);
      const hour = key.slice(usc + 1);
      if (!DIAS.includes(day)) continue;
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(hour);
    }
    for (const hs of m.values()) hs.sort((x, y) => parseInt(x, 10) - parseInt(y, 10));
    return m;
  }, [grid]);

  const esta = (d: string, h: string) => elegidos.some(s => s.day === d && s.hour === h);
  const toggle = (d: string, h: string) =>
    setElegidos(prev => esta(d, h) ? prev.filter(s => !(s.day === d && s.hour === h)) : [...prev, { day: d, hour: h }]);

  return (
    <div className="fc-scrim" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="fc-modal" role="dialog" aria-modal="true" aria-labelledby="fc-modal-t">
        <h3 id="fc-modal-t" className="fc-modal-t">Elegir horario para {row.assignment.studentName}</h3>
        <p className="fc-sub">
          Horarios libres hoy en el calendario de {row.teacherName}.
          {row.slotStatus.length > 0 && <> La ficha decía: {row.slotStatus.map(s => `${s.day} ${s.hour}`).join(', ')}.</>}
          {' '}Confirmá con el profesor antes de restaurar.
        </p>
        {error && <div className="fc-error">{error}</div>}
        {!grid && !error && <div className="fc-sub">Cargando calendario…</div>}
        {grid && libresPorDia.size === 0 && <div className="fc-sub">{row.teacherName} no tiene ningún horario libre.</div>}
        {grid && DIAS.filter(d => libresPorDia.has(d)).map(d => (
          <div key={d} className="fc-dia">
            <div className="fc-dia-n">{d}</div>
            <div className="fc-horas">
              {libresPorDia.get(d)!.map(h => (
                <button key={h} type="button" aria-pressed={esta(d, h)} className={`fc-hora${esta(d, h) ? ' is-on' : ''}`} onClick={() => toggle(d, h)}>{h}</button>
              ))}
            </div>
          </div>
        ))}
        <div className="fc-modal-acc">
          <button type="button" className="adm-btn adm-btn-ghost" onClick={onCancel}>Cancelar</button>
          <button type="button" className="adm-btn adm-btn-primary" disabled={elegidos.length === 0}
            onClick={() => onConfirm(elegidos)}>
            Restaurar en {elegidos.length} horario(s)
          </button>
        </div>
      </div>
    </div>
  );
}

const ESTILOS = `
.fc { font-family: var(--font-app); color: #1a1c1a; }
.fc-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.fc-head .adm-btn { display: inline-flex; align-items: center; gap: 6px; }
.fc-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.fc-sub { font-size: 13px; color: var(--text-muted); margin: 3px 0 0; max-width: 560px; line-height: 1.45; }
.fc-error { border: 1px solid #f0c2c2; background: #fdf3f3; color: #8a1f1f; border-radius: 10px; padding: 10px 14px; font-size: 13.5px; margin-bottom: 12px; }
.fc-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.fc-kpi { padding: 14px 16px; }
.fc-kpi-v { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
.fc-kpi-l { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); margin-top: 4px; }
.fc-ctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.fc-sel { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px 0 12px; border: 1px solid #e6e7e2; border-radius: 10px; background: #fff; }
.fc-sel-l { font-size: 13px; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
.fc-sel select { height: 100%; border: 0; background: transparent; font-family: inherit; font-size: 13.5px; font-weight: 600; color: var(--text-primary); cursor: pointer; min-width: 0; }
.fc-search { position: relative; display: block; width: 240px; max-width: 100%; }
.fc-search input { width: 100%; height: 38px; padding: 0 12px 0 34px; border-radius: 10px; border: 1px solid #e6e7e2; background: #fff; font-size: 13.5px; font-family: inherit; box-sizing: border-box; }
.fc-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
.fc-bulk { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.fc-vacio { padding: 32px 16px; text-align: center; color: #6E6E66; font-size: 14px; }
.fc-lista { display: flex; flex-direction: column; gap: 10px; }
.fc-card { padding: 14px 16px; }
.fc-card.is-prioridad { border-left: 3px solid #16a34a; }
.fc-top { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.fc-check { width: 18px; height: 18px; margin-top: 3px; accent-color: #16a34a; flex-shrink: 0; }
.fc-quien { flex: 1; min-width: 180px; }
.fc-nom { font-weight: 700; font-size: 15px; }
.fc-mail { font-size: 12.5px; color: var(--text-muted); overflow-wrap: anywhere; }
.fc-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.fc-pill { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
.fc-datos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 18px; margin: 12px 0 0; }
.fc-datos > div { min-width: 0; }
.fc-datos .fc-full { grid-column: 1 / -1; }
.fc-datos dt { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; }
.fc-datos dd { margin: 2px 0 0; font-size: 13.5px; }
.fc-prof { color: #167A2D; font-weight: 600; }
.fc-slots { display: flex; flex-wrap: wrap; gap: 6px; }
.fc-acciones { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.fc-nota { font-size: 13px; color: #1d4ed8; background: rgba(37,99,235,0.07); border-radius: 8px; padding: 6px 10px; }
.fc-msg { margin-top: 10px; font-size: 13px; border-radius: 8px; padding: 8px 12px; }
.fc-msg.ok { background: rgba(30,158,58,0.08); color: #15803d; }
.fc-msg.ko { background: #fdf3f3; color: #8a1f1f; }
.fc-scrim { position: fixed; inset: 0; background: rgba(16,24,16,0.45); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.fc-modal { background: #fff; border-radius: 16px; width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; padding: 20px; box-sizing: border-box; }
.fc-modal-t { font-size: 17px; font-weight: 700; margin: 0; }
.fc-dia { margin-top: 12px; }
.fc-dia-n { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #6E6E66; margin-bottom: 6px; }
.fc-horas { display: flex; flex-wrap: wrap; gap: 6px; }
.fc-hora { min-width: 64px; height: 34px; border-radius: 8px; border: 1px solid #e6e7e2; background: #fff; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.fc-hora.is-on { background: #16a34a; border-color: #16a34a; color: #fff; }
.fc-modal-acc { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
@media (max-width: 720px) {
  .fc-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fc-datos { grid-template-columns: minmax(0, 1fr); }
  .fc-search { width: 100%; }
  .fc-bulk { margin-left: 0; width: 100%; }
}
`;
