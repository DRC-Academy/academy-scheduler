'use client';

// Panel admin: quién usa la generación de clases con IA y quién no.
//
// La pregunta que contesta esta pestaña es "¿a qué profesores tengo que
// enseñarles la herramienta?", así que el resumen por profesor incluye a TODOS,
// también a los que tienen cero — que son justamente los que interesan y los que
// no aparecerían nunca si la tabla se construyera solo desde el registro.
//
// EGRESS: solo lee `ai_class_generations`, que son seis campos cortos por fila.
// Ni transcripciones ni contenido de clases (ver supabase-ai-usage.sql).

import { useEffect, useMemo, useState } from 'react';
import {
  fetchAiGenerations, summarizeByTeacher, sortUsage, norm, ORIGIN_LABEL,
  type AiGenerationRow, type TeacherUsage, type UsageSort, type GenerationOrigin,
} from '@/lib/aiUsage';
import type { Teacher } from '@/types';

const VERDE = '#1E9E3A';
const AMARILLO = '#FFC400';

type Vista = 'registro' | 'profesores';

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-ES', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Días transcurridos, para el "hace X días" de la última vez. */
function diasDesde(iso: string, ahora: number): number {
  return Math.floor((ahora - new Date(iso).getTime()) / 86_400_000);
}

const th: React.CSSProperties = {
  padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', textAlign: 'left',
};
const td: React.CSSProperties = { padding: '10px 14px', whiteSpace: 'nowrap' };

const input: React.CSSProperties = {
  padding: '7px 11px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  fontSize: 13, fontFamily: 'inherit',
};

