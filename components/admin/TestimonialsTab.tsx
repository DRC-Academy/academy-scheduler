'use client';

// Pestaña admin "Testimoniales": una tarjeta por alumno que mejoró, con sus
// clips cortos (hasta 3 momentos malos de sus primeras clases y hasta 3 buenos
// de las últimas) y dos botones: Sirve / No sirve. Cada ▶ abre la grabación de
// Fathom en el segundo de inicio del clip.
//
// Solo se enseñan parejas con los clips ya preparados por la IA. Al abrir la
// pestaña se pasa la detección por todos los alumnos y se preparan, de una en
// una, las que falten (app/api/admin/testimonial-prepare).
//
//   Por revisar = 'detectado' con clips listos
//   Sirven      = 'listo' (y los estados antiguos 'revisado' / 'permiso_alumno')
//   No sirve    = 'descartado' por el admin: oculto, y el alumno no se vuelve a proponer
//
// Lo que ya no se enseña (notas sueltas, avisos al profe de antes de oct/2026,
// notas del admin…) sigue guardado en la base. El profesor no ve nada de esto.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import {
  dbGetTestimonialCandidates, dbGetStudentTrends, dbUpdateTestimonialCandidate,
  type TestimonialCandidate,
} from '@/lib/testimonialsDb';
import { improvementLine, clipLabel, type StudentTrend, type TestimonialClip } from '@/lib/testimonials';

type Vista = 'revisar' | 'sirven';
interface Queue { pending: number; failed: number }

const SIRVEN = new Set(['listo', 'revisado', 'permiso_alumno']);
const porRevisar = (c: TestimonialCandidate) => c.status === 'detectado' && c.aiReviewStatus === 'ready' && c.clips !== null;
const sirve = (c: TestimonialCandidate) => SIRVEN.has(c.status);

