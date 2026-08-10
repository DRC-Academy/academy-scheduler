'use client';
// Panel de admin — Validación de transcripciones (Bloque 1).
// Lista las clases marcadas por el sistema (score bajo, flags o IA sospechosa),
// permite ver el texto completo y aprobar/rechazar. Aprobar → cuenta para el pago;
// rechazar → no cuenta y avisa al profesor.
//
// Rediseño (agosto 2026). Qué problema resolvía la versión anterior mal:
//   · Las 117 auto-aprobadas y las 8 pendientes vivían en la MISMA tabla con el
//     mismo peso: la cola de trabajo y el archivo no se distinguían. Ahora las
//     resueltas están en su propia pestaña "Historial", plana y apagada.
//   · Cada fila repetía Ver + Aprobar + Rechazar: 24 botones en pantalla. Ahora
//     la fila tiene UN botón y el resto vive en el desplegable.
//   · Media cola era el mismo motivo y había que resolverla de una en una. Ahora
//     se agrupa por motivo y cada grupo se aprueba en UNA petición en lote.
//   · "Ver" abría un modal que sacaba al admin de la cola para poder decidir.
//     Ahora el porqué y los datos de la clase están en el propio desplegable.
//
// Qué se conserva de la versión anterior (no estaba en el rediseño, pero
// funcionaba y se perdería):
//   · "Marcar para revisión" de una clase auto-aprobada → dentro del modal de la
//     clase, al que ahora se llega pinchando su fila del historial. Es la única
//     vía para sacar algo de 'auto_approved', y sin ella auditar el historial no
//     serviría de nada.
//   · La explicación de por qué las auto-aprobadas están a la vista.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import {
  dbGetFlaggedTranscripts, dbReviewTranscript, dbReviewTranscriptsBulk, dbReopenTranscript,
  dbGetTranscriptText, type FlaggedTranscript,
} from '@/lib/db';
// Los umbrales salen de transcriptValidation (módulo puro), NO de
// transcriptVerdict: ese es 'server-only' y arrastraría el SDK de Anthropic al
// navegador, que es lo que rompía la app tras el login.
import { SCORE_SEVERE, SCORE_AUTO_APPROVE } from '@/lib/transcriptValidation';
import {
  MOTIVO, esMuyDudosa, groupByMotivo, isFiltering, matches, plural,
  scoreColor, sortRows, toRow, toastFor,
  type Filters, type Motivo, type SortKey, type ValRow,
} from '@/lib/validationInbox';
import { HistoryRow, MotivoChip, ValidationRow } from '@/components/admin/validationRows';

const GREEN = '#1E9E3A';

type Vista = 'pend' | 'dud' | 'hist';

