'use client';

// USO DE LA PLATAFORMA — sección del dashboard de gestión (/dashboard).
//
// Seis métricas semana a semana (lunes a domingo, hora de España), al estilo del
// dashboard de gestión (/dashboard): una tarjeta por métrica con la cifra de la
// semana elegida y sus barras de las últimas 12 semanas, y debajo la tabla por
// profesor de esa semana.
//
// NO CALCULA NADA. Todo sale de /api/admin/teacher-usage (lib/teacherUsage +
// lib/teacherUsageLoad), que hace las cuentas en el servidor: al navegador solo
// le llegan totales, nunca filas ni transcripts.
//
// Gráficas hechas a mano (SVG), sin librería, como el resto del admin: una serie
// por tarjeta, un solo color (el verde de la marca). La semana en curso va más
// clara porque sus números todavía se mueven; "sin registrar" (null) y "nada que
// medir" (den 0) se pintan como una raya gris en la base, con su explicación en
// el tooltip.

import { useEffect, useMemo, useState } from 'react';
import { Badge, TableWrap, THead, TD, CardList, ToggleChip, NAV_STICKY_TOP } from '@/components/ui';
import type { InformeUso, Metrica, Celda } from '@/lib/teacherUsage';

type Informe = InformeUso & { avisos: string[] };

const VERDE = '#1E9E3A';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ── Textos de cada métrica ────────────────────────────────────────────────────

const META: Record<Metrica, {
  titulo: string;
  corto: string;
  /** "8 de 18 {unidad}". */
  unidad: string;
  nota: string;
}> = {
  prueba: {
    titulo: 'Completan la prueba de nivel', corto: 'Prueba', unidad: 'alumnos',
    nota: 'Alumnos a los que se les envió el primer enlace esa semana y que ya la completaron.',
  },
  validacion: {
    titulo: 'Pruebas validadas por el profe', corto: 'Validadas', unidad: 'pruebas',
    nota: 'Pruebas completadas esa semana con el nivel ya confirmado o corregido por su profesor actual.',
  },
  ia: {
    titulo: 'Usan la generación de clases', corto: 'Clases IA', unidad: 'profes',
    nota: 'Profesores con clases esa semana que generaron alguna clase con IA (con o sin transcript). Registro desde el 08/09/2026.',
  },
  transcript: {
    titulo: 'Transcript en menos de 24 h', corto: 'Transcript <24 h', unidad: 'clases',
    nota: 'Clases con el plazo ya cerrado (desde el 22/09/2026). Las faltas del alumno no cuentan.',
  },
  ingreso: {
    titulo: 'Entran con el link', corto: 'Entró con link', unidad: 'clases',
    nota: 'Clases del calendario ya terminadas con el clic en "Ingresar a clase". Las canceladas o movidas no cuentan; el ingreso que crea el admin a mano tampoco.',
  },
  riesgo: {
    titulo: 'Abren las alertas de riesgo', corto: 'Abrió alerta', unidad: 'profes',
    nota: 'Profesores con alguna alerta de riesgo esa semana que la abrieron (campanita o pestaña Seguimiento de la ficha) en los 7 días siguientes.',
  },
};

// ── Utilidades ────────────────────────────────────────────────────────────────

const pctDe = (c: Celda): number | null => (c && c.den > 0 ? Math.round((c.num / c.den) * 100) : null);

