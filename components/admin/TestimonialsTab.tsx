'use client';

// Pestaña admin "Testimoniales" (V5, 07/10/2026): una tarjeta por alumno Y PROFE
// con dos clips cortos del alumno: uno en que habla mal y otro, de OTRA clase con
// el mismo profe, en que habla muy bien. Botones: Sirve / No sirve. Cada ▶ abre
// la grabación de Fathom en el segundo de inicio del clip.
//
// Las parejas las elige el código (lib/testimonialPairs) entre los momentos que
// Haiku sacó de cada clase SOLO de las intervenciones del alumno, y el alumno de
// cada clase lo decide el código por su etiqueta de Fathom (lib/testimonialSpeaker).
// Arriba, el panel del análisis de los transcripts antiguos: se lanza a mano
// (cuesta dinero); los transcripts nuevos se analizan solos al subirse.
//
//   Por revisar = 'detectado' de la V5; primero las de orden normal (la clase
//                 mala antes que la buena), después las de "Orden inverso"
//   Sirven      = 'listo' (y los estados antiguos 'revisado' / 'permiso_alumno')
//   No sirve    = 'descartado' por el admin: oculto, y esa combinación alumno +
//                 profe no se vuelve a proponer

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import {
  dbGetTestimonialCandidates, dbUpdateTestimonialCandidate,
  type TestimonialCandidate,
} from '@/lib/testimonialsDb';
import { clipLabel, type TestimonialClip } from '@/lib/testimonials';

type Vista = 'revisar' | 'sirven';

interface Estado {
  total: number; pending: number; ready: number; excluded: number;
  failed: number; failedRetryable: number; withMoments: number; pairs: number;
}

/** Tandas a la vez: cada una es una función de Vercel de hasta 60 s con 6 transcripts. */
const EN_PARALELO = 3;
/** Coste aproximado por transcript con Haiku 4.5 (~7.000 tokens de entrada y ~500 de salida). */
const COSTE_POR_TRANSCRIPT_USD = 0.01;

const SIRVEN = new Set(['listo', 'revisado', 'permiso_alumno']);
const porRevisar = (c: TestimonialCandidate) => c.status === 'detectado' && !!c.pairTeacherId && c.clips !== null;
const sirve = (c: TestimonialCandidate) => SIRVEN.has(c.status);
const fuerza = (c: TestimonialCandidate) => (c.before.score ?? 0) + (c.after.score ?? 0);