async function post(body: Record<string, unknown>): Promise<{ outcome?: string; queue?: Queue; error?: string }> {
  try {
    const res = await fetch('/api/admin/testimonial-prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ error: `Error ${res.status} del servidor.` }));
    return res.ok ? data : { error: data.error ?? `Error ${res.status} del servidor.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export default function TestimonialsTab() {
  const { teachers } = useTeachers();
  const [rows, setRows] = useState<TestimonialCandidate[] | null | undefined>(undefined);
  const [trends, setTrends] = useState<Map<string, StudentTrend>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista>('revisar');
  const [queue, setQueue] = useState<Queue | null>(null);
  const [preparando, setPreparando] = useState(false);
  const [deshacer, setDeshacer] = useState<{ id: string; nombre: string } | null>(null);
  const vivo = useRef(true);

  const cargar = useCallback(async () => {
    try {
      const c = await dbGetTestimonialCandidates();
      if (!vivo.current) return;
      setRows(c);
      if (c) {
        const t = await dbGetStudentTrends([...new Set(c.filter(x => porRevisar(x) || sirve(x)).map(x => x.studentGroup))]);
        if (vivo.current) setTrends(t);
      }
      setError(null);
    } catch (e) {
      if (vivo.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** Prepara de una en una las parejas sin clips, recargando al terminar cada una. */
  const preparar = useCallback(async (retryFailed: boolean) => {
    setPreparando(true);
    for (;;) {
      const r = await post({ action: 'preparar', retryFailed });
      if (!vivo.current) return;
      if (r.error) { setError(r.error); break; }
      if (r.queue) setQueue(r.queue);
      if (r.outcome === 'lista') await cargar();
      if (r.outcome === 'nada' || r.outcome === 'sin_tiempo') break;
    }
    if (vivo.current) setPreparando(false);
  }, [cargar]);

  useEffect(() => {
    vivo.current = true;
    (async () => {
      await cargar();
      const d = await post({ action: 'detectar' });
      if (!vivo.current) return;
      if (d.error) { setError(d.error); return; }
      if (d.queue) setQueue(d.queue);
      if (d.queue && d.queue.pending > 0) await preparar(false);
    })();
    return () => { vivo.current = false; };
  }, [cargar, preparar]);

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
  const revisar = lista.filter(porRevisar);
  const sirven = lista.filter(sirve);
  const visibles = vista === 'revisar' ? revisar : sirven;

  return (
    <div className="ts">
      <h2 className="ts-title">Testimoniales</h2>

      <div className="ts-tabs" role="tablist">
        <button type="button" role="tab" className="ts-tab" aria-selected={vista === 'revisar'} onClick={() => setVista('revisar')}>
          Por revisar <span className="n">{revisar.length}</span>
        </button>
        <button type="button" role="tab" className="ts-tab" aria-selected={vista === 'sirven'} onClick={() => setVista('sirven')}>
          Sirven <span className="n">{sirven.length}</span>
        </button>
      </div>

      {(preparando || (queue && queue.pending > 0)) && (
        <p className="ts-aviso">Preparando los clips de {queue?.pending || 'algunos'} {queue?.pending === 1 ? 'alumno' : 'alumnos'}… Aparecerán aquí al terminar.</p>
      )}
      {!preparando && queue && queue.failed > 0 && (
        <p className="ts-aviso">
          {queue.failed === 1 ? '1 alumno no se pudo preparar.' : `${queue.failed} alumnos no se pudieron preparar.`}{' '}
          <button type="button" className="ts-linkbtn" onClick={() => preparar(true)}>Reintentar</button>
        </p>
      )}
      {error && <p className="ts-error">{error}</p>}

      {rows === null ? (
        <p className="ts-vacio">Falta correr <code>supabase-testimoniales-candidatos.sql</code> en Supabase.</p>
      ) : rows === undefined ? (
        <p className="ts-vacio">Cargando…</p>
      ) : visibles.length === 0 ? (
        <p className="ts-vacio">
          {vista === 'revisar' ? 'No hay alumnos por revisar.' : 'Todavía no has marcado ninguno como “Sirve”.'}
        </p>
      ) : (
        <div className="ts-lista">
          {visibles.map(c => (
            <Tarjeta key={c.id} c={c} trend={trends.get(c.studentGroup)} nombreProfe={nombreProfe} onCambiar={s => cambiar(c, s)} />
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

function Tarjeta({ c, trend, nombreProfe, onCambiar }: {
  c: TestimonialCandidate; trend: StudentTrend | undefined;
  nombreProfe: (id: string | null) => string;
  onCambiar: (s: 'listo' | 'detectado' | 'descartado') => void;
}) {
  const pa = nombreProfe(c.before.teacherId), pd = nombreProfe(c.after.teacherId);
  const esSirve = sirve(c);
  const mejora = trend
    ? improvementLine(trend.firstMean, trend.lastMean)
    : `Nota de ${c.before.score ?? '?'} → ${c.after.score ?? '?'}`;
  return (
    <article className="ts-card">
      <header className="ts-card-h">
        <span className="ts-alumno">{c.studentName ?? 'Alumno sin nombre'}</span>
        <span className="ts-profe">Profe: {pa === pd ? pd : `${pa} → ${pd}`}</span>
      </header>

      <section className="ts-mejora">
        <p className="ts-mejora-l">{mejora}</p>
        {c.aiSummary && <p className="ts-resumen">{c.aiSummary}</p>}
      </section>

      {c.clips ? (
        <>
          <Momentos tipo="malos" clips={c.clips.malos} />
          <Momentos tipo="buenos" clips={c.clips.buenos} />
        </>
      ) : (
        <p className="ts-sin">Preparando los clips…</p>
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

function Momentos({ tipo, clips }: { tipo: 'malos' | 'buenos'; clips: TestimonialClip[] }) {
  return (
    <section className={`ts-momentos is-${tipo}`}>
      <span className="ts-et">{tipo === 'malos' ? 'Momentos malos' : 'Momentos buenos'}</span>
      <ul className="ts-clips">
        {clips.map(k => (
          <li key={`${k.analysisId}_${k.start}`} className="ts-clip">
            {k.fathomUrl
              ? <a className="ts-ver" href={k.fathomUrl} target="_blank" rel="noopener noreferrer">▶ {clipLabel(k)}</a>
              : <span className="ts-ver is-sin">{clipLabel(k)} · Sin grabación</span>}
            <blockquote className="ts-cita">“{k.excerpt}”</blockquote>
            {k.why && <p className="ts-why">{k.why}</p>}
          </li>
        ))}
      </ul>
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
.ts-clips { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.ts-clip { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-top: 1px solid var(--linea); }
.ts-clip:first-child { border-top: 0; padding-top: 2px; }
.ts-ver { align-self: flex-start; display: inline-flex; align-items: center; min-height: 32px; font-size: 14px; font-weight: 700;
  color: var(--azul); text-decoration: none; font-variant-numeric: tabular-nums; }
.ts-ver:hover { text-decoration: underline; }
.ts-ver.is-sin { color: var(--gris); font-weight: 600; }
.ts-cita { margin: 0; font-size: 15px; line-height: 1.5; color: var(--tinta); }
.ts-why { margin: 0; font-size: 13px; line-height: 1.45; color: var(--gris); }
.ts-sin { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--gris); }

.ts-mejora { display: flex; flex-direction: column; gap: 4px; }
.ts-mejora-l { margin: 0; font-size: 16px; font-weight: 700; color: var(--verde); font-variant-numeric: tabular-nums; }
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