function fechaCorta(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[(m ?? 1) - 1]}`;
}
function rangoSemana(s: { start: string; end: string }): string {
  return `${fechaCorta(s.start)} – ${fechaCorta(s.end)}`;
}

/** Semáforo de una proporción. Siempre acompaña a la cifra: nunca color solo. */
function tonoDe(p: number | null): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (p === null) return 'neutral';
  return p >= 80 ? 'ok' : p >= 50 ? 'warn' : 'danger';
}

/** Barra con las esquinas de ARRIBA redondeadas y la base recta, apoyada en el eje. */
function barraPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

// ── Gráfico de una métrica ────────────────────────────────────────────────────

function Barras({ informe, metrica, sel, onSel }: {
  informe: Informe; metrica: Metrica; sel: number; onSel: (w: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const celdas = informe.global[metrica];
  const n = celdas.length;
  const W = 300, H = 84, ejeY = 70, alto = 62;
  const paso = W / n;
  const ancho = Math.max(6, paso - 6);
  const activo = hover ?? sel;

  const tooltip = (w: number): string => {
    const s = informe.semanas[w];
    const c = celdas[w];
    const cab = `Semana ${rangoSemana(s)}${s.enCurso ? ' (en curso)' : ''}`;
    if (c === null) return `${cab} · todavía no se registraba`;
    if (c.den === 0) return `${cab} · nada que medir`;
    return `${cab} · ${pctDe(c)} % · ${c.num} de ${c.den} ${META[metrica].unidad}`;
  };

  return (
    <div className="tu-chart">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
        aria-label={`${META[metrica].titulo}, últimas ${n} semanas`}
        onMouseLeave={() => setHover(null)}>
        {/* Rejilla recesiva: 50 % y 100 %. */}
        <line x1={0} x2={W} y1={ejeY - alto} y2={ejeY - alto} stroke="var(--border)" strokeDasharray="2 3" />
        <line x1={0} x2={W} y1={ejeY - alto / 2} y2={ejeY - alto / 2} stroke="var(--border)" strokeDasharray="2 3" />
        {celdas.map((c, w) => {
          const x = w * paso + (paso - ancho) / 2;
          const p = pctDe(c);
          const esSel = w === sel;
          return (
            <g key={w}
              role="button" tabIndex={0} aria-label={tooltip(w)} aria-pressed={esSel}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={() => setHover(w)} onFocus={() => setHover(w)} onBlur={() => setHover(null)}
              onClick={() => onSel(w)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSel(w); } }}>
              {/* Franja de la semana elegida (y zona de toque más grande que la barra). */}
              <rect x={w * paso} y={0} width={paso} height={H} rx={4}
                fill={esSel ? 'var(--bg-surface-2)' : 'transparent'} />
              {p === null ? (
                <rect x={x} y={ejeY - 2} width={ancho} height={2} rx={1} fill="var(--text-muted)" opacity={0.35} />
              ) : (
                <path d={barraPath(x, ejeY - Math.max(2, (p / 100) * alto), ancho, Math.max(2, (p / 100) * alto), 4)}
                  fill={VERDE} opacity={informe.semanas[w].enCurso ? 0.4 : esSel || hover === w ? 1 : 0.78} />
              )}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={ejeY} y2={ejeY} stroke="var(--border)" />
        {/* Etiquetas de fecha: la primera, la del medio y la última. */}
        {/* Los extremos se anclan hacia adentro para que no se corten. */}
        {[0, Math.floor((n - 1) / 2), n - 1].map(w => (
          <text key={w} x={w === 0 ? 1 : w === n - 1 ? W - 1 : w * paso + paso / 2} y={H - 1}
            textAnchor={w === 0 ? 'start' : w === n - 1 ? 'end' : 'middle'} fontSize={9.5} fill="var(--text-muted)">
            {fechaCorta(informe.semanas[w].start)}
          </text>
        ))}
      </svg>
      <div className="tu-tip" aria-live="polite">{tooltip(activo)}</div>
    </div>
  );
}

// ── Tarjeta ───────────────────────────────────────────────────────────────────

function Tarjeta({ informe, metrica, sel, onSel }: {
  informe: Informe; metrica: Metrica; sel: number; onSel: (w: number) => void;
}) {
  const c = informe.global[metrica][sel];
  const prev = sel > 0 ? informe.global[metrica][sel - 1] : null;
  const p = pctDe(c);
  const pPrev = pctDe(prev);
  const delta = p !== null && pPrev !== null ? p - pPrev : null;
  const sinRegistro = informe.global[metrica].every(x => x === null);

  let detalle: string;
  if (c === null) detalle = 'Esa semana todavía no se registraba.';
  else if (c.den === 0) detalle = 'Nada que medir esa semana.';
  else detalle = `${c.num} de ${c.den} ${META[metrica].unidad}`;

  // Datos extra de algunas métricas.
  let extra: string | null = null;
  if (metrica === 'ia' && c) {
    const o = informe.iaOrigen[sel];
    const total = o.transcript + o.directa;
    extra = `${total} clase${total !== 1 ? 's' : ''} generada${total !== 1 ? 's' : ''} · ${o.transcript} con transcript`;
  }
  if (metrica === 'transcript') {
    const tp = informe.transcriptProfes[sel];
    if (tp && tp.den > 0) extra = `${tp.num} de ${tp.den} profes sin ninguna tarde`;
  }
  if (metrica === 'ingreso') {
    const f = informe.ingresoFuente[sel];
    extra = f === 'foto' ? 'Calendario de cada día (exacto)'
      : f === 'mixta' ? 'En parte estimado con el horario actual'
      : 'Estimado con el horario actual del calendario';
  }

  return (
    <div className="adm-card tu-card">
      <div className="tu-cardhead">{META[metrica].titulo}</div>
      {sinRegistro ? (
        <div className="tu-vacio">
          {metrica === 'riesgo'
            // Si faltara el SQL, el aviso amarillo de arriba ya lo dice.
            ? 'Todavía sin datos: se empieza a medir cuando los profesores abran su primera alerta.'
            : 'Todavía no hay datos registrados.'}
        </div>
      ) : (
        <>
          <div className="tu-hero">
            <span className="tu-big">{p === null ? '—' : `${p} %`}</span>
            {delta !== null && delta !== 0 && (
              <span className="tu-delta">{delta > 0 ? '▲' : '▼'} {Math.abs(delta)} pts</span>
            )}
          </div>
          <div className="tu-det">{detalle}{informe.semanas[sel].enCurso && c && c.den > 0 ? ' · semana en curso' : ''}</div>
          {extra && <div className="tu-extra">{extra}</div>}
          <Barras informe={informe} metrica={metrica} sel={sel} onSel={onSel} />
        </>
      )}
      <p className="tu-note">{META[metrica].nota}</p>
    </div>
  );
}

// ── Celda de la tabla por profesor ────────────────────────────────────────────

function CeldaProfe({ metrica, c }: { metrica: Metrica; c: Celda }) {
  if (c === null) return <span className="tu-na" title="Esa semana todavía no se registraba">sin registro</span>;
  if (metrica === 'ia') {
    // Por profesor: clases generadas sobre clases dadas esa semana.
    if (c.num === 0 && c.den === 0) return <span className="tu-na">—</span>;
    return (
      <Badge tone={c.num > 0 ? 'ok' : 'danger'} title={`${c.num} clase(s) generada(s) con IA · ${c.den} clase(s) dada(s)`}>
        {c.num > 0 ? `${c.num} generada${c.num !== 1 ? 's' : ''}` : 'No la usó'}
      </Badge>
    );
  }
  if (c.den === 0) return <span className="tu-na">—</span>;
  if (metrica === 'riesgo') {
    return <Badge tone={c.num > 0 ? 'ok' : 'danger'}>{c.num > 0 ? 'Sí' : 'No la abrió'}</Badge>;
  }
  const p = pctDe(c);
  return (
    <Badge tone={tonoDe(p)} title={`${c.num} de ${c.den} ${META[metrica].unidad}`}>
      {p} % · {c.num}/{c.den}
    </Badge>
  );
}

/** Valor para ordenar: los que no tienen dato van al final. */
function valorOrden(metrica: Metrica, c: Celda): number {
  if (c === null) return Infinity;
  if (metrica === 'ia') return c.den === 0 && c.num === 0 ? Infinity : c.num;
  return c.den > 0 ? c.num / c.den : Infinity;
}

// ── Pantalla ──────────────────────────────────────────────────────────────────

export default function TeacherUsageDashboard() {
  const [informe, setInforme] = useState<Informe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [orden, setOrden] = useState<Metrica | 'nombre'>('nombre');
  const [todos, setTodos] = useState(false);

  async function cargar() {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/teacher-usage?semanas=12', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
      setInforme(json as Informe);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el uso de la plataforma.');
    } finally {
      setCargando(false);
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { cargar(); }, []);

  // Por defecto, la última semana COMPLETA: la en curso todavía se mueve.
  const semanaSel = informe ? (sel ?? Math.max(0, informe.semanas.length - 2)) : 0;

  const filas = useMemo(() => {
    if (!informe) return [];
    const w = semanaSel;
    const conDatos = (f: InformeUso['profesores'][number]) =>
      (['prueba', 'validacion', 'transcript', 'ingreso', 'riesgo'] as Metrica[])
        .some(m => (f.celdas[m][w]?.den ?? 0) > 0) || (f.celdas.ia[w]?.num ?? 0) > 0;
    const lista = informe.profesores.filter(f => todos || conDatos(f));
    if (orden === 'nombre') return lista;
    // Los peores primero: es a quien hay que mirar.
    return [...lista].sort((a, b) =>
      valorOrden(orden, a.celdas[orden][w]) - valorOrden(orden, b.celdas[orden][w]) || a.name.localeCompare(b.name, 'es'));
  }, [informe, semanaSel, orden, todos]);

  if (cargando && !informe) {
    return (
      <section className="tu">
        <style>{ESTILOS}</style>
        <Cabecera />
        <div className="tu-grid">
          {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="adm-card tu-card tu-skel" />)}
        </div>
      </section>
    );
  }
  if (error || !informe) {
    return (
      <section className="tu">
        <style>{ESTILOS}</style>
        <Cabecera />
        <div className="tu-aviso">
          {error ?? 'No se pudo cargar el uso de la plataforma.'}{' '}
          <button type="button" className="tu-linkbtn" onClick={cargar}>Reintentar</button>
        </div>
      </section>
    );
  }

  const s = informe.semanas[semanaSel];
  const METS: Metrica[] = ['prueba', 'validacion', 'ia', 'transcript', 'ingreso', 'riesgo'];

  return (
    <section className="tu">
      <style>{ESTILOS}</style>
      <Cabecera />

      {informe.avisos.map(a => <div key={a} className="tu-aviso">{a}</div>)}

      <div className="tu-semana">
        <button type="button" className="tu-nav" aria-label="Semana anterior"
          disabled={semanaSel === 0} onClick={() => setSel(Math.max(0, semanaSel - 1))}>‹</button>
        <span className="tu-semana-l">
          Semana del <b>{rangoSemana(s)}</b>{s.enCurso ? ' · en curso' : ''}
        </span>
        <button type="button" className="tu-nav" aria-label="Semana siguiente"
          disabled={semanaSel === informe.semanas.length - 1}
          onClick={() => setSel(Math.min(informe.semanas.length - 1, semanaSel + 1))}>›</button>
      </div>

      <div className="tu-grid">
        {METS.map(m => <Tarjeta key={m} informe={informe} metrica={m} sel={semanaSel} onSel={setSel} />)}
      </div>

      {/* ── Por profesor ── */}
      <div className="tu-tablehead">
        <h3 className="tu-h3">Por profesor · semana del {rangoSemana(s)}</h3>
        <ToggleChip active={todos} onClick={() => setTodos(v => !v)}>
          {todos ? 'Todos los profesores' : 'Solo con actividad esa semana'}
        </ToggleChip>
      </div>

      {filas.length === 0 ? (
        <div className="adm-card tu-vacio" style={{ padding: 18 }}>Ningún profesor con actividad esa semana.</div>
      ) : (
        <>
          <TableWrap className="tu-desk" fixed stickyHeader style={{ borderRadius: 14 }}>
            <colgroup>
              <col style={{ width: '16%' }} />
              {METS.map(m => <col key={m} style={{ width: '14%' }} />)}
            </colgroup>
            <THead
              top={NAV_STICKY_TOP}
              columns={[
                <button key="n" type="button" className="tu-sort" onClick={() => setOrden('nombre')}>
                  Profesor{orden === 'nombre' ? ' ↓' : ''}
                </button>,
                ...METS.map(m => (
                  <button key={m} type="button" className="tu-sort" title="Ordenar: los que peor van, primero"
                    onClick={() => setOrden(m)}>
                    {META[m].corto}{orden === m ? ' ↑' : ''}
                  </button>
                )),
              ]}
            />
            <tbody>
              {filas.map(f => (
                <tr key={f.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <TD strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</TD>
                  {METS.map(m => (
                    <TD key={m} style={{ overflow: 'hidden' }}><CeldaProfe metrica={m} c={f.celdas[m][semanaSel]} /></TD>
                  ))}
                </tr>
              ))}
            </tbody>
          </TableWrap>

          <CardList className="tu-mob" style={{ gap: 10 }}>
            {filas.map(f => (
              <div key={f.id} className="adm-card tu-pcard">
                <div className="tu-pname">{f.name}</div>
                <div className="tu-pgrid">
                  {METS.map(m => (
                    <div key={m} className="tu-pcell">
                      <span className="tu-plabel">{META[m].corto}</span>
                      <CeldaProfe metrica={m} c={f.celdas[m][semanaSel]} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardList>
        </>
      )}
    </section>
  );
}

function Cabecera() {
  return (
    <div className="tu-head">
      <h2 className="tu-h2">Uso de la plataforma</h2>
      <p className="tu-sub">Semana a semana, de lunes a domingo (hora de España). Tocá una barra para ver esa semana en todas las tarjetas y en la tabla.</p>
    </div>
  );
}

const ESTILOS = `
.tu { margin-bottom: 34px; }
.tu-head { margin-bottom: 12px; }
.tu-h2 { font-size: 17px; font-weight: 700; margin: 0; letter-spacing: -0.01em; color: var(--text-primary); }
.tu-sub { margin: 2px 0 0; font-size: 13px; color: var(--text-muted); }
.tu-h3 { font-size: 15px; font-weight: 700; margin: 0; color: var(--text-primary); }