async function post<T>(body: Record<string, unknown>): Promise<T & { error?: string }> {
  try {
    const res = await fetch('/api/admin/testimonial-prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ error: `Error ${res.status} del servidor.` }));
    return res.ok ? data : { ...data, error: data.error ?? `Error ${res.status} del servidor.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) } as T & { error?: string };
  }
}

export default function TestimonialsTab() {
  const { teachers } = useTeachers();
  const [rows, setRows] = useState<TestimonialCandidate[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista>('revisar');
  const [estado, setEstado] = useState<Estado | null>(null);
  const [analizando, setAnalizando] = useState(false);
  const [deshacer, setDeshacer] = useState<{ id: string; nombre: string } | null>(null);
  const vivo = useRef(true);

  const cargar = useCallback(async () => {
    try {
      const c = await dbGetTestimonialCandidates();
      if (!vivo.current) return;
      setRows(c);
      setError(null);
    } catch (e) {
      if (vivo.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** Analiza los transcripts pendientes (o los fallidos) por tandas, EN_PARALELO a la vez. */
  const analizar = useCallback(async (retryFailed: boolean) => {
    setAnalizando(true);
    const trabajador = async () => {
      for (;;) {
        const r = await post<{ claimed?: number; status?: Estado }>({ action: 'tanda', retryFailed });
        if (!vivo.current) return;
        if (r.error) { setError(r.error); return; }
        if (r.status) setEstado(r.status);
        if (!r.claimed) return;
        await cargar();
      }
    };
    await Promise.all(Array.from({ length: EN_PARALELO }, trabajador));
    if (vivo.current) setAnalizando(false);
  }, [cargar]);

  useEffect(() => {
    vivo.current = true;
    (async () => {
      await cargar();
      const e = await post<{ status?: Estado }>({ action: 'estado' });
      if (!vivo.current) return;
      if (e.error) setError(e.error);
      if (e.status) setEstado(e.status);
    })();
    return () => { vivo.current = false; };
  }, [cargar]);

  // El aviso de "Deshacer" se va solo a los 8 s.
  useEffect(() => {
    if (!deshacer) return;
    const t = setTimeout(() => setDeshacer(null), 8_000);
    return () => clearTimeout(t);
  }, [deshacer]);

  const nombreProfe = useCallback((id: string | null) =>
    (id && teachers.find(t => t.id === id)?.name) || 'Sin profe', [teachers]);

  async function cambiar(c: TestimonialCandidate, status: 'listo' | 'detectado' | 'descartado') {
    const r = await dbUpdateTestimonialCandidate(c.id, { status });
    if (r.error) { setError(r.error); return; }
    setDeshacer(status === 'descartado' ? { id: c.id, nombre: c.studentName ?? 'el alumno' } : null);
    await cargar();
  }

  async function deshacerDescarte() {
    if (!deshacer) return;
    const r = await dbUpdateTestimonialCandidate(deshacer.id, { status: 'detectado' });
    setDeshacer(null);
    if (r.error) { setError(r.error); return; }
    await cargar();
  }

  const lista = rows ?? [];
  const revisar = lista.filter(porRevisar)
    .sort((a, b) => Number(a.reverseOrder) - Number(b.reverseOrder) || fuerza(b) - fuerza(a));
  const sirven = lista.filter(sirve);
  const visibles = vista === 'revisar' ? revisar : sirven;

  return (
    <div className="ts">
      <h2 className="ts-title">Testimoniales</h2>

      {estado && <PanelAnalisis estado={estado} analizando={analizando} onAnalizar={analizar} />}

      <div className="ts-tabs" role="tablist">
        <button type="button" role="tab" className="ts-tab" aria-selected={vista === 'revisar'} onClick={() => setVista('revisar')}>
          Por revisar <span className="n">{revisar.length}</span>
        </button>
        <button type="button" role="tab" className="ts-tab" aria-selected={vista === 'sirven'} onClick={() => setVista('sirven')}>
          Sirven <span className="n">{sirven.length}</span>
        </button>
      </div>

      {error && <p className="ts-error">{error}</p>}

      {rows === null ? (
        <p className="ts-vacio">Falta correr <code>supabase-testimoniales-candidatos.sql</code> en Supabase.</p>
      ) : rows === undefined ? (
        <p className="ts-vacio">Cargando…</p>
      ) : visibles.length === 0 ? (
        <p className="ts-vacio">
          {vista === 'revisar'
            ? (estado && estado.pending > 0 ? 'Todavía no hay parejas: analiza los transcripts pendientes.' : 'No hay alumnos por revisar.')
            : 'Todavía no has marcado ninguno como “Sirve”.'}
        </p>
      ) : (
        <div className="ts-lista">
          {visibles.map(c => (
            <Tarjeta key={c.id} c={c} nombreProfe={nombreProfe} onCambiar={s => cambiar(c, s)} />
          ))}
        </div>
      )}

      {deshacer && (
        <div className="ts-toast" role="status">
          {deshacer.nombre}: marcado como “No sirve”.
          <button type="button" className="ts-linkbtn" onClick={deshacerDescarte}>Deshacer</button>
        </div>
      )}
      <style>{ESTILOS}</style>
    </div>
  );
}

function PanelAnalisis({ estado: e, analizando, onAnalizar }: {
  estado: Estado; analizando: boolean; onAnalizar: (retryFailed: boolean) => void;
}) {
  const hechos = e.ready + e.excluded;
  const coste = Math.max(1, Math.round(e.pending * COSTE_POR_TRANSCRIPT_USD));
  return (
    <section className="ts-panel">
      <p className="ts-panel-l">
        Transcripts analizados: <b>{hechos.toLocaleString('es-ES')}</b> de {e.total.toLocaleString('es-ES')}
        {' · '}válidos {e.ready.toLocaleString('es-ES')} · excluidos {e.excluded.toLocaleString('es-ES')}
        {e.failed > 0 && <> · fallidos {e.failed}</>}
      </p>
      {analizando ? (
        <p className="ts-panel-l">Analizando… quedan {e.pending.toLocaleString('es-ES')}. Deja la pestaña abierta.</p>
      ) : (
        <div className="ts-panel-acc">
          {e.pending > 0 && (
            <button type="button" className="ts-btn ts-si" onClick={() => onAnalizar(false)}>
              Analizar {e.pending.toLocaleString('es-ES')} pendientes (~{coste} $)
            </button>
          )}
          {e.failedRetryable > 0 && (
            <button type="button" className="ts-btn ts-no" onClick={() => onAnalizar(true)}>
              Reintentar {e.failedRetryable} fallidos
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Tarjeta({ c, nombreProfe, onCambiar }: {
  c: TestimonialCandidate;
  nombreProfe: (id: string | null) => string;
  onCambiar: (s: 'listo' | 'detectado' | 'descartado') => void;
}) {
  const esSirve = sirve(c);
  const malo = c.clips?.malos[0];
  const bueno = c.clips?.buenos[0];
  const v5 = !!c.pairTeacherId;
  const etiquetas = [...new Set([malo?.speakerLabel, bueno?.speakerLabel, c.studentLabel].filter(Boolean))];
  return (
    <article className="ts-card">
      <header className="ts-card-h">
        <span className="ts-alumno">{c.studentName ?? 'Alumno sin nombre'}</span>
        <span className="ts-profe">Profe: {nombreProfe(c.pairTeacherId ?? c.after.teacherId)}</span>
      </header>
      {v5 && (
        <div className="ts-checks">
          <span className="ts-ok">Mismo alumno ✓ · Mismo profe ✓</span>
          {c.reverseOrder && <span className="ts-inverso">Orden inverso</span>}
          {etiquetas.length > 0 && <span className="ts-fathom">En Fathom: {etiquetas.join(' / ')}</span>}
        </div>
      )}
      {c.aiSummary && <p className="ts-resumen">{c.aiSummary}</p>}

      {malo && bueno ? (
        <>
          <Clip tipo="malo" k={malo} />
          <Clip tipo="bueno" k={bueno} />
        </>
      ) : (
        <p className="ts-sin">Sin clips.</p>
      )}

      <footer className="ts-acc">
        <button type="button" className="ts-btn ts-si" aria-pressed={esSirve}
          onClick={() => onCambiar(esSirve ? 'detectado' : 'listo')}
          title={esSirve ? 'Pulsa para devolverlo a “Por revisar”' : undefined}>
          ✓ Sirve
        </button>
        <button type="button" className="ts-btn ts-no" onClick={() => onCambiar('descartado')}>✗ No sirve</button>
      </footer>
    </article>
  );
}

function Clip({ tipo, k }: { tipo: 'malo' | 'bueno'; k: TestimonialClip }) {
  return (
    <section className={`ts-momentos is-${tipo === 'malo' ? 'malos' : 'buenos'}`}>
      <span className="ts-et">{tipo === 'malo' ? 'Habla mal' : 'Habla muy bien'}</span>
      <div className="ts-clip">
        {k.fathomUrl
          ? <a className="ts-ver" href={k.fathomUrl} target="_blank" rel="noopener noreferrer">▶ {clipLabel(k)}</a>
          : <span className="ts-ver is-sin">{clipLabel(k)} · Sin grabación</span>}
        <blockquote className="ts-cita">“{k.excerpt}”</blockquote>
        {k.why && <p className="ts-why">{k.why}</p>}
      </div>
    </section>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
// Marca: verde #1E9E3A, amarillo #FFC400, fondo #F7F7F5, azul #2563eb, Radio Canada.
const ESTILOS = `
.ts { --verde: #1E9E3A; --amarillo: #FFC400; --fondo: #F7F7F5; --azul: #2563eb; --tinta: #1a1c1a; --gris: #6E6E66; --linea: #E6E7E2;
  font-family: var(--font-app); color: var(--tinta); }
.ts-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 12px; }

.ts-tabs { display: inline-flex; gap: 4px; padding: 4px; border-radius: 12px; background: #ECECE8; margin-bottom: 14px; }
.ts-tab { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; border: 0; border-radius: 9px;
  background: transparent; font-family: inherit; font-size: 14px; font-weight: 600; color: #4A4A4A; cursor: pointer; }
.ts-tab[aria-selected="true"] { background: #fff; color: var(--tinta); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
.ts-tab .n { min-width: 22px; padding: 1px 7px; border-radius: 999px; background: rgba(30,158,58,0.12); color: var(--verde); font-size: 12px; font-weight: 700; text-align: center; }

.ts-aviso { margin: 0 0 12px; font-size: 13.5px; color: #4A4A4A; }
.ts-panel { margin: 0 0 14px; padding: 12px 14px; border-radius: 12px; background: var(--fondo); display: flex; flex-direction: column; gap: 8px; }
.ts-panel-l { margin: 0; font-size: 13.5px; color: #4A4A4A; font-variant-numeric: tabular-nums; }
.ts-panel-acc { display: flex; gap: 8px; flex-wrap: wrap; }
.ts-checks { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 13px; }
.ts-ok { font-weight: 700; color: var(--verde); }
.ts-inverso { padding: 2px 8px; border-radius: 999px; background: rgba(255,196,0,0.2); color: #8a6a00; font-weight: 700; font-size: 12px; }
.ts-fathom { color: var(--gris); }
.ts-error { margin: 0 0 12px; font-size: 13.5px; font-weight: 600; color: #C81E1E; }
.ts-vacio { margin: 0; padding: 28px 16px; border-radius: 14px; background: var(--fondo); font-size: 14px; color: var(--gris); text-align: center; }
.ts-linkbtn { border: 0; background: none; padding: 0 0 0 6px; min-height: 0; font-family: inherit; font-size: inherit; font-weight: 700; color: var(--azul); cursor: pointer; text-decoration: underline; }

.ts-lista { display: grid; gap: 14px; }
.ts-card { background: #fff; border: 1px solid var(--linea); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.ts-card-h { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.ts-alumno { font-size: 17px; font-weight: 700; }
.ts-profe { font-size: 14px; color: var(--gris); }

.ts-momentos { background: var(--fondo); border-radius: 12px; padding: 12px 14px; border-left: 4px solid var(--amarillo); display: flex; flex-direction: column; gap: 8px; }
.ts-momentos.is-buenos { border-left-color: var(--verde); }
.ts-et { font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--gris); }
.ts-momentos.is-malos .ts-et { color: #8a6a00; }
.ts-momentos.is-buenos .ts-et { color: var(--verde); }
.ts-clip { display: flex; flex-direction: column; gap: 2px; }
.ts-ver { align-self: flex-start; display: inline-flex; align-items: center; min-height: 32px; font-size: 14px; font-weight: 700;
  color: var(--azul); text-decoration: none; font-variant-numeric: tabular-nums; }
.ts-ver:hover { text-decoration: underline; }
.ts-ver.is-sin { color: var(--gris); font-weight: 600; }
.ts-cita { margin: 0; font-size: 15px; line-height: 1.5; color: var(--tinta); }
.ts-why { margin: 0; font-size: 13px; line-height: 1.45; color: var(--gris); }
.ts-sin { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--gris); }

.ts-resumen { margin: 0; font-size: 14.5px; line-height: 1.55; color: #333; }

.ts-acc { display: flex; gap: 10px; flex-wrap: wrap; }
.ts-btn { min-height: 44px; padding: 0 18px; border-radius: 10px; font-family: inherit; font-size: 14.5px; font-weight: 700; cursor: pointer; }
.ts-si { border: 1.5px solid var(--verde); background: #fff; color: var(--verde); }
.ts-si:hover { background: rgba(30,158,58,0.08); }
.ts-si[aria-pressed="true"] { background: var(--verde); color: #fff; }
.ts-no { border: 1.5px solid var(--linea); background: #fff; color: #4A4A4A; }
.ts-no:hover { border-color: #C81E1E; color: #C81E1E; }

.ts-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 50; display: flex; align-items: center; gap: 4px;
  max-width: calc(100vw - 32px); padding: 12px 16px; border-radius: 12px; background: var(--tinta); color: #fff; font-size: 14px; box-shadow: 0 6px 20px rgba(0,0,0,0.2); }
.ts-toast .ts-linkbtn { color: var(--amarillo); }

@media (max-width: 760px) {
  .ts-card { padding: 14px; }
  .ts-tabs { display: flex; }
  .ts-tab { flex: 1; justify-content: center; }
  .ts-acc .ts-btn { flex: 1; }
  .ts-ver { min-height: 44px; }
  /* Encima de la barra inferior de AdminNavMovil. */
  .ts-toast { bottom: 84px; }
}
/* En el teléfono el título ya lo pone la cabecera de AdminNavMovil. */
@media (max-width: 767px) {
  .ts-title { display: none; }
}
`;