/** Filas del historial por página. 117 de golpe es una lista que nadie recorre. */
const HIST_PAGE = 25;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export default function TranscriptValidationTab() {
  const { teachers } = useTeachers();
  const { user } = useAuth();
  const [rows, setRows] = useState<FlaggedTranscript[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingColumns, setMissingColumns] = useState(false);
  const [viewing, setViewing] = useState<FlaggedTranscript | null>(null);
  // El texto ya no viaja en el listado (eran 10,4 MB por abrir la pestaña): se
  // pide de la fila concreta cuando el admin la abre para leerla.
  const [viewingText, setViewingText] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!viewing) return;
    let cancelado = false;
    const id = viewing.id;
    // No hace falta limpiar el texto anterior al abrir otra fila: el render
    // compara `viewingText.id` con la fila abierta, así que un texto viejo nunca
    // se muestra. Limpiarlo acá sería un setState síncrono dentro del efecto.
    dbGetTranscriptText(id).then(text => { if (!cancelado) setViewingText({ id, text }); });
    return () => { cancelado = true; };
  }, [viewing]);

  // ── Estado de la vista ───────────────────────────────────────────────────────
  const [vista, setVista] = useState<Vista>('pend');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');                       // el valor con debounce
  const [prof, setProf] = useState('todos');
  const [agrupar, setAgrupar] = useState(true);
  const [sort, setSort] = useState<SortKey>('score');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [gclosed, setGclosed] = useState<Set<Motivo>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [histShown, setHistShown] = useState(HIST_PAGE);

  const teacherName = (id: string | null) => teachers.find(t => t.id === id)?.name ?? '—';

  // Búsqueda con debounce de 200 ms: filtra sobre más de cien filas en cada
  // pulsación y sin esto se nota al teclear.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 200);
    return () => clearTimeout(t);
  }, [qInput]);

  async function load() {
    setLoading(true);
    const res = await dbGetFlaggedTranscripts();
    setRows(res.rows);
    setMissingColumns(res.missingColumns);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // ── Derivación ───────────────────────────────────────────────────────────────
  const allRows: ValRow[] = useMemo(
    () => rows.map(r => toRow(r, teacherName(r.teacherId))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, teachers],
  );

  const autoAprobadas = useMemo(() => allRows.filter(r => r.status === 'auto_approved'), [allRows]);
  const muyDudosas    = useMemo(() => allRows.filter(esMuyDudosa), [allRows]);
  // "Pendientes" son las que esperan decisión y NO son las muy dudosas (esas
  // tienen su propia pestaña, para que lo urgente no se pierda entre lo normal).
  const pendientes    = useMemo(() => allRows.filter(r => r.status === 'review' && !esMuyDudosa(r)), [allRows]);
  // El historial recoge TODO lo que ya no pide decisión: las auto-aprobadas y
  // las que resolvió una persona. Es lo que antes se mezclaba con la cola.
  const historial     = useMemo(
    () => allRows.filter(r => r.status === 'auto_approved' || r.status === 'approved' || r.status === 'rejected'),
    [allRows],
  );

  const filters: Filters = useMemo(() => ({ q, prof }), [q, prof]);
  const filtering = isFiltering(filters);

  const bucket = vista === 'hist' ? historial : vista === 'dud' ? muyDudosas : pendientes;
  const visible = useMemo(
    () => sortRows(bucket.filter(r => matches(r, filters)), sort),
    [bucket, filters, sort],
  );

  /** Profesores que de verdad tienen filas (el select no lista a los 27). */
  const profOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const r of allRows) if (r.teacherId) ids.add(r.teacherId);
    return teachers.filter(t => ids.has(t.id)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [allRows, teachers]);

  // Los recuentos de grupo se calculan SIEMPRE sobre las filas ya filtradas: si
  // salieran del total, buscar un alumno dejaría cabeceras que dicen "4 clases"
  // sobre un grupo con una sola fila visible.
  const groups = useMemo(
    () => (agrupar && vista !== 'hist' ? groupByMotivo(visible) : []),
    [agrupar, vista, visible],
  );

  // ── Acciones ─────────────────────────────────────────────────────────────────
  const reviewer = user?.displayName ?? 'admin';

  /**
   * Aprueba o rechaza N clases. Actualización OPTIMISTA: la fila sale de la cola
   * al instante y, si la petición falla, se devuelve el estado anterior tal cual
   * estaba. Con 2 o más filas va en UNA sola petición en lote.
   */
  async function decide(targets: ValRow[], decision: 'approved' | 'rejected') {
    if (targets.length === 0) return;
    const ids = targets.map(t => t.id);
    const before = rows;

    setBusy(prev => new Set([...prev, ...ids]));
    const now = new Date().toISOString();
    setRows(prev => prev.map(r => ids.includes(r.id)
      ? { ...r, validationStatus: decision, reviewedBy: reviewer, reviewedAt: now }
      : r));
    // La fila decidida deja de estar abierta y seleccionada: si no, el atajo de
    // teclado seguiría apuntando a una clase que ya no está en la cola.
    setOpen(prev => { const n = new Set(prev); ids.forEach(i => n.delete(i)); return n; });
    setSel(prev => { const n = new Set(prev); ids.forEach(i => n.delete(i)); return n; });

    try {
      const payload = targets.map(t => ({
        id: t.id, teacherId: t.teacherId, studentName: t.studentName, classDate: t.src.classDate,
      }));
      if (payload.length === 1) await dbReviewTranscript(payload[0], decision, reviewer);
      else await dbReviewTranscriptsBulk(payload, decision, reviewer);
      setToast(toastFor(decision, targets.map(t => t.studentName)));
    } catch (e) {
      setRows(before);
      setToast(`No se pudo guardar: ${(e as Error).message}`);
    } finally {
      setBusy(prev => { const n = new Set(prev); ids.forEach(i => n.delete(i)); return n; });
    }
  }

  // Reabrir una auto-aprobada: vuelve a 'review' y deja de contar para el pago
  // hasta que el admin decida.
  async function reopen(row: FlaggedTranscript) {
    const before = rows;
    setBusy(prev => new Set([...prev, row.id]));
    setRows(prev => prev.map(r => r.id === row.id
      ? { ...r, validationStatus: 'review', reviewedBy: reviewer, reviewedAt: new Date().toISOString() }
      : r));
    setViewing(null);
    try {
      await dbReopenTranscript(row.id, reviewer);
      setToast(`Clase de ${row.studentName} devuelta a la cola de revisión.`);
    } catch (e) {
      setRows(before);
      setToast(`No se pudo reabrir: ${(e as Error).message}`);
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(row.id); return n; });
    }
  }

  const toggleIn = (setter: typeof setOpen) => (id: string) =>
    setter(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleOpen = toggleIn(setOpen);
  const toggleSel = toggleIn(setSel);

  /** Pestaña interna: ir siempre a esa vista (pinchar la activa no debe sacarte). */
  function goVista(v: Vista) {
    setVista(v);
    setHistShown(HIST_PAGE);
  }
  /** La tarjeta-resumen es un filtro: lleva a su pestaña y el segundo clic vuelve. */
  function pickVista(v: Vista) {
    setVista(prev => (prev === v ? 'pend' : v));
    setHistShown(HIST_PAGE);
  }

  // ── Atajos A / R ─────────────────────────────────────────────────────────────
  // Solo con EXACTAMENTE una fila desplegada: con dos abiertas no hay forma de
  // saber a cuál se refiere la tecla.
  //
  // Las dos referencias guardan lo ÚLTIMO renderizado para que el listener no
  // haya que resuscribirlo en cada tecleo del buscador. Sin ellas, el listener
  // se quedaría con la lista y el `rows` de cuando se montó, y "deshacer si
  // falla" restauraría un estado viejo.
  const visibleRef = useRef(visible);
  const decideRef = useRef(decide);
  useEffect(() => { visibleRef.current = visible; decideRef.current = decide; });

  const soleOpenId = open.size === 1 ? [...open][0] : null;

  useEffect(() => {
    if (!soleOpenId || vista === 'hist') return;
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key !== 'a' && key !== 'r') return;
      const row = visibleRef.current.find(r => r.id === soleOpenId);
      if (!row) return;
      e.preventDefault();
      decideRef.current([row], key === 'a' ? 'approved' : 'rejected');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [soleOpenId, vista]);

  // ── Render ───────────────────────────────────────────────────────────────────
  const selRows = useMemo(() => visible.filter(r => sel.has(r.id)), [visible, sel]);
  const anyBusy = busy.size > 0;

  const renderRow = (r: ValRow) => (
    <ValidationRow
      key={r.id}
      row={r}
      open={open.has(r.id)}
      selected={sel.has(r.id)}
      busy={busy.has(r.id)}
      onToggle={() => toggleOpen(r.id)}
      onSelect={() => toggleSel(r.id)}
      onApprove={() => decide([r], 'approved')}
      onReject={() => decide([r], 'rejected')}
      onViewFull={() => setViewing(r.src)}
      onFilterTeacher={() => { if (r.teacherId) setProf(r.teacherId); }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Transcripciones pendientes de revisión</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
          Clases marcadas por el sistema por baja confianza estructural, señales cruzadas o análisis de IA.
        </div>
      </div>

      {/* ── 1 · Tarjetas-resumen, ahora filtros ── */}
      <div className="rk-cards">
        <SummaryCard
          n={autoAprobadas.length} color={GREEN}
          label={`Aprobadas automáticamente (score ≥ ${SCORE_AUTO_APPROVE})`}
          aux={`score ≥ ${SCORE_AUTO_APPROVE}`}
          active={vista === 'hist'} onClick={() => pickVista('hist')}
        />
        <SummaryCard
          n={pendientes.length} color="#b45309"
          label="Pendientes de revisión" aux="requieren decisión"
          active={vista === 'pend'} onClick={() => pickVista('pend')}
        />
        <SummaryCard
          n={muyDudosas.length} color="#dc2626"
          label={`Muy dudosas (score < ${SCORE_SEVERE})`}
          aux={`score < ${SCORE_SEVERE}`}
          active={vista === 'dud'} onClick={() => pickVista('dud')}
        />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Cargando…</div>
      ) : missingColumns ? (
        <div style={{
          border: '1px solid rgba(255,196,0,0.5)', background: 'rgba(255,196,0,0.1)',
          borderRadius: 10, padding: '14px 16px', fontSize: 13, color: '#8A6A00', lineHeight: 1.65,
        }}>
          <b>Falta la migración de validación.</b> La columna <code>validation_status</code> no existe en
          la base, así que esta pestaña no puede mostrar nada todavía. Corré{' '}
          <code>supabase-transcript-validation.sql</code> en el editor SQL de Supabase. Las clases que se
          registren después de correrla aparecerán acá automáticamente.
        </div>
      ) : (
        /* ── 2 · Card única con tres pestañas ── */
        <div style={cardBox}>
          <div style={{ display: 'flex', gap: 2, padding: '0 16px', borderBottom: '1px solid #edefea', overflowX: 'auto' }} role="tablist">
            <InnerTabBtn id="pend" active={vista} onPick={goVista} label="Por revisar"  badge={pendientes.length} />
            <InnerTabBtn id="dud"  active={vista} onPick={goVista} label="Muy dudosas"  badge={muyDudosas.length} />
            <InnerTabBtn id="hist" active={vista} onPick={goVista} label="Historial"    badge={historial.length} />
          </div>

          {/* ── 3 · Barra de herramientas (compartida por las tres pestañas) ── */}
          <div className="rk-toolbar" style={{ padding: '13px 18px', background: '#fbfcfa', borderBottom: '1px solid #edefea' }}>
            <div style={{ position: 'relative', width: 270, maxWidth: '100%' }}>
              <span aria-hidden style={{ position: 'absolute', left: 11, top: 8, fontSize: 13, color: '#9aa79f' }}>⌕</span>
              <input
                value={qInput}
                onChange={e => setQInput(e.target.value)}
                placeholder="Buscar alumno o profesor"
                aria-label="Buscar alumno o profesor"
                style={{ ...control, width: '100%', paddingLeft: 28 }}
              />
            </div>
            <select value={prof} onChange={e => setProf(e.target.value)} aria-label="Filtrar por profesor" style={{ ...control, fontWeight: 600 }}>
              <option value="todos">Todos los profesores</option>
              {profOptions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button
              type="button"
              onClick={() => setAgrupar(v => !v)}
              aria-pressed={agrupar}
              disabled={vista === 'hist'}
              title={vista === 'hist' ? 'El historial va siempre en lista plana' : undefined}
              style={{
                ...control, cursor: vista === 'hist' ? 'not-allowed' : 'pointer', fontWeight: 700,
                opacity: vista === 'hist' ? 0.5 : 1,
                background: agrupar ? '#eaf5ee' : '#fff',
                border: `1px solid ${agrupar ? '#cfe8d8' : '#e2e5df'}`,
                color: agrupar ? '#0d7a39' : '#3f4c45',
              }}
            >
              Agrupar por motivo
            </button>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {vista !== 'hist' && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#8a9790' }}>
                  <Key>A</Key> aprobar
                  <span aria-hidden>·</span>
                  <Key>R</Key> rechazar
                </span>
              )}
              <select
                value={sort}
                onChange={e => setSort(e.target.value as SortKey)}
                aria-label="Ordenar por"
                style={{ ...control, fontSize: 13, fontWeight: 600 }}
              >
                <option value="score">Score más bajo</option>
                <option value="fecha">Más reciente</option>
                <option value="prof">Profesor</option>
              </select>
            </div>
          </div>

          {/* ── 11 · Confirmación ── */}
          {toast && (
            <div role="status" aria-live="polite" style={{
              display: 'flex', alignItems: 'center', gap: 10, margin: '14px 18px 0',
              background: '#eaf5ee', border: '1px solid #cfe8d8', borderRadius: 10, padding: '10px 14px',
            }}>
              <span aria-hidden style={{ color: '#0d7a39', fontWeight: 800, fontSize: 13 }}>✓</span>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#136b34' }}>{toast}</div>
              <button type="button" onClick={() => setToast(null)} aria-label="Cerrar aviso"
                style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#5c7a67', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                ✕
              </button>
            </div>
          )}

          {/* ── 7 · Selección múltiple ── */}
          {selRows.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '14px 18px 0',
              background: '#f2f6f3', border: '1px solid #dde5df', borderRadius: 10, padding: '10px 14px',
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#2b3a32' }}>
                {plural(selRows.length, 'clase seleccionada', 'clases seleccionadas')}
              </div>
              <button type="button" disabled={anyBusy} onClick={() => decide(selRows, 'approved')}
                style={{ background: '#12a04b', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: anyBusy ? 0.6 : 1 }}>
                Aprobar
              </button>
              <button type="button" disabled={anyBusy} onClick={() => decide(selRows, 'rejected')}
                style={{ background: '#fff', color: '#a52b23', border: '1px solid #f3cfca', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: anyBusy ? 0.6 : 1 }}>
                Rechazar
              </button>
              <button type="button" onClick={() => setSel(new Set())}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 12.5, fontWeight: 700, color: '#6b7a70', cursor: 'pointer', fontFamily: 'inherit' }}>
                Quitar selección
              </button>
            </div>
          )}

          {/* ── 9 · Historial ── */}
          {vista === 'hist' ? (
            <HistorialTab
              rows={visible}
              shown={histShown}
              onShowMore={() => setHistShown(n => n + HIST_PAGE)}
              onOpen={r => setViewing(r.src)}
              filtering={filtering}
            />
          ) : visible.length === 0 ? (
            /* ── 10 · Estado final y estados vacíos ── */
            <div style={{ padding: '56px 18px', textAlign: 'center' }}>
              <div aria-hidden style={{ fontSize: 24, lineHeight: 1 }}>✓</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#136b34', marginTop: 10 }}>
                No queda nada por validar
              </div>
              <div style={{ fontSize: 13, color: '#7d8b83', marginTop: 6 }}>
                {filtering
                  ? 'Ninguna clase coincide con los filtros activos.'
                  : 'Todas las clases marcadas están resueltas.'}
              </div>
            </div>
          ) : agrupar ? (
            /* ── 4 · Agrupación por motivo ── */
            <div style={{ padding: '2px 0 6px' }}>
              {groups.map(g => {
                const m = MOTIVO[g.motivo];
                const cerrado = gclosed.has(g.motivo);
                const puedeLote = vista === 'pend' && g.rows.length >= 2;
                return (
                  <div key={g.motivo}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={!cerrado}
                      aria-controls={`vl-group-${g.motivo}`}
                      onClick={() => setGclosed(prev => {
                        const n = new Set(prev);
                        if (n.has(g.motivo)) n.delete(g.motivo); else n.add(g.motivo);
                        return n;
                      })}
                      onKeyDown={e => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        setGclosed(prev => {
                          const n = new Set(prev);
                          if (n.has(g.motivo)) n.delete(g.motivo); else n.add(g.motivo);
                          return n;
                        });
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap',
                        padding: '12px 18px', background: '#fcfdfb', border: '1px solid #f1f3ef',
                        fontFamily: 'inherit', cursor: 'pointer',
                      }}
                    >
                      <span aria-hidden style={{ fontSize: 12, fontWeight: 800, color: '#9aa79f' }}>
                        {cerrado ? '▸' : '▾'}
                      </span>
                      <MotivoChip motivo={g.motivo} />
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: '#22302a' }}>{m.titulo}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: '#8a9790' }}>
                        {plural(g.rows.length, 'clase', 'clases')}
                      </span>
                      {puedeLote && (
                        <button
                          type="button"
                          disabled={anyBusy}
                          // stopPropagation: aprobar el grupo no debe además plegarlo.
                          onClick={e => { e.stopPropagation(); decide(g.rows, 'approved'); }}
                          style={{
                            marginLeft: 'auto', background: '#fff', border: '1px solid #cfe8d8',
                            color: '#0d7a39', borderRadius: 9, padding: '7px 12px', fontSize: 12.5,
                            fontWeight: 800, fontFamily: 'inherit', cursor: 'pointer',
                            whiteSpace: 'nowrap', opacity: anyBusy ? 0.6 : 1,
                          }}
                        >
                          Aprobar las {g.rows.length}
                        </button>
                      )}
                    </div>
                    {!cerrado && <div id={`vl-group-${g.motivo}`}>{g.rows.map(renderRow)}</div>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: '2px 0 6px' }}>{visible.map(renderRow)}</div>
          )}
        </div>
      )}

      {viewing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setViewing(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{viewing.studentName} · {fmtDate(viewing.classDate)}</div>
                <div style={{ fontSize: 12.5, color: '#6b7280' }}>
                  {teacherName(viewing.teacherId)} · Score <b style={{ color: scoreColor(viewing.score) }}>{viewing.score ?? '—'}/100</b>
                </div>
              </div>
              <button onClick={() => setViewing(null)} aria-label="Cerrar" style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
            </div>
            <div style={{ padding: '16px 22px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, color: '#1a1c1a', fontFamily: 'ui-monospace, monospace' }}>
              {viewingText?.id === viewing.id
                ? (viewingText.text || '(esta clase no tiene texto guardado)')
                : <span style={{ color: '#6b7280', fontFamily: 'inherit' }}>Cargando transcripción…</span>}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {viewing.validationStatus === 'auto_approved' ? (
                <button onClick={() => reopen(viewing)} disabled={busy.has(viewing.id)} style={modalBtn('ghost')}>
                  Marcar para revisión
                </button>
              ) : viewing.validationStatus === 'review' ? (
                <>
                  <button
                    onClick={() => { const r = allRows.find(x => x.id === viewing.id); setViewing(null); if (r) decide([r], 'rejected'); }}
                    disabled={busy.has(viewing.id)} style={modalBtn('red')}
                  >
                    Rechazar
                  </button>
                  <button
                    onClick={() => { const r = allRows.find(x => x.id === viewing.id); setViewing(null); if (r) decide([r], 'approved'); }}
                    disabled={busy.has(viewing.id)} style={modalBtn('green')}
                  >
                    Aprobar y contar
                  </button>
                </>
              ) : (
                <span style={{ fontSize: 12.5, color: '#6b7280', alignSelf: 'center' }}>
                  Clase ya resuelta{viewing.reviewedBy ? ` por ${viewing.reviewedBy}` : ''}.
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ Historial ═════════════════════════════════════════════════════════════════
function HistorialTab({ rows, shown, onShowMore, onOpen, filtering }: {
  rows: ValRow[]; shown: number; onShowMore: () => void;
  onOpen: (r: ValRow) => void; filtering: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: '44px 18px', textAlign: 'center', fontSize: 14, color: '#7d8b83', fontWeight: 600 }}>
        {filtering
          ? 'Ninguna clase coincide con los filtros activos.'
          : 'Todavía no hay clases resueltas.'}
      </div>
    );
  }
  const visible = rows.slice(0, shown);
  const hidden = rows.length - visible.length;

  return (
    <div>
      <div style={{ padding: '13px 18px', fontSize: 12.5, color: '#8a9790', lineHeight: 1.6, borderBottom: '1px solid #f1f3ef' }}>
        Lo que ya no pide decisión. Las aprobadas automáticamente pasaron la validación con{' '}
        {SCORE_AUTO_APPROVE} puntos o más y sin ninguna señal: ya cuentan para el pago y están aquí
        solo para que puedas auditarlas. Abre una clase para leerla y, si te llama la atención,
        devolverla a la cola.
      </div>
      <div className="vl-hist-head">
        <div>Alumno</div>
        <div className="vl-alert">Motivo</div>
        <div>Score</div>
        <div>Fecha</div>
        <div>Estado</div>
      </div>
      {visible.map(r => (
        // Fila del historial: sin acciones, pero abrible. Es la única vía que
        // queda para auditar una auto-aprobada y devolverla a la cola.
        <div
          key={r.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(r)}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return;
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            onOpen(r);
          }}
          style={{ cursor: 'pointer' }}
        >
          <HistoryRow row={r} />
        </div>
      ))}
      {hidden > 0 && (
        <div style={{ padding: '14px 18px' }}>
          <button type="button" onClick={onShowMore} style={{
            background: 'none', border: 'none', padding: 0, fontSize: 13, fontWeight: 700,
            color: '#0d7a39', fontFamily: 'inherit', cursor: 'pointer',
          }}>
            Ver las {hidden} anteriores
          </button>
        </div>
      )}
    </div>
  );
}

// ═══ Tarjeta-resumen ═══════════════════════════════════════════════════════════
function SummaryCard({ n, color, label, aux, active, onClick }: {
  n: number; color: string; label: string; aux: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'left',
        background: 'var(--bg-surface)', borderRadius: 14, padding: '15px 18px', cursor: 'pointer',
        fontFamily: 'inherit', transition: 'box-shadow .15s, border-color .15s',
        border: active ? '1.5px solid #12a04b' : '1px solid #e7e9e4',
        boxShadow: active ? '0 0 0 3px rgba(18,160,75,.12)' : '0 1px 2px rgba(24,38,28,.05)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 32, fontWeight: 800, color, lineHeight: 1 }}>{n}</span>
        <span style={{ fontSize: 12, color: '#7d8b83', fontWeight: 600 }}>{aux}</span>
      </span>
      <span style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-muted)' }}>{label}</span>
    </button>
  );
}

