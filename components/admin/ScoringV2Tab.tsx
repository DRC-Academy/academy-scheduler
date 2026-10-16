'use client';

// ── Pestaña "Scoring v2 (beta)" del admin ─────────────────────────────────────
//
// Pantalla TEMPORAL para comparar el scoring nuevo con el viejo antes de
// validarlo. Solo pinta: el puntaje lo calcula el servidor con el motor único
// (lib/teacherScore) y llega ya guardado desde /api/admin/teacher-score-v2. El
// puntaje y el nivel VIEJOS los pasa la pestaña Scoring, que es quien los
// calcula (app/admin/page.tsx → ScoringTab).
//
// La visual definitiva se hace después: esto es una tabla ordenable y, al tocar
// un profe, el porqué de cada pilar (la columna details de la foto).

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { FilaSnapshot, Metrica, Pilar } from '@/lib/teacherScore';

const VERDE = '#1E9E3A';
const AMARILLO = '#FFC400';
const FONDO = '#F7F7F5';

export interface PuntajeViejo {
  teacherId: string;
  score: number;
  /** 1 Junior · 2 Senior · 3 Elite */
  level: number;
  blocked: boolean;
}

interface Detalle {
  teacherName?: string;
  scorePilares?: number | null;
  levelMotivo?: string;
  pilares?: Record<string, Pilar>;
  ajustes?: { total: number; eventos: string[] };
  exposicion?: { alumnosMes: number; clases: number; alumnos: number; bajas: number };
  experiencia?: {
    alumnosActivos: number; horasSemanales: number; pctCalendarioOcupado: number | null;
    primeraClase: string | null; mesesEnAcademia: number | null;
  };
  academia?: { tasaBajas: number | null; bajas: number; alumnosMes: number; medianaHabla: number | null; bajasDuplicadasDescartadas: number };
}

type Columna =
  | 'nombre' | 'score' | 'level' | 'confidence' | 'retencion' | 'cumplimiento' | 'riesgo' | 'calidad'
  | 'alumnosMes' | 'bajas' | 'viejo' | 'nivelViejo';

const COLUMNAS: Array<{ id: Columna; label: string; num?: boolean }> = [
  { id: 'nombre', label: 'Profe' },
  { id: 'score', label: 'Puntaje v2', num: true },
  { id: 'level', label: 'Nivel v2' },
  { id: 'confidence', label: 'Confianza' },
  { id: 'retencion', label: 'Retención', num: true },
  { id: 'cumplimiento', label: 'Cumplim.', num: true },
  { id: 'riesgo', label: 'Riesgo', num: true },
  { id: 'calidad', label: 'Calidad', num: true },
  { id: 'alumnosMes', label: 'Alumnos-mes', num: true },
  { id: 'bajas', label: 'Bajas', num: true },
  { id: 'viejo', label: 'Puntaje viejo', num: true },
  { id: 'nivelViejo', label: 'Nivel viejo' },
];

const ORDEN_NIVEL: Record<string, number> = { 'Top': 5, 'Destacado': 4, 'Estándar': 3, 'En revisión': 2, 'En evaluación': 1 };
const ORDEN_CONF: Record<string, number> = { alta: 3, media: 2, baja: 1 };
const NIVEL_VIEJO = ['', 'Junior', 'Senior', 'Elite'];
const NOMBRE_PILAR: Record<string, string> = {
  retencion: 'Retención', cumplimiento: 'Cumplimiento', riesgo: 'Gestión del riesgo', calidad: 'Calidad', crecimiento: 'Crecimiento',
};
const NOMBRE_PARTE: Record<string, string> = {
  puntualidad: 'Puntualidad', transcripts: 'Transcripts a tiempo', cancelaciones: 'Cancelaciones tardías',
  enlaces: 'Enlaces a tiempo', senal: 'Clases en verde', habla: 'Habla del alumno',
};

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('es-ES', { maximumFractionDigits: 1 }));
const ddmmaaaa = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

function colorPuntaje(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'var(--text-muted)';
  if (v >= 65) return VERDE;
  if (v >= 40) return 'var(--text-primary)';
  return '#B07F00';
}

function NivelBadge({ level }: { level: string }) {
  const estilos: Record<string, { bg: string; color: string; border: string }> = {
    'Top':           { bg: VERDE, color: '#fff', border: VERDE },
    'Destacado':     { bg: 'rgba(30,158,58,0.10)', color: VERDE, border: 'rgba(30,158,58,0.35)' },
    'Estándar':      { bg: 'var(--bg-surface)', color: 'var(--text-secondary)', border: 'var(--border)' },
    'En revisión':   { bg: 'rgba(255,196,0,0.18)', color: '#8A6400', border: AMARILLO },
    'En evaluación': { bg: FONDO, color: 'var(--text-muted)', border: 'var(--border)' },
  };
  const e = estilos[level] ?? estilos['Estándar'];
  return (
    <span style={{
      display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: e.bg, color: e.color, border: `1px solid ${e.border}`, whiteSpace: 'nowrap',
    }}>{level}</span>
  );
}

