'use client';

// Pestaña admin "Tests de nivel": seguimiento del formulario inicial y de la
// prueba de nivel, ALUMNO POR ALUMNO.
//
// Rediseño de septiembre de 2026 (lienzo aprobado por Facundo). Lo que quería
// leer de un vistazo: en qué fecha recibió cada alumno el enlace, en qué fecha
// hizo el formulario y en qué fecha completó la prueba; y una sola etiqueta
// que diga si está parado. Por eso:
//   · Una fila por alumno (no por sesión de test), con las tres fechas en el
//     mismo orden: Enviado · Formulario · Prueba. Las arma lib/levelTestSeguimiento
//     con el MISMO criterio que el cron de recordatorios.
//   · Una sola etiqueta: "Parado N d" (rojo), "Falta la prueba / el formulario"
//     (ámbar), "Enviado hoy" (gris), "Completada" (verde), "Caducado", "Baja".
//   · Cuatro filtros: Parados · En marcha · Completadas · Todos.
//   · De la más reciente a la más antigua (pedido expreso).
//   · Un solo botón por alumno pendiente, "Recordar", que manda el siguiente
//     recordatorio ya, fuera de la cadencia del cron (/api/forms/remind). En
//     escritorio se pueden marcar varios y mandarlos de una vez.
//   · El detalle es una pantalla propia en el teléfono y un panel lateral en
//     escritorio: las mismas filas con fecha, el resultado por destreza si
//     completó, y los recordatorios enviados si no.
//
// Un solo DOM para los dos tamaños: la fila de escritorio se convierte en
// tarjeta por debajo de 768 px solo con CSS (ver ESTILOS).

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, Plus, Search, Send, X, CheckCircle2, Link2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  fetchLevelTestIndex, generateTestLink, buildTestUrl, testStateOf, type LevelTestInfo,
} from '@/lib/levelTestClient';
import { buildFormUrl } from '@/lib/formClient';
import {
  norm, tokenStateOf, MAX_REMINDERS,
  type FormTokenRow, type StudentRow, type DropoutRow,
} from '@/lib/formReminders';
import {
  construirSeguimiento, pasaFiltro, buscaEn, etiquetaDe, filtroDe, resumenSeguimiento,
  DIAS_PARADO, MOTIVO_MANUAL,
  type Seguimiento, type Filtro, type Tono, type ResultadoManual,
} from '@/lib/levelTestSeguimiento';
import type { WritingEvaluation } from '@/lib/levelTest/types';
import { CEFR_COLOR, GRAND_TOTAL, scoreToCefr } from '@/lib/levelTest/constants';
import { INVALID_REASON_LABEL } from '@/lib/levelTest/attemptValidity';

// ── Fechas ───────────────────────────────────────────────────────────────────
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "hoy", "ayer", "28 ago" o "28 ago 2025" si es de otro año. */
function fmtCorta(iso: string | null, ahora: number): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const hoy = new Date(ahora);
  const ayer = new Date(ahora - 86_400_000);
  if (d.toDateString() === hoy.toDateString()) return 'hoy';
  if (d.toDateString() === ayer.toDateString()) return 'ayer';
  const otroAnio = d.getFullYear() !== hoy.getFullYear();
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', ...(otroAnio ? { year: 'numeric' } : {}) }).replace('.', '');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── Nivel confirmado por el profesor ─────────────────────────────────────────
interface ConfirmedLevel { level: string; at: string | null; by: string | null }

interface ProfileLevelRow {
  student_id: string | null;
  student_name: string | null;
  teacher_confirmed_level: string | null;
  teacher_confirmed_at: string | null;
  teacher_confirmed_by: string | null;
}

const TONO_TAG: Record<Tono, 'rojo' | 'ambar' | 'gris' | 'ok'> = {
  rojo: 'rojo', caducado: 'rojo', ambar: 'ambar', gris: 'gris', ok: 'ok', baja: 'gris',
};

const FILTROS: Array<{ id: Filtro; label: string }> = [
  { id: 'parados',     label: 'Parados' },
  { id: 'enmarcha',    label: 'En marcha' },
  { id: 'completadas', label: 'Completadas' },
  { id: 'todos',       label: 'Todos' },
];

/** Enlace que se le puede copiar al alumno: el del formulario si le falta, si no el de la prueba vigente. */
function enlaceDe(e: Seguimiento, ahora: number): string | null {
  if (e.tono === 'ok' || e.tono === 'baja') return null;
  if (e.pendiente?.sequence === 'formulario' && e.token) return buildFormUrl(e.token.token);
  if (e.sesion && ['pending', 'in_progress'].includes(testStateOf(e.sesion))) return buildTestUrl(e.sesion.token);
  if (e.token && !e.formulario && tokenStateOf(e.token, ahora) === 'pending') return buildFormUrl(e.token.token);
  return null;
}

async function pedirRecordatorios(tokenIds: string[]): Promise<ResultadoManual[]> {
  const res = await fetch('/api/forms/remind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokenIds }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo enviar el recordatorio.');
  return (data.resultados ?? []) as ResultadoManual[];
}

function resumenEnvio(rs: ResultadoManual[]): { ok: boolean; texto: string } {
  const ok = rs.filter(r => r.ok);
  const mal = rs.filter(r => !r.ok);
  if (rs.length === 1) {
    const r = rs[0];
    return r.ok
      ? { ok: true, texto: `Recordatorio enviado a ${r.alumno} (${r.paso}).` }
      : { ok: false, texto: `No se envió a ${r.alumno ?? 'este alumno'}: ${MOTIVO_MANUAL[r.motivo ?? 'envío']}.` };
  }
  const detalle = mal.length ? ` Sin enviar: ${mal.map(r => `${r.alumno ?? '?'} (${MOTIVO_MANUAL[r.motivo ?? 'envío']})`).join(', ')}.` : '';
  return { ok: ok.length > 0, texto: `Enviados ${ok.length} de ${rs.length}.${detalle}` };
}