.tu-aviso { background: #FFF8E0; border: 1px solid rgba(255,196,0,0.5); color: #6b5500; border-radius: 12px; padding: 10px 14px; font-size: 13px; margin-bottom: 12px; line-height: 1.45; }
.tu-linkbtn { border: 0; background: none; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; padding: 0; min-height: 0; }

.tu-semana { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 13.5px; color: var(--text-secondary); }
.tu-semana-l b { color: var(--text-primary); }
.tu-nav { width: 30px; height: 30px; min-height: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-surface); font-size: 17px; line-height: 1; color: var(--text-secondary); cursor: pointer; font-family: inherit; }
.tu-nav:disabled { opacity: 0.4; cursor: default; }

.tu-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 26px; }
.tu-card { padding: 16px 18px 16px; display: flex; flex-direction: column; min-width: 0; }
.tu-skel { min-height: 230px; background: linear-gradient(90deg, var(--bg-surface) 0%, var(--bg-surface-2) 50%, var(--bg-surface) 100%); }
.tu-cardhead { font-size: 12px; font-weight: 700; letter-spacing: 0.045em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; }
.tu-hero { display: flex; align-items: baseline; gap: 10px; }
.tu-big { font-size: 32px; font-weight: 700; line-height: 1.1; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.tu-delta { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.tu-det { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }
.tu-extra { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
.tu-chart { margin-top: 10px; }
.tu-tip { min-height: 16px; font-size: 11.5px; color: var(--text-secondary); margin-top: 2px; font-variant-numeric: tabular-nums; }
.tu-note { margin: 8px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.45; }
.tu-vacio { padding: 18px 0; text-align: center; font-size: 13px; color: var(--text-muted); line-height: 1.5; }

.tu-tablehead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.tu-sort { border: 0; background: none; padding: 0; min-height: 0; font: inherit; color: inherit; cursor: pointer; white-space: nowrap; }
.tu-sort:hover { color: var(--text-primary); }
.tu-na { font-size: 12px; color: var(--text-muted); }

.tu-desk { display: block; }
.tu-mob { display: none; }
.tu-pcard { padding: 12px 14px; }
.tu-pname { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.tu-pgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.tu-pcell { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; }
.tu-plabel { font-size: 11px; color: var(--text-muted); }

@media (max-width: 1100px) { .tu-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 1023.98px) {
  .tu-desk { display: none; }
  .tu-mob { display: flex; }
}
@media (max-width: 640px) { .tu-grid { grid-template-columns: 1fr; } }
`;