export default function AiUsageTab({ teachers }: { teachers: Teacher[] }) {
  const [rows, setRows] = useState<AiGenerationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [faltaSql, setFaltaSql] = useState(false);
  const [vista, setVista] = useState<Vista>('profesores');

  // Filtros del registro detallado.
  const [teacherFilter, setTeacherFilter] = useState<'all' | string>('all');
  const [originFilter, setOriginFilter] = useState<'all' | GenerationOrigin>('all');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [query, setQuery] = useState('');

  const [sort, setSort] = useState<UsageSort>('sin-usar');

  // El "ahora" se congela al cargar: leerlo en cada render haría que las celdas
  // de "hace X días" se movieran solas entre renders.
  const [ahora, setAhora] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAiGenerations();
      if (cancelled) return;
      setRows(res.rows);
      setFaltaSql(res.missingTable);
      setAhora(Date.now());
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const resumen = useMemo(() => summarizeByTeacher(rows, teachers), [rows, teachers]);
  const ordenados = useMemo(() => sortUsage(resumen.perTeacher, sort), [resumen, sort]);

  const filtradas = useMemo(() => {
    const q = norm(query);
    // `hasta` cubre el día entero: sin esto, filtrar "hasta hoy" escondía todo
    // lo de hoy, que es justo lo que el admin acaba de ir a mirar.
    const hastaFin = hasta ? `${hasta}T23:59:59.999Z` : null;
    return rows.filter(r => {
      if (teacherFilter !== 'all') {
        const suyo = r.teacher_id === teacherFilter
          || norm(r.teacher_name) === norm(teachers.find(t => t.id === teacherFilter)?.name);
        if (!suyo) return false;
      }
      if (originFilter !== 'all' && r.origin !== originFilter) return false;
      if (desde && r.created_at < desde) return false;
      if (hastaFin && r.created_at > hastaFin) return false;
      if (q && !norm(r.teacher_name).includes(q) && !norm(r.student_name).includes(q)) return false;
      return true;
    });
  }, [rows, teacherFilter, originFilter, desde, hasta, query, teachers]);

  const sinUsar = resumen.totalProfesores - resumen.usan;
  const pct = resumen.totalProfesores > 0
    ? Math.round((resumen.usan / resumen.totalProfesores) * 100)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {faltaSql && (
        <div style={{
          background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.45)',
          borderRadius: 10, padding: '13px 16px', fontSize: 13.5, color: 'var(--text-primary)',
        }}>
          <strong>Falta correr <code>supabase-ai-usage.sql</code> en Supabase.</strong> Hasta
          entonces no se registra ninguna generación y esta pestaña se queda vacía. Las clases
          se siguen generando con normalidad.
        </div>
      )}

      {/* ── Contador ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12,
      }}>
        <Tile
          valor={`${resumen.usan} de ${resumen.totalProfesores}`}
          etiqueta="profesores usan la generación con IA"
          detalle={`${pct}% de la plantilla`}
          acento={VERDE}
        />
        <Tile
          valor={String(sinUsar)}
          etiqueta={sinUsar === 1 ? 'profesor no la ha usado nunca' : 'profesores no la han usado nunca'}
          detalle={sinUsar > 0 ? 'Aparecen arriba en el resumen' : 'Toda la plantilla la usa'}
          acento={sinUsar > 0 ? AMARILLO : VERDE}
        />
        <Tile
          valor={String(rows.length)}
          etiqueta={rows.length === 1 ? 'clase generada en total' : 'clases generadas en total'}
          detalle={`${rows.filter(r => r.origin === 'transcript').length} pegando la transcripción`}
        />
      </div>

      {/* ── Selector de vista ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {([['profesores', 'Resumen por profesor'], ['registro', 'Registro detallado']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setVista(id)}
            style={{
              padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'inherit',
              border: `1px solid ${vista === id ? VERDE : 'var(--border)'}`,
              background: vista === id ? 'rgba(30,158,58,0.1)' : 'var(--bg-surface)',
              color: vista === id ? '#067647' : 'var(--text-secondary)',
            }}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>Cargando…</div>
      ) : vista === 'profesores' ? (
        <ResumenView
          filas={ordenados} sort={sort} onSort={setSort} ahora={ahora}
          onVerRegistro={id => { setTeacherFilter(id); setVista('registro'); }}
        />
      ) : (
        <RegistroView
          filas={filtradas} total={rows.length} teachers={teachers}
          teacherFilter={teacherFilter} setTeacherFilter={setTeacherFilter}
          originFilter={originFilter} setOriginFilter={setOriginFilter}
          desde={desde} setDesde={setDesde} hasta={hasta} setHasta={setHasta}
          query={query} setQuery={setQuery}
        />
      )}
    </div>
  );
}

// ── Contadores de cabecera ───────────────────────────────────────────────────

function Tile({ valor, etiqueta, detalle, acento }: {
  valor: string; etiqueta: string; detalle?: string; acento?: string;
}) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '15px 17px',
    }}>
      <div style={{
        fontSize: 26, fontWeight: 700, lineHeight: 1.1,
        color: acento ?? 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
      }}>{valor}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>{etiqueta}</div>
      {detalle && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>{detalle}</div>}
    </div>
  );
}

// ── Vista 1: resumen por profesor ────────────────────────────────────────────

function ResumenView({ filas, sort, onSort, ahora, onVerRegistro }: {
  filas: TeacherUsage[];
  sort: UsageSort;
  onSort: (s: UsageSort) => void;
  ahora: number;
  onVerRegistro: (teacherId: string) => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ordenar:</span>
        {([['sin-usar', 'Los que no la usan primero'], ['mas-activos', 'Más activos primero']] as const).map(([id, label]) => (
          <button key={id} onClick={() => onSort(id)}
            style={{
              padding: '5px 11px', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${sort === id ? 'var(--text-secondary)' : 'var(--border)'}`,
              background: sort === id ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
              color: 'var(--text-secondary)', fontWeight: sort === id ? 600 : 400,
            }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {filas.length === 0 ? (
          <Vacio texto="No hay profesores que mostrar." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)' }}>
                  <th style={th}>Profesor</th>
                  <th style={th}>Clases generadas</th>
                  <th style={th}>Con transcripción</th>
                  <th style={th}>Última vez</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {filas.map(t => {
                  const nunca = t.total === 0;
                  return (
                    <tr key={t.teacherId || `nm:${t.teacherName}`}
                      style={{
                        borderTop: '1px solid var(--border)',
                        // El aviso se pinta de fondo, no solo con texto gris: en una
                        // tabla larga, el gris se lee como "deshabilitado" y no como
                        // "esto es lo que has venido a mirar".
                        background: nunca ? 'rgba(255,196,0,0.07)' : undefined,
                      }}>
                      <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {t.teacherName}
                        {!t.known && (
                          <span style={{ marginLeft: 7, fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
                            (ya no está en la plantilla)
                          </span>
                        )}
                      </td>
                      <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>
                        {nunca
                          ? <span style={{
                              fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 12,
                              background: 'rgba(255,196,0,0.22)', color: '#B54708',
                            }}>Sin usar</span>
                          : <strong style={{ color: 'var(--text-primary)' }}>{t.total}</strong>}
                      </td>
                      <td style={{ ...td, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                        {nunca ? '—' : t.fromTranscript}
                      </td>
                      <td style={{ ...td, color: 'var(--text-muted)' }}>
                        {t.lastUsed ? <UltimaVez iso={t.lastUsed} ahora={ahora} /> : '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {!nunca && t.teacherId && (
                          <button onClick={() => onVerRegistro(t.teacherId)}
                            style={{
                              padding: '4px 10px', borderRadius: 7, border: '1px solid var(--border)',
                              background: 'var(--bg-surface-2)', color: 'var(--text-secondary)',
                              cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                            }}>
                            Ver sus clases
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/** Fecha + "hace X días", que es lo que de verdad se mira para detectar a los fríos. */
function UltimaVez({ iso, ahora }: { iso: string; ahora: number }) {
  const dias = ahora ? diasDesde(iso, ahora) : 0;
  const frio = dias > 30;
  return (
    <span>
      {fmtDate(iso)}
      {ahora > 0 && (
        <span style={{ marginLeft: 7, fontSize: 11.5, color: frio ? '#B54708' : 'var(--text-muted)' }}>
          {dias <= 0 ? 'hoy' : dias === 1 ? 'ayer' : `hace ${dias} días`}
        </span>
      )}
    </span>
  );
}

// ── Vista 2: registro detallado ──────────────────────────────────────────────

function RegistroView(p: {
  filas: AiGenerationRow[];
  total: number;
  teachers: Teacher[];
  teacherFilter: string; setTeacherFilter: (v: string) => void;
  originFilter: 'all' | GenerationOrigin; setOriginFilter: (v: 'all' | GenerationOrigin) => void;
  desde: string; setDesde: (v: string) => void;
  hasta: string; setHasta: (v: string) => void;
  query: string; setQuery: (v: string) => void;
}) {
  const filtrando = p.filas.length !== p.total;
  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={p.query} onChange={e => p.setQuery(e.target.value)}
          placeholder="Buscar profesor o alumno…" style={{ ...input, minWidth: 220, flex: '1 1 220px' }} />

        <select value={p.teacherFilter} onChange={e => p.setTeacherFilter(e.target.value)} style={input}>
          <option value="all">Todos los profesores</option>
          {[...p.teachers].sort((a, b) => a.name.localeCompare(b.name, 'es'))
            .map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>

        <select value={p.originFilter} onChange={e => p.setOriginFilter(e.target.value as 'all' | GenerationOrigin)} style={input}>
          <option value="all">Todos los orígenes</option>
          <option value="transcript">Con transcripción</option>
          <option value="directa">Directa</option>
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
          Desde <input type="date" value={p.desde} onChange={e => p.setDesde(e.target.value)} style={input} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
          Hasta <input type="date" value={p.hasta} onChange={e => p.setHasta(e.target.value)} style={input} />
        </label>

        {filtrando && (
          <button onClick={() => {
            p.setQuery(''); p.setTeacherFilter('all'); p.setOriginFilter('all'); p.setDesde(''); p.setHasta('');
          }} style={{ ...input, cursor: 'pointer', color: 'var(--text-secondary)' }}>
            Quitar filtros
          </button>
        )}
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
        {filtrando ? `${p.filas.length} de ${p.total} generaciones` : `${p.total} generaciones`}
      </div>

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {p.filas.length === 0 ? (
          <Vacio texto={p.total === 0
            ? 'Todavía no se ha generado ninguna clase con IA desde que se activó el registro.'
            : 'Ninguna generación coincide con estos filtros.'} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)' }}>
                  <th style={th}>Profesor</th>
                  <th style={th}>Alumno</th>
                  <th style={th}>Origen</th>
                  <th style={th}>Fecha y hora</th>
                </tr>
              </thead>
              <tbody>
                {p.filas.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>{r.teacher_name || '—'}</td>
                    <td style={{ ...td, color: 'var(--text-secondary)' }}>{r.student_name}</td>
                    <td style={td}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 12,
                        background: r.origin === 'transcript' ? 'rgba(30,158,58,0.12)' : 'var(--bg-surface-3)',
                        color: r.origin === 'transcript' ? '#067647' : 'var(--text-muted)',
                      }}>
                        {ORIGIN_LABEL[r.origin] ?? r.origin}
                      </span>
                    </td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{fmtDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Vacio({ texto }: { texto: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)', fontSize: 14 }}>
      {texto}
    </div>
  );
}