// ═════════════════════════════════════════════════════════════════════════════
export default function LevelTestsTab() {
  const [filas, setFilas] = useState<Seguimiento[]>([]);
  const [loading, setLoading] = useState(true);
  const [faltaSql, setFaltaSql] = useState(false);
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [query, setQuery] = useState('');
  const [showGen, setShowGen] = useState(false);
  /** Clave del alumno abierto en el detalle. */
  const [abierta, setAbierta] = useState<string | null>(null);
  /** Claves marcadas para el envío en lote (solo escritorio, solo recordables). */
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  // Nivel confirmado por cada profesor, indexado tolerante (id → nombre).
  const [confirmados, setConfirmados] = useState<Map<string, ConfirmedLevel>>(new Map());
  // El "ahora" se congela en la carga: leerlo en cada render movería las
  // etiquetas solas entre renders, y el linter de pureza lo prohíbe con razón.
  const [ahora, setAhora] = useState(0);

  async function load(silencioso = false) {
    if (!silencioso) setLoading(true);
    const now = Date.now();
    setAhora(now);
    const [idx, stRes, tkRes, drRes, spRes] = await Promise.all([
      fetchLevelTestIndex(),
      supabase.from('students').select('id, name, email'),
      supabase.from('form_tokens').select('id, token, student_id, student_name, student_email, teacher_id, teacher_name, assignment_id, plan, level, status, created_at, completed_at, expires_at, form_reminder_count, form_reminder_last_sent, test_reminder_count, test_reminder_last_sent, reminder_variant'),
      supabase.from('student_dropouts').select('student_id, student_name'),
      // Si supabase-teacher-level.sql no se corrió, esta consulta falla con
      // 42703 y el nivel del profesor queda vacío. La pestaña sigue funcionando.
      supabase.from('student_profiles').select('student_id, student_name, teacher_confirmed_level, teacher_confirmed_at, teacher_confirmed_by'),
    ]);

    const confMap = new Map<string, ConfirmedLevel>();
    for (const row of (spRes.data ?? []) as unknown as ProfileLevelRow[]) {
      if (!row.teacher_confirmed_level) continue;
      const info: ConfirmedLevel = { level: row.teacher_confirmed_level, at: row.teacher_confirmed_at ?? null, by: row.teacher_confirmed_by ?? null };
      if (row.student_id) confMap.set(`id:${row.student_id}`, info);
      if (row.student_name) confMap.set(`nm:${norm(row.student_name)}`, info);
    }
    setConfirmados(confMap);

    // Sin las columnas del follow-up (migración sin correr) se listan solo las
    // pruebas, sin formulario ni recordatorios, y se avisa arriba.
    setFaltaSql(!!tkRes.error);
    setFilas(construirSeguimiento({
      tokens:   tkRes.error ? [] : ((tkRes.data ?? []) as unknown as FormTokenRow[]),
      sessions: idx.all as LevelTestInfo[],
      students: (stRes.data ?? []) as unknown as StudentRow[],
      dropouts: (drRes.data ?? []) as unknown as DropoutRow[],
      now,
    }));
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  const nivelProfesorOf = (e: Seguimiento): ConfirmedLevel | undefined =>
    (e.studentId ? confirmados.get(`id:${e.studentId}`) : undefined) ?? confirmados.get(`nm:${norm(e.nombre)}`);

  const visibles = useMemo(
    () => filas.filter(e => pasaFiltro(e, filtro) && buscaEn(e, query)),
    [filas, filtro, query],
  );
  const conteo = useMemo(() => {
    const c: Record<Filtro, number> = { parados: 0, enmarcha: 0, completadas: 0, todos: filas.length };
    for (const e of filas) { const f = filtroDe(e.tono); if (f) c[f]++; }
    return c;
  }, [filas]);
  const resumen = useMemo(() => resumenSeguimiento(filas, ahora), [filas, ahora]);
  const actual = abierta ? filas.find(e => e.clave === abierta) ?? null : null;
  const seleccionadas = filas.filter(e => seleccion.has(e.clave) && e.recordable);

  async function recordar(entradas: Seguimiento[]) {
    const ids = entradas.map(e => e.token?.id).filter((x): x is string => !!x);
    if (!ids.length || enviando) return;
    setEnviando(true);
    setAviso(null);
    try {
      setAviso(resumenEnvio(await pedirRecordatorios(ids)));
      setSeleccion(new Set());
      await load(true);
    } catch (err) {
      setAviso({ ok: false, texto: err instanceof Error ? err.message : 'No se pudo enviar.' });
    } finally {
      setEnviando(false);
    }
  }

  function copiar(url: string) {
    navigator.clipboard?.writeText(url)
      .then(() => setAviso({ ok: true, texto: 'Enlace copiado.' }))
      .catch(() => setAviso({ ok: false, texto: 'No se pudo copiar el enlace.' }));
  }

  const alternar = (clave: string) => setSeleccion(prev => {
    const s = new Set(prev);
    if (s.has(clave)) s.delete(clave); else s.add(clave);
    return s;
  });

  const pct = (n: number) => resumen.enviadas30 > 0 ? `${Math.round((n / resumen.enviadas30) * 100)} % de las enviadas` : 'sin enlaces este mes';

  return (
    <div className={`tn${actual ? ' tn-abierta' : ''}`}>
      {/* ── Cabecera (el título en el teléfono lo pone la barra de Admin) ── */}
      <div className="tn-head">
        <div className="tn-titulo">
          <h2 className="tn-title">Tests de nivel</h2>
          <p className="tn-sub">Seguimiento del formulario y la prueba de cada alumno nuevo. Los más recientes, primero.</p>
        </div>
        <button className="adm-btn adm-btn-primary" onClick={() => setShowGen(true)}>
          <Plus size={16} strokeWidth={2.5} aria-hidden /> Generar link
        </button>
      </div>

      {faltaSql && (
        <div className="tn-aviso mal" role="status">
          El follow-up automático todavía no está activo: falta ejecutar <b>supabase-form-reminders.sql</b> en Supabase. Mientras tanto solo se listan las pruebas, sin formulario ni recordatorios.
        </div>
      )}
      {aviso && (
        <div className={`tn-aviso ${aviso.ok ? 'ok' : 'mal'}`} role="status">
          <span style={{ flex: 1 }}>{aviso.texto}</span>
          <button type="button" className="tn-btn-ic" onClick={() => setAviso(null)} aria-label="Cerrar aviso"><X size={16} /></button>
        </div>
      )}

      {/* ── Cifras (solo escritorio) ── */}
      {!loading && filas.length > 0 && (
        <div className="tn-kpis">
          <div className="adm-card tn-kpi"><div className="tn-kpi-l">Enviadas</div><div className="tn-kpi-v">{resumen.enviadas30}</div><div className="tn-kpi-s">en los últimos 30 días</div></div>
          <div className="adm-card tn-kpi"><div className="tn-kpi-l">Formulario hecho</div><div className="tn-kpi-v">{resumen.formulario30}</div><div className="tn-kpi-s">{pct(resumen.formulario30)}</div></div>
          <div className="adm-card tn-kpi"><div className="tn-kpi-l">Prueba completada</div><div className="tn-kpi-v">{resumen.prueba30}</div><div className="tn-kpi-s">{pct(resumen.prueba30)}</div></div>
          <div className="adm-card tn-kpi">
            <div className="tn-kpi-l">Parados más de {DIAS_PARADO} días</div>
            <div className="tn-kpi-v" style={{ color: resumen.parados > 0 ? '#C81E1E' : undefined }}>{resumen.parados}</div>
            <div className="tn-kpi-s">{resumen.parados > 0 ? 'sin avances ni respuesta a los recordatorios' : 'nadie lleva más de una semana parado'}</div>
          </div>
        </div>
      )}

      <div className={`tn-split${actual ? ' abierta' : ''}`}>
        {/* ── Lista ── */}
        <div className="adm-card tn-lista">
          <div className="tn-lh">
            <label className="tn-search">
              <Search size={18} strokeWidth={2} aria-hidden />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar por nombre o email…" aria-label="Buscar alumno" />
            </label>
            <div className="tn-chips" role="group" aria-label="Filtrar">
              {FILTROS.map(f => (
                <button key={f.id} type="button" className="tn-chip" aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>
                  {f.label}<span className={`n${f.id === 'parados' && conteo.parados > 0 && filtro !== f.id ? ' rojo' : ''}`}>{conteo[f.id]}</span>
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="tn-vacio"><div className="tn-vacio-s">Cargando…</div></div>
          ) : filas.length === 0 ? (
            <div className="tn-vacio">
              <span style={{ color: '#6E6E66' }}><Link2 size={36} strokeWidth={1.75} aria-hidden /></span>
              <div className="tn-vacio-t">Sin pruebas todavía</div>
              <div className="tn-vacio-s">Generá el primer enlace y aparecerá aquí con su seguimiento.</div>
              <button className="adm-btn adm-btn-primary" style={{ marginTop: 8 }} onClick={() => setShowGen(true)}><Plus size={16} strokeWidth={2.5} aria-hidden /> Generar link</button>
            </div>
          ) : visibles.length === 0 && filtro === 'parados' && !query.trim() ? (
            <div className="tn-vacio">
              <span style={{ color: '#1E9E3A' }}><CheckCircle2 size={40} strokeWidth={1.75} aria-hidden /></span>
              <div className="tn-vacio-t">Nadie parado</div>
              <div className="tn-vacio-s">Nadie lleva más de {DIAS_PARADO} días sin avanzar. Los recordatorios salen solos a los 2, 5 y 10 días.</div>
              <button className="adm-btn adm-btn-ghost" style={{ marginTop: 6, border: 0, color: '#167A2D' }} onClick={() => setFiltro('enmarcha')}>
                Ver los que están en marcha <ChevronRight size={16} aria-hidden />
              </button>
            </div>
          ) : visibles.length === 0 ? (
            <div className="tn-vacio"><div className="tn-vacio-s">Sin resultados para estos filtros.</div></div>
          ) : (
            <>
              <div className="tn-row head" aria-hidden>
                <span /><span>Alumno</span><span>Enviado</span><span>Formulario</span><span>Prueba</span><span>Nivel</span><span>Estado</span>
              </div>
              {visibles.map(e => (
                <Fila key={e.clave} e={e} ahora={ahora}
                  profe={nivelProfesorOf(e)}
                  actual={abierta === e.clave}
                  marcada={seleccion.has(e.clave)}
                  enviando={enviando}
                  onAbrir={() => setAbierta(e.clave)}
                  onMarcar={() => alternar(e.clave)}
                  onRecordar={() => recordar([e])} />
              ))}
              {seleccionadas.length > 0 && (
                <div className="tn-lote">
                  {seleccionadas.length} seleccionado{seleccionadas.length !== 1 ? 's' : ''}
                  <button className="adm-btn adm-btn-primary" style={{ padding: '7px 12px', fontSize: 13 }} disabled={enviando} onClick={() => recordar(seleccionadas)}>
                    <Send size={15} aria-hidden /> {enviando ? 'Enviando…' : `Enviar recordatorio a los ${seleccionadas.length}`}
                  </button>
                  <button className="adm-btn adm-btn-ghost" style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: '#167A2D', padding: '7px 8px', fontSize: 13 }} onClick={() => setSeleccion(new Set())}>
                    <X size={15} aria-hidden /> Quitar selección
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Detalle: pantalla propia en el teléfono, panel al lado en escritorio ── */}
        {actual ? (
          <div className="adm-card tn-panel">
            <button type="button" className="tn-back" onClick={() => setAbierta(null)}>
              <ChevronLeft size={20} strokeWidth={2.25} aria-hidden /> Lista de alumnos
            </button>
            <Detalle e={actual} ahora={ahora} profe={nivelProfesorOf(actual)} enviando={enviando}
              onCerrar={() => setAbierta(null)}
              onRecordar={() => recordar([actual])}
              onCopiar={copiar} />
          </div>
        ) : (
          <div className="adm-card tn-panel vacio">Elegí un alumno de la lista para ver su detalle.</div>
        )}
      </div>

      {showGen && <GenerateModal onClose={() => setShowGen(false)} onDone={() => { setShowGen(false); load(true); }} />}
      <style>{ESTILOS}</style>
    </div>
  );
}

// ── Una fila (escritorio) / una tarjeta (teléfono) ───────────────────────────
function Fila({ e, ahora, profe, actual, marcada, enviando, onAbrir, onMarcar, onRecordar }: {
  e: Seguimiento; ahora: number; profe?: ConfirmedLevel;
  actual: boolean; marcada: boolean; enviando: boolean;
  onAbrir: () => void; onMarcar: () => void; onRecordar: () => void;
}) {
  const tag = TONO_TAG[e.tono];
  const cls = ['tn-row', actual ? 'is-cur' : '', marcada ? 'is-sel' : '', tag === 'rojo' ? 'rojo' : '', e.tono === 'baja' ? 'baja' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="button" tabIndex={0} onClick={onAbrir}
      onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onAbrir(); } }}>
      <button type="button" className={`tn-cb${marcada ? ' on' : ''}`} disabled={!e.recordable}
        aria-label={marcada ? 'Quitar de la selección' : 'Seleccionar para recordar'} aria-pressed={marcada}
        onClick={ev => { ev.stopPropagation(); onMarcar(); }}>
        {marcada && <Check size={14} strokeWidth={3} aria-hidden />}
      </button>
      <div className="tn-name" title={e.email ?? undefined}>{e.nombre}</div>
      <div className="tn-fechas">
        <Fecha label="Enviado" iso={e.enviado} ahora={ahora} />
        <Fecha label="Formulario" iso={e.formulario} ahora={ahora} />
        <Fecha label="Prueba" iso={e.prueba} ahora={ahora} />
      </div>
      <div className="tn-nivel">
        {e.cefr ? <Cefr nivel={e.cefr} /> : <span className="tn-profe" style={{ color: '#a4a7a1' }}>—</span>}
        {e.cefr && profe && <span className="tn-tag ok tn-profe" title={`Nivel confirmado por el profesor${profe.at ? ` el ${fmtDate(profe.at)}` : ''}`}>Profe {profe.level}</span>}
      </div>
      <div className="tn-estado"><span className={`tn-tag ${tag}`}>{etiquetaDe(e)}</span></div>
      <span className="tn-chev" aria-hidden><ChevronRight size={18} strokeWidth={2} /></span>
      {e.recordable && e.tono !== 'gris' && (
        <div className="tn-act">
          <button className={`adm-btn ${tag === 'rojo' ? 'adm-btn-primary' : 'adm-btn-ghost'}`} disabled={enviando}
            onClick={ev => { ev.stopPropagation(); onRecordar(); }}>
            <Send size={15} aria-hidden /> Recordar
          </button>
        </div>
      )}
    </div>
  );
}