// ═══ Pestaña interna ═══════════════════════════════════════════════════════════
function InnerTabBtn({ id, active, onPick, label, badge }: {
  id: Vista; active: Vista; onPick: (v: Vista) => void; label: string; badge: number;
}) {
  const on = active === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={() => onPick(id)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '14px 15px', fontSize: 14,
        background: 'none', border: 'none', fontFamily: 'inherit', cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontWeight: on ? 800 : 600, color: on ? '#0d7a39' : '#6b7a70',
        boxShadow: on ? 'inset 0 -2px 0 #12a04b' : 'none',
      }}
    >
      {label}
      <span style={{
        fontSize: 11.5, fontWeight: 800, borderRadius: 999, padding: '1px 8px',
        background: on ? '#eaf5ee' : '#f2f4f1',
        border: `1px solid ${on ? '#cfe8d8' : '#e6e9e4'}`,
        color: on ? '#0d7a39' : '#7d8b83',
      }}>
        {badge}
      </span>
    </button>
  );
}

/** Tecla del recordatorio de atajos. */
function Key({ children }: { children: string }) {
  return (
    <kbd style={{
      background: '#fff', border: '1px solid #e2e5df', borderRadius: 5, padding: '1px 6px',
      fontFamily: 'inherit', fontSize: 11, fontWeight: 800, color: '#5c6a62',
    }}>
      {children}
    </kbd>
  );
}

// ═══ Estilos compartidos ═══════════════════════════════════════════════════════
const cardBox: CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid #e7e9e4', borderRadius: 16,
  boxShadow: '0 1px 2px rgba(24,38,28,.05)', overflow: 'hidden',
};
const control: CSSProperties = {
  border: '1px solid #e2e5df', borderRadius: 9, padding: '8px 12px',
  fontSize: 13.5, color: '#1d2622', background: '#fff', fontFamily: 'inherit',
  boxSizing: 'border-box',
};

function modalBtn(kind: 'ghost' | 'green' | 'red'): CSSProperties {
  const base: CSSProperties = {
    padding: '9px 18px', borderRadius: 8, cursor: 'pointer',
    fontSize: 13, fontWeight: 700, fontFamily: 'inherit', border: 'none',
  };
  if (kind === 'ghost') return { ...base, border: '1px solid var(--border)', background: 'white', color: '#374151' };
  if (kind === 'green') return { ...base, background: GREEN, color: 'white' };
  return { ...base, background: 'white', border: '1px solid #f0c4bd', color: '#c0392b' };
}