function MetricaLinea({ titulo, m, peso }: { titulo: string; m: Metrica; peso?: string }) {
  return (
    <div style={{ padding: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{titulo}</span>
        <span style={{ fontWeight: 800, fontSize: 13, color: colorPuntaje(m.score) }}>{fmt(m.score)}</span>
        {peso && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{peso}</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{m.motivoNull ?? m.resumen}</div>
      {m.eventos.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)' }}>
          {m.eventos.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}

function DetalleProfe({ d }: { d: Detalle }) {
  const pilares = Object.entries(d.pilares ?? {}).filter(([k]) => k !== 'crecimiento');
  const ex = d.experiencia;
  return (
    <div style={{ background: FONDO, padding: '14px 16px', borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
        <strong style={{ color: 'var(--text-primary)' }}>Nivel:</strong> {d.levelMotivo ?? '—'}
        {' · '}<strong style={{ color: 'var(--text-primary)' }}>Pilares:</strong> {fmt(d.scorePilares)}
        {' · '}<strong style={{ color: 'var(--text-primary)' }}>Ajustes:</strong> {d.ajustes ? `${d.ajustes.total > 0 ? '+' : ''}${d.ajustes.total}` : '—'}
        {d.ajustes && d.ajustes.eventos.length > 0 && <> ({d.ajustes.eventos.join('; ')})</>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {pilares.map(([k, p]) => (
          <div key={k} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
            <MetricaLinea titulo={NOMBRE_PILAR[k] ?? k} m={p}
              peso={p.score === null ? 'sin dato: su peso se reparte' : `pesa ${fmt(p.pesoEfectivo)}% (config. ${p.peso})`} />
            {p.partes && (
              <div style={{ borderTop: '1px dashed var(--border)', marginTop: 6, paddingTop: 4 }}>
                {Object.entries(p.partes).map(([pk, parte]) => (
                  <MetricaLinea key={pk} titulo={NOMBRE_PARTE[pk] ?? pk} m={parte} peso={`subpeso ${parte.subpeso}`} />
                ))}
              </div>
            )}
          </div>
        ))}
        {ex && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', marginBottom: 6 }}>Experiencia y capacidad (no suman)</div>
            <div>Alumnos activos: <strong>{ex.alumnosActivos}</strong></div>
            <div>Horas semanales: <strong>{ex.horasSemanales}</strong></div>
            <div>Calendario ocupado: <strong>{ex.pctCalendarioOcupado === null ? '—' : `${fmt(ex.pctCalendarioOcupado)}%`}</strong></div>
            <div>En la academia desde: <strong>{ddmmaaaa(ex.primeraClase)}</strong> ({ex.mesesEnAcademia ?? '—'} meses)</div>
            {d.exposicion && <div>En la ventana: {fmt(d.exposicion.alumnosMes)} alumnos-mes · {d.exposicion.clases} clases</div>}
          </div>
        )}
      </div>
    </div>
  );
}

type Respuesta = { ok: true; filas: FilaSnapshot[]; fecha: string | null } | { ok: false; error: string };

/** GET = la última foto guardada; POST = recalcular y guardar la de hoy. */
async function pedirScoring(metodo: 'GET' | 'POST'): Promise<Respuesta> {
  try {
    const res = await fetch('/api/admin/teacher-score-v2', { method: metodo, cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: body?.error ?? `Error ${res.status}` };
    return { ok: true, filas: body.filas ?? [], fecha: body.fecha ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'No se pudo cargar el scoring v2.' };
  }
}

export default function ScoringV2Tab({ viejos }: { viejos: PuntajeViejo[] }) {
  const [filas, setFilas] = useState<FilaSnapshot[]>([]);
  const [fecha, setFecha] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [recalculando, setRecalculando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orden, setOrden] = useState<{ col: Columna; dir: 'asc' | 'desc' }>({ col: 'score', dir: 'desc' });
  const [abierto, setAbierto] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const r = await pedirScoring('GET');
      if (!vivo) return;
      if (r.ok) { setFilas(r.filas); setFecha(r.fecha); } else setError(r.error);
      setCargando(false);
    })();
    return () => { vivo = false; };
  }, []);

  async function recalcular() {
    setRecalculando(true);
    setError(null);
    const r = await pedirScoring('POST');
    if (r.ok) { setFilas(r.filas); setFecha(r.fecha); } else setError(r.error);
    setRecalculando(false);
  }

  const porViejo = useMemo(() => new Map(viejos.map(v => [v.teacherId, v])), [viejos]);

  const ordenadas = useMemo(() => {
    const valor = (f: FilaSnapshot): number | string | null => {
      const d = f.details as Detalle;
      const v = porViejo.get(f.teacher_id);
      switch (orden.col) {
        case 'nombre': return (d.teacherName ?? f.teacher_id).toLowerCase();
        case 'score': return f.score;
        case 'level': return ORDEN_NIVEL[f.level] ?? 0;
        case 'confidence': return ORDEN_CONF[f.confidence] ?? 0;
        case 'retencion': return f.retention_score;
        case 'cumplimiento': return f.compliance_score;
        case 'riesgo': return f.risk_score;
        case 'calidad': return f.quality_score;
        case 'alumnosMes': return d.exposicion?.alumnosMes ?? null;
        case 'bajas': return d.exposicion?.bajas ?? null;
        case 'viejo': return v?.score ?? null;
        case 'nivelViejo': return v ? v.level * 10 - (v.blocked ? 5 : 0) : null;
      }
    };
    return [...filas].sort((a, b) => {
      const x = valor(a), y = valor(b);
      // Los "sin dato" van siempre al final, ordenes como ordenes.
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return orden.dir === 'asc' ? c : -c;
    });
  }, [filas, orden, porViejo]);

  const academia = (filas[0]?.details as Detalle | undefined)?.academia;

  function ordenarPor(col: Columna) {
    setOrden(o => (o.col === col ? { col, dir: o.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'nombre' ? 'asc' : 'desc' }));
  }

  const celda: React.CSSProperties = { padding: '10px 10px', fontSize: 13, whiteSpace: 'nowrap' };

  return (
    <div>
      <div style={{
        background: FONDO, border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginBottom: 14,
        display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>
            Scoring v2 <span style={{ background: AMARILLO, color: '#3a2c00', fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 6, marginLeft: 4 }}>BETA</span>
          </div>
          Últimos 90 días · {fecha ? `foto del ${ddmmaaaa(fecha)}` : 'todavía sin foto guardada'}
          {academia && <> · academia: {fmt(academia.tasaBajas === null ? null : academia.tasaBajas * 100)} bajas cada 100 alumnos-mes, habla mediana {fmt(academia.medianaHabla)}% · {academia.bajasDuplicadasDescartadas} bajas duplicadas descartadas</>}
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No cambia nada en la app: el scoring viejo sigue mandando. &quot;En revisión&quot; es solo una marca, no bloquea.</div>
        </div>
        <button onClick={() => void recalcular()} disabled={recalculando}
          style={{
            background: VERDE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px',
            fontWeight: 700, fontSize: 13, cursor: recalculando ? 'wait' : 'pointer', opacity: recalculando ? 0.7 : 1,
          }}>
          {recalculando ? 'Recalculando…' : 'Recalcular ahora'}
        </button>
      </div>

      {error && (
        <div style={{ background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid var(--danger-border)', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {cargando ? (
        <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>
      ) : filas.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
          Todavía no hay ninguna foto del scoring v2. Tocá &quot;Recalcular ahora&quot; para generar la de hoy.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: FONDO, borderBottom: '1px solid var(--border)' }}>
                {COLUMNAS.map(c => (
                  <th key={c.id} style={{ ...celda, padding: 0, textAlign: c.num ? 'right' : 'left' }}
                    aria-sort={orden.col === c.id ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button onClick={() => ordenarPor(c.id)} style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: '10px 10px', minHeight: 0,
                      width: '100%', textAlign: c.num ? 'right' : 'left', fontSize: 11, fontWeight: 700,
                      color: orden.col === c.id ? VERDE : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3,
                    }}>
                      {c.label}{orden.col === c.id ? (orden.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordenadas.map(f => {
                const d = f.details as Detalle;
                const v = porViejo.get(f.teacher_id);
                const open = abierto === f.teacher_id;
                const num = (x: number | null | undefined) => (
                  <td style={{ ...celda, textAlign: 'right', fontWeight: 600, color: colorPuntaje(x) }}>{fmt(x)}</td>
                );
                return (
                  <Fragment key={f.teacher_id}>
                    <tr onClick={() => setAbierto(open ? null : f.teacher_id)}
                      style={{ borderBottom: open ? 'none' : '1px solid var(--border)', cursor: 'pointer', background: open ? 'rgba(30,158,58,0.05)' : 'transparent' }}>
                      <td style={{ ...celda, fontWeight: 700, color: 'var(--text-primary)' }}>
                        <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{open ? '▾' : '▸'}</span>
                        {d.teacherName ?? f.teacher_id}
                      </td>
                      <td style={{ ...celda, textAlign: 'right', fontWeight: 800, fontSize: 15, color: colorPuntaje(f.score) }}>{fmt(f.score)}</td>
                      <td style={celda}><NivelBadge level={f.level} /></td>
                      <td style={{ ...celda, color: 'var(--text-secondary)' }}>{f.confidence}</td>
                      {num(f.retention_score)}
                      {num(f.compliance_score)}
                      {num(f.risk_score)}
                      {num(f.quality_score)}
                      <td style={{ ...celda, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmt(d.exposicion?.alumnosMes)}</td>
                      <td style={{ ...celda, textAlign: 'right', color: 'var(--text-secondary)' }}>{d.exposicion?.bajas ?? '—'}</td>
                      <td style={{ ...celda, textAlign: 'right', color: 'var(--text-muted)' }}>{v ? v.score : '—'}</td>
                      <td style={{ ...celda, color: 'var(--text-muted)' }}>
                        {v ? NIVEL_VIEJO[v.level] ?? v.level : '—'}{v?.blocked ? ' · bloqueado' : ''}
                      </td>
                    </tr>
                    {open && (
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={COLUMNAS.length} style={{ padding: 0 }}><DetalleProfe d={d} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