function Fecha({ label, iso, ahora }: { label: string; iso: string | null; ahora: number }) {
  return (
    <span className={`tn-f${iso ? '' : ' vacia'}`} title={iso ? fmtDate(iso) : `${label}: pendiente`}>
      <b>{label}</b><span>{fmtCorta(iso, ahora)}</span>
    </span>
  );
}

function Cefr({ nivel }: { nivel: string }) {
  return <span className="tn-cefr" style={{ background: CEFR_COLOR[nivel as keyof typeof CEFR_COLOR] || '#6E6E66' }}>{nivel}</span>;
}

// ── Detalle de un alumno ─────────────────────────────────────────────────────
function Detalle({ e, ahora, profe, enviando, onCerrar, onRecordar, onCopiar }: {
  e: Seguimiento; ahora: number; profe?: ConfirmedLevel; enviando: boolean;
  onCerrar: () => void; onRecordar: () => void; onCopiar: (url: string) => void;
}) {
  const tag = TONO_TAG[e.tono];
  const enlace = enlaceDe(e, ahora);
  const p = e.pendiente;
  const enCurso = !e.prueba && e.sesion && testStateOf(e.sesion) === 'in_progress';
  // El puntaje daba más y la compuerta de escritura lo bajó (lib/levelTest/scoring).
  const porPuntaje = e.cefr && e.overall != null ? scoreToCefr(e.overall) : null;
  const capado = !!porPuntaje && porPuntaje !== e.cefr;

  return (
    <div className="tn-det">
      <div className="tn-det-h">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <h3 className="tn-det-t">{e.nombre}</h3>
          {e.cefr && <Cefr nivel={e.cefr} />}
          <span className={`tn-tag ${tag}`}>{etiquetaDe(e)}</span>
        </div>
        <button type="button" className="tn-btn-ic tn-cerrar" onClick={onCerrar} aria-label="Cerrar el detalle"><X size={16} /></button>
      </div>

      {(e.recordable || enlace) && (
        <div style={{ display: 'flex', gap: 8 }}>
          {e.recordable && (
            <button className="adm-btn adm-btn-primary" style={{ flex: 1, minHeight: 44 }} disabled={enviando} onClick={onRecordar}>
              <Send size={15} aria-hidden /> {enviando ? 'Enviando…' : 'Enviar recordatorio'}
            </button>
          )}
          {enlace && (
            <button className="adm-btn adm-btn-ghost" style={{ minHeight: 44, flex: e.recordable ? undefined : 1 }} onClick={() => onCopiar(enlace)}>
              <Copy size={15} aria-hidden /> Copiar link
            </button>
          )}
        </div>
      )}

      <div className="adm-card tn-filas">
        <div className="tn-fila"><span className="tn-fila-l">Enlace enviado</span><span className="tn-fila-v" title={fmtDate(e.enviado)}>{cap(fmtCorta(e.enviado, ahora))}</span></div>
        <div className="tn-fila">
          <span className="tn-fila-l">Formulario</span>
          <span className="tn-fila-v" title={e.formulario ? fmtDate(e.formulario) : undefined}>
            {e.formulario ? cap(fmtCorta(e.formulario, ahora)) : e.token ? <span className="tn-tag gris">Pendiente</span> : <span style={{ color: '#a4a7a1', fontWeight: 500 }}>Sin formulario</span>}
          </span>
        </div>
        <div className="tn-fila">
          <span className="tn-fila-l">Prueba de nivel</span>
          <span className="tn-fila-v" title={e.prueba ? fmtDate(e.prueba) : undefined}>
            {e.prueba ? cap(fmtCorta(e.prueba, ahora))
              : enCurso ? <span className="tn-tag ambar">En curso{e.sesion?.answered_count != null ? ` · ${e.sesion.answered_count} de ${GRAND_TOTAL}` : ''}</span>
              : <span className="tn-tag gris">Pendiente</span>}
          </span>
        </div>
        {e.cefr && (
          <>
            <div className="tn-fila">
              <span className="tn-fila-l">Nivel de la prueba</span>
              <span className="tn-fila-v" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Cefr nivel={e.cefr} />
                {capado && <span className="tn-tag ambar" title={`El puntaje daba ${porPuntaje}; se bajó a ${e.cefr} porque la escritura no respalda un nivel alto`}>↓ {porPuntaje}</span>}
              </span>
            </div>
            <div className="tn-fila">
              <span className="tn-fila-l">Nivel del profesor</span>
              <span className="tn-fila-v" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={profe?.by ? `Confirmado por ${profe.by}` : undefined}>
                {profe ? <><Cefr nivel={profe.level} />{profe.at && <span style={{ color: '#6E6E66', fontWeight: 500 }}>· {fmtCorta(profe.at, ahora)}</span>}</> : <span className="tn-tag gris">Sin validar</span>}
              </span>
            </div>
          </>
        )}
        {e.profesor && <div className="tn-fila"><span className="tn-fila-l">Profesor</span><span className="tn-fila-v">{e.profesor}</span></div>}
        <div className="tn-fila">
          <span className="tn-fila-l">Email</span>
          <span className="tn-fila-v" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 500, color: '#4A4A4A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.email ?? '—'}</span>
            {e.email && <button type="button" className="tn-btn-ic" onClick={() => onCopiar(e.email!)} aria-label="Copiar el email"><Copy size={15} /></button>}
          </span>
        </div>
      </div>

      {e.prueba && e.sesion ? (
        <ResultadoSesion key={e.sesion.id} id={e.sesion.id} />
      ) : (
        <div className="adm-card tn-filas">
          <p className="tn-sec" style={{ margin: '10px 0 2px' }}>Recordatorios</p>
          {e.tono === 'baja' ? (
            <p className="tn-nota">Ya no es alumno: el follow-up no le escribe.</p>
          ) : e.tono === 'caducado' ? (
            <p className="tn-nota">El enlace caducó sin abrirse. El follow-up automático le genera uno nuevo y le escribe en su próxima corrida.</p>
          ) : p ? (
            <>
              <div className="tn-fila"><span className="tn-fila-l">Secuencia</span><span className="tn-fila-v">{p.sequence === 'formulario' ? 'Formulario' : 'Prueba de nivel'}</span></div>
              <div className="tn-fila"><span className="tn-fila-l">Enviados</span><span className="tn-fila-v">{p.count} de {MAX_REMINDERS}</span></div>
              <div className="tn-fila"><span className="tn-fila-l">Último</span><span className="tn-fila-v" title={p.lastSent ? fmtDate(p.lastSent) : undefined}>{p.lastSent ? cap(fmtCorta(p.lastSent, ahora)) : <span style={{ color: '#a4a7a1', fontWeight: 500 }}>—</span>}</span></div>
              {p.count >= MAX_REMINDERS
                ? <span className="tn-tag rojo" style={{ margin: '4px 0 10px' }}>Agotó los tres. Toca llamar.</span>
                : <p className="tn-nota">Salen solos a los 2, 5 y 10 días{p.step ? '; hoy le toca el siguiente' : ''}.</p>}
            </>
          ) : e.token ? (
            <p className="tn-nota">Fuera del follow-up automático{e.email ? '' : ': no tiene email al que escribir'}.</p>
          ) : (
            <p className="tn-nota">Prueba generada a mano, sin formulario: no entra en el follow-up automático.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Resultado por destreza + evaluación de Writing (carga la sesión completa) ──
interface AnswerRow {
  id: string; section: string; difficulty: number; is_correct: boolean | null;
  written_response: string | null; ai_score: number | null; ai_feedback: WritingEvaluation | null;
  // De supabase-level-test-v2.sql: pueden no existir todavía.
  invalid_reason?: string | null;
  target_difficulty?: number | null;
}

const ANSWER_COLS = 'id, section, difficulty, is_correct, written_response, ai_score, ai_feedback';

// Con reintento: si faltan las columnas nuevas (42703), pedirlas dejaría el
// detalle vacío en vez de mostrar lo de siempre.
async function loadAnswers(sessionId: string): Promise<AnswerRow[]> {
  const q = (cols: string) => supabase
    .from('level_test_answers').select(cols).eq('session_id', sessionId)
    .order('answered_at', { ascending: true });
  const first = await q(`${ANSWER_COLS}, invalid_reason, target_difficulty`);
  if (!first.error) return (first.data ?? []) as unknown as AnswerRow[];
  const base = await q(ANSWER_COLS);
  return (base.data ?? []) as unknown as AnswerRow[];
}

function ResultadoSesion({ id }: { id: string }) {
  const [session, setSession] = useState<Record<string, unknown> | null>(null);
  const [answers, setAnswers] = useState<AnswerRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Va con key={id} desde el detalle: otro alumno = componente nuevo, sin
  // tener que resetear el estado a mano dentro del efecto.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: s }, a] = await Promise.all([
        supabase.from('level_test_sessions').select('*').eq('id', id).maybeSingle(),
        loadAnswers(id),
      ]);
      if (!alive) return;
      setSession(s as Record<string, unknown> | null);
      setAnswers(a);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id]);

  if (loading) return <div className="adm-card tn-filas"><p className="tn-nota">Cargando el resultado…</p></div>;
  if (!session) return null;

  const readingCorrect = answers.filter(a => a.section !== 'writing' && a.is_correct).length;
  const readingTotal = answers.filter(a => a.section !== 'writing').length;
  const writing = answers.find(a => a.section === 'writing');
  const ev = writing?.ai_feedback;
  const num = (k: string) => (session[k] != null ? Math.round(session[k] as number) : null);
  const total = num('overall_score'), reading = num('reading_score'), escritura = num('writing_score');

  // La escritura no aportó al nivel. El motivo real se muestra AQUÍ y en la ficha
  // del profesor; al alumno se le da siempre el mismo texto neutro.
  const provisional = session.status === 'completed' && session.writing_score == null;
  const motivo = (writing?.invalid_reason ?? session.writing_invalid_reason) as string | undefined | null;
  const motivoTexto = motivo && motivo in INVALID_REASON_LABEL
    ? INVALID_REASON_LABEL[motivo as keyof typeof INVALID_REASON_LABEL]
    : null;

  return (
    <div className="adm-card" style={{ padding: 14 }}>
      <p className="tn-sec">Resultado por destreza</p>
      <div className="tn-dzs">
        <Destreza n={total} label="Total /100" />
        <Destreza n={reading} label="Reading" sub={readingTotal ? `${readingCorrect}/${readingTotal}` : undefined} />
        <Destreza n={escritura} label="Writing" />
      </div>

      {provisional && (
        <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 9, background: 'rgba(255,196,0,0.14)', border: '1px solid rgba(180,119,7,0.3)', color: '#B54708', fontSize: 12.5, lineHeight: 1.55 }}>
          <b>Nivel provisional.</b> Salió solo de la comprensión lectora: la expresión escrita
          no se pudo puntuar.{motivoTexto ? ` Motivo: ${motivoTexto.toLowerCase()}.` : ''}
          {' '}El alumno solo ve un aviso neutro, sin el motivo.
        </div>
      )}

      {ev && (
        <details style={{ marginTop: 12, fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--accent)', fontWeight: 600 }}>Evaluación de Writing (IA)</summary>
          {ev.overall_feedback && <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0' }}>{ev.overall_feedback}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 8 }}>
            {(['grammar', 'vocabulary', 'coherence', 'task_completion'] as const).map(k => (
              <div key={k} style={{ background: 'var(--bg-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{k.replace('_', ' ')}</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{ev[k]?.score}/100</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4, marginTop: 2 }}>{ev[k]?.feedback}</div>
              </div>
            ))}
          </div>
          {writing?.written_response && (
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 8, background: 'var(--bg-surface-2)', borderRadius: 8, padding: '10px 12px', lineHeight: 1.55, color: 'var(--text-secondary)' }}>{writing.written_response}</div>
          )}
        </details>
      )}
    </div>
  );
}

function Destreza({ n, label, sub }: { n: number | null; label: string; sub?: string }) {
  return (
    <div className="tn-dz">
      <div className="tn-dz-n">{n ?? '—'}</div>
      <div className="tn-dz-l">{label}{sub ? ` · ${sub}` : ''}</div>
      <div className="tn-track"><div className="tn-fill" style={{ width: `${n ?? 0}%` }} /></div>
    </div>
  );
}

// ── Modal: generar link ──────────────────────────────────────────────────────
function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [days, setDays] = useState(7);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const input = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' as const, marginBottom: 12 };

  async function gen() {
    if (!name.trim() || !email.trim()) { setErr('Completá nombre y email.'); return; }
    setBusy(true); setErr('');
    try {
      const { url } = await generateTestLink({ candidateName: name.trim(), candidateEmail: email.trim(), candidatePhone: phone.trim(), studentName: name.trim(), expiresInDays: days });
      setUrl(url);
    } catch (e) { setErr(e instanceof Error ? e.message : 'No se pudo generar.'); }
    finally { setBusy(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 14 }}>Generar link de test de nivel</div>
      {url ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>Link generado para <b>{name}</b>:</div>
          <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--text-primary)', wordBreak: 'break-all', marginBottom: 12 }}>{url}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => navigator.clipboard?.writeText(url).catch(() => {})} className="adm-btn adm-btn-ghost" style={{ flex: 1 }}>Copiar link</button>
            <button onClick={onDone} className="adm-btn adm-btn-primary" style={{ flex: 1 }}>Listo</button>
          </div>
        </>
      ) : (
        <>
          <label style={labelStyle}>Nombre del candidato *</label>
          <input value={name} onChange={e => setName(e.target.value)} style={input} />
          <label style={labelStyle}>Email *</label>
          <input value={email} onChange={e => setEmail(e.target.value)} style={input} type="email" />
          <label style={labelStyle}>Teléfono (opcional)</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} style={input} />
          <label style={labelStyle}>Expira en (días)</label>
          <input value={days} onChange={e => setDays(parseInt(e.target.value) || 7)} style={input} type="number" min={1} />
          {err && <div style={{ fontSize: 12.5, color: '#b42318', marginBottom: 10 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} className="adm-btn adm-btn-ghost" style={{ flex: 1 }}>Cancelar</button>
            <button onClick={gen} disabled={busy} className="adm-btn adm-btn-primary" style={{ flex: 1 }}>{busy ? 'Generando…' : 'Generar'}</button>
          </div>
        </>
      )}
    </Overlay>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 } as const;

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
// Misma anatomía que el resto del admin (.adm-card, .adm-btn, tipografía del
// sistema). Por debajo de 768 px la fila se vuelve tarjeta y el detalle ocupa
// toda la pantalla; nada se desliza en horizontal.
const ESTILOS = `
.tn { font-family: var(--font-app); color: #1a1c1a; }
.tn-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.tn-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.tn-sub { font-size: 13px; color: var(--text-muted); margin: 3px 0 0; }
.tn-aviso { display: flex; align-items: center; gap: 10px; border-radius: 10px; padding: 10px 14px; font-size: 13px; line-height: 1.5; margin-bottom: 12px; }
.tn-aviso.ok { background: #EAF5EC; color: #167A2D; border: 1px solid #b7dcc0; }
.tn-aviso.mal { background: #FDECEC; color: #C81E1E; border: 1px solid rgba(200,30,30,0.3); }
.tn-aviso .tn-btn-ic { color: inherit; background: transparent; border-color: transparent; }
.tn-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.tn-kpi { padding: 14px 16px; }
.tn-kpi-l { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #8b8e88; }
.tn-kpi-v { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; margin-top: 6px; }
.tn-kpi-s { font-size: 12px; color: #a4a7a1; margin-top: 3px; }
.tn-split { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; align-items: start; }
.tn-lista { overflow: clip; }
.tn-lh { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #ECECE8; flex-wrap: wrap; }
.tn-search { position: relative; flex: 1; min-width: 180px; max-width: 320px; display: block; }
.tn-search input { width: 100%; height: 38px; padding: 0 12px 0 34px; border-radius: 10px; border: 1px solid #e6e7e2; background: #fff; font-size: 13.5px; font-family: inherit; color: var(--text-primary); box-sizing: border-box; }
.tn-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
.tn-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tn-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1.5px solid #e6e7e2; background: transparent; font-family: inherit; font-size: 13px; font-weight: 500; color: #4A4A4A; cursor: pointer; }
.tn-chip:hover { background: #f4f5f2; }
.tn-chip[aria-pressed="true"] { border-color: #1E9E3A; background: rgba(30,158,58,0.1); color: #1E9E3A; font-weight: 700; }
.tn-chip .n { font-size: 12px; font-weight: 700; color: #6E6E66; }
.tn-chip[aria-pressed="true"] .n { color: #1E9E3A; }
.tn-chip .n.rojo { color: #C81E1E; }
.tn-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) 80px 80px 80px 104px 128px; align-items: center; gap: 10px; min-height: 52px; padding: 6px 14px; border-top: 1px solid #ECECE8; font-size: 13.5px; cursor: pointer; background: #fff; }
.tn-row:focus-visible { outline: 2px solid #1E9E3A; outline-offset: -2px; }
.tn-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; cursor: default; }
.tn-row:not(.head):hover { background: #FAFAF8; }
.tn-row.rojo { background: #FFFBFA; }
.tn-row.is-sel { background: #eef6ef; }
.tn-row.is-cur { box-shadow: inset 3px 0 0 #1E9E3A; }
.tn-row.baja { opacity: 0.7; }
.tn-cb { width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid #C8C8C0; background: #fff; display: grid; place-items: center; color: #fff; padding: 0; cursor: pointer; }
.tn-cb.on { background: #1E9E3A; border-color: #1E9E3A; }
.tn-cb:disabled { opacity: 0.3; cursor: default; }
.tn-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tn-fechas { display: contents; }
.tn-f { white-space: nowrap; }
.tn-f b { display: none; }
.tn-f.vacia span { color: #a4a7a1; }
.tn-nivel { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.tn-cefr { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; height: 24px; padding: 0 8px; border-radius: 8px; font-size: 13px; font-weight: 700; color: #fff; }
.tn-tag { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.tn-tag.rojo { background: #FDECEC; color: #C81E1E; }
.tn-tag.ambar { background: #FFF6E0; color: #8a6d00; }
.tn-tag.gris { background: #F0F0ED; color: #4A4A4A; }
.tn-tag.ok { background: #EAF5EC; color: #167A2D; }
.tn-chev, .tn-act { display: none; }
.tn-lote { position: sticky; bottom: 0; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #eef6ef; border-top: 1px solid #b7dcc0; font-size: 13.5px; font-weight: 600; color: #15803d; flex-wrap: wrap; }
.tn-vacio { padding: 40px 16px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.tn-vacio-t { font-size: 18px; font-weight: 700; }
.tn-vacio-s { font-size: 14px; color: #6E6E66; max-width: 340px; line-height: 1.5; }
.tn-panel { padding: 18px; position: sticky; top: 16px; }
.tn-panel.vacio { display: flex; align-items: center; justify-content: center; min-height: 320px; color: #6E6E66; font-size: 14px; text-align: center; }
.tn-back { display: none; }
.tn-det { display: flex; flex-direction: column; gap: 14px; }
.tn-det-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.tn-det-t { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.015em; overflow-wrap: anywhere; }
.tn-btn-ic { width: 32px; height: 32px; border-radius: 8px; border: 1px solid #e6e7e2; background: #fff; display: inline-grid; place-items: center; color: #5f6360; cursor: pointer; flex-shrink: 0; padding: 0; }
.tn-btn-ic:hover { background: #f4f5f2; color: #1a1c1a; }
.tn-filas { padding: 4px 14px; }
.tn-sec { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #6E6E66; margin: 0 0 8px; }
.tn-fila { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 40px; font-size: 14px; }
.tn-fila-l { color: #4A4A4A; flex-shrink: 0; }
.tn-fila-v { font-weight: 600; text-align: right; min-width: 0; }
.tn-nota { font-size: 13px; color: #6E6E66; margin: 2px 0 10px; line-height: 1.5; }
.tn-dzs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.tn-dz { padding: 10px 12px; border-radius: 10px; background: #F7F7F5; min-width: 0; display: flex; flex-direction: column; }
.tn-dz-n { font-size: 20px; font-weight: 700; line-height: 1.1; }
.tn-dz-l { font-size: 12px; color: #6E6E66; margin-top: 2px; line-height: 1.3; }
.tn-track { height: 6px; border-radius: 3px; background: #E8E8E4; overflow: hidden; margin-top: auto; padding-top: 0; }
.tn-dz-l { margin-bottom: 6px; }
.tn-fill { height: 100%; border-radius: 3px; background: #1E9E3A; }

/* Portátiles estrechos: el detalle se apila encima de la lista. */
@media (max-width: 1100px) {
  .tn-split { grid-template-columns: minmax(0, 1fr); }
  .tn-panel { position: static; order: -1; }
  .tn-panel.vacio { display: none; }
}

/* Teléfono */
@media (max-width: 767px) {
  .tn-titulo { display: none; }
  .tn-head { margin-bottom: 12px; }
  .tn-head .adm-btn { width: 100%; min-height: 44px; }
  .tn-kpis { display: none; }
  .tn-lista { background: transparent; border: 0; box-shadow: none; overflow: visible; }
  .tn-lh { flex-direction: column; align-items: stretch; padding: 0 0 12px; border: 0; gap: 10px; }
  .tn-search { max-width: none; }
  .tn-search input { height: 44px; font-size: 14px; }
  .tn-row.head { display: none; }
  .tn-row { grid-template-columns: minmax(0, 1fr) auto auto auto; grid-template-areas: "name cefr estado chev" "fechas fechas fechas fechas" "act act act act"; gap: 8px; padding: 12px 14px; min-height: 0; background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; box-shadow: 0 1px 2px rgba(16,24,16,0.04); margin-bottom: 8px; }
  .tn-row:not(.head):hover { background: #fff; }
  .tn-row.rojo, .tn-row.rojo:not(.head):hover { border-color: rgba(220,74,56,0.35); background: #FFFBFA; }
  .tn-row.is-cur { box-shadow: 0 1px 2px rgba(16,24,16,0.04); }
  .tn-row.is-sel { background: #fff; }
  .tn-cb { display: none; }
  .tn-name { grid-area: name; font-size: 15px; font-weight: 700; }
  .tn-fechas { display: flex; flex-wrap: wrap; gap: 4px 14px; grid-area: fechas; font-size: 13px; color: #4A4A4A; }
  .tn-f b { display: inline; font-weight: 600; color: #6E6E66; margin-right: 4px; }
  .tn-nivel { grid-area: cefr; }
  .tn-profe { display: none; }
  .tn-estado { grid-area: estado; }
  .tn-chev { display: block; grid-area: chev; color: #6E6E66; line-height: 0; }
  .tn-act { display: flex; grid-area: act; }
  .tn-act .adm-btn { flex: 1; min-height: 40px; }
  .tn-lote { display: none; }
  .tn-split { display: block; }
  .tn-split.abierta .tn-lista { display: none; }
  .tn-abierta .tn-head, .tn-abierta .tn-aviso.ok { display: none; }
  .tn-split:not(.abierta) .tn-panel { display: none; }
  .tn-panel { position: static; padding: 0; background: transparent; border: 0; box-shadow: none; }
  .tn-back { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 8px 0 2px; margin-bottom: 4px; font-family: inherit; font-size: 15px; font-weight: 600; color: #167A2D; background: none; border: 0; cursor: pointer; }
  .tn-cerrar { display: none; }
  .tn-det-t { font-size: 22px; }
}
`;
