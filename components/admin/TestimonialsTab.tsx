'use client';

// Pestaña admin "Testimoniales": parejas de clases del mismo alumno donde pasó de
// trabarse hablando inglés a hablar con soltura. Una fila por pareja; al abrirla,
// los dos fragmentos con su minuto, el resumen de la IA y las dos grabaciones.
//
// Las parejas las detecta el servidor (lib/testimonialStore) cada vez que un
// transcript recibe su nota de fluidez. Aquí solo se leen y se mueven de estado:
//   detectado → revisado → permiso_alumno → listo      (o descartado)
// Descartar a mano bloquea al alumno: no se le vuelve a proponer.
//
// No avisa a nadie todavía (fase 2/3, 30/09/2026).

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, X } from 'lucide-react';
import { useTeachers } from '@/lib/TeachersContext';
import {
  dbGetTestimonialCandidates, dbUpdateTestimonialCandidate,
  TESTIMONIAL_STATUSES, STATUS_LABEL,
  type TestimonialCandidate, type TestimonialStatus, type TestimonialSide,
} from '@/lib/testimonialsDb';
import FluencyBackfillPanel from '@/components/admin/FluencyBackfillPanel';

type FiltroEstado = 'activas' | TestimonialStatus | 'todas';

const FILTROS: Array<{ id: FiltroEstado; label: string }> = [
  { id: 'activas', label: 'Activas' },
  ...TESTIMONIAL_STATUSES.map(s => ({ id: s as FiltroEstado, label: STATUS_LABEL[s] })),
  { id: 'todas', label: 'Todas' },
];

const pasaEstado = (c: TestimonialCandidate, f: FiltroEstado) =>
  f === 'todas' || (f === 'activas' ? c.status !== 'descartado' : c.status === f);

/** "14/07/2026" */
function fecha(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function Estado({ s }: { s: TestimonialStatus }) {
  return <span className={`ts-est is-${s}`}>{STATUS_LABEL[s]}</span>;
}

export default function TestimonialsTab() {
  const { teachers } = useTeachers();
  const [rows, setRows] = useState<TestimonialCandidate[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<FiltroEstado>('activas');
  const [profe, setProfe] = useState('');
  const [abierta, setAbierta] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try { setRows(await dbGetTestimonialCandidates()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await dbGetTestimonialCandidates();
        if (!cancelled) setRows(r);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const nombreProfe = useCallback((id: string | null) =>
    (id && teachers.find(t => t.id === id)?.name) || 'Sin profe', [teachers]);

  const lista = useMemo(() => rows ?? [], [rows]);
  const profesEnLista = useMemo(() => {
    const ids = new Set(lista.flatMap(c => [c.before.teacherId, c.after.teacherId]).filter(Boolean) as string[]);
    return [...ids].map(id => ({ id, name: nombreProfe(id) })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [lista, nombreProfe]);

  const porProfe = lista.filter(c => !profe || c.before.teacherId === profe || c.after.teacherId === profe);
  const visibles = porProfe.filter(c => pasaEstado(c, filtro));
  const cuenta = (f: FiltroEstado) => porProfe.filter(c => pasaEstado(c, f)).length;

  return (
    <div className="ts">
      <div className="ts-head">
        <div>
          <h2 className="ts-title">Testimoniales</h2>
          <p className="ts-sub">Alumnos que en una clase vieja se trababan hablando inglés y en una reciente hablan con soltura.</p>
        </div>
      </div>

      <FluencyBackfillPanel onPairs={cargar} />

      {rows === null ? (
        <div className="adm-card ts-vacio">Falta correr <code>supabase-testimoniales-candidatos.sql</code> en Supabase.</div>
      ) : (
        <div className="adm-card ts-lista">
          <div className="ts-ctl">
            <div className="ts-chips" role="group" aria-label="Filtrar por estado">
              {FILTROS.map(f => (
                <button key={f.id} type="button" className="ts-chip" aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>
                  {f.label} <span className="n">{cuenta(f.id)}</span>
                </button>
              ))}
            </div>
            <label className="ts-sel">
              <span className="ts-sel-l">Profe</span>
              <select value={profe} onChange={e => setProfe(e.target.value)}>
                <option value="">Todos</option>
                {profesEnLista.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {profe && <button type="button" className="ts-sel-x" aria-label="Quitar filtro de profe" onClick={() => setProfe('')}><X size={14} /></button>}
            </label>
          </div>

          {error && <p className="ts-error">{error}</p>}
          {rows === undefined ? (
            <p className="ts-vacio">Cargando…</p>
          ) : visibles.length === 0 ? (
            <p className="ts-vacio">
              {lista.length === 0
                ? 'Todavía no hay parejas. Aparecen solas a medida que los transcripts reciben su nota de fluidez.'
                : 'Ninguna pareja con estos filtros.'}
            </p>
          ) : (
            <>
              <div className="ts-row head" aria-hidden>
                <span>Alumno</span><span>Profe</span><span>Antes</span><span>Después</span><span>Notas</span><span>Mejora</span><span>Estado</span><span />
              </div>
              {visibles.map(c => {
                const open = abierta === c.id;
                const pa = nombreProfe(c.before.teacherId), pd = nombreProfe(c.after.teacherId);
                return (
                  <Fragment key={c.id}>
                    <button type="button" className={`ts-row${open ? ' open' : ''}`} aria-expanded={open}
                      onClick={() => setAbierta(open ? null : c.id)}>
                      <span className="ts-al">{c.studentName ?? 'Alumno sin nombre'}</span>
                      <span className="ts-pr">{pa === pd ? pd : `${pa} → ${pd}`}</span>
                      <span className="ts-cl"><span className="ts-ml">Antes </span>Clase {c.before.classNumber ?? '?'} · {fecha(c.before.classDate)}</span>
                      <span className="ts-cl"><span className="ts-ml">Después </span>Clase {c.after.classNumber ?? '?'} · {fecha(c.after.classDate)}</span>
                      <span className="ts-no">{c.before.score} → {c.after.score}</span>
                      <span className="ts-me">+{c.improvement}</span>
                      <span className="ts-es"><Estado s={c.status} /></span>
                      <ChevronDown size={16} className="ts-ch" aria-hidden />
                    </button>
                    {open && <Detalle c={c} onSaved={cargar} />}
                  </Fragment>
                );
              })}
            </>
          )}
        </div>
      )}
      <style>{ESTILOS}</style>
    </div>
  );
}

function Lado({ titulo, s, tono }: { titulo: string; s: TestimonialSide; tono: 'antes' | 'despues' }) {
  return (
    <div className={`ts-lado is-${tono}`}>
      <div className="ts-lado-h">
        <span className="ts-lado-t">{titulo}</span>
        <span className="ts-lado-m">Clase {s.classNumber ?? '?'} · {fecha(s.classDate)} · nota {s.score ?? '?'}</span>
      </div>
      {s.excerpt
        ? <blockquote className="ts-cita"><span className="ts-min">{s.excerptAt ?? '?'}</span>“{s.excerpt}”</blockquote>
        : <p className="ts-gris">Sin fragmento.</p>}
      {s.fathomUrl
        ? <a className="ts-link" href={s.fathomUrl} target="_blank" rel="noopener noreferrer">
            Abrir grabación{s.excerptAt ? ` (min ${s.excerptAt})` : ''} <ExternalLink size={13} aria-hidden />
          </a>
        : <p className="ts-gris">Sin enlace de grabación: hay que pedírsela al profe.</p>}
    </div>
  );
}

function Detalle({ c, onSaved }: { c: TestimonialCandidate; onSaved: () => void }) {
  const [estado, setEstado] = useState<TestimonialStatus>(c.status);
  const [notas, setNotas] = useState(c.adminNotes ?? '');
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; t: string } | null>(null);
  const cambios = estado !== c.status || (notas.trim() || null) !== (c.adminNotes ?? null);

  async function guardar() {
    setGuardando(true); setAviso(null);
    const r = await dbUpdateTestimonialCandidate(c.id, {
      ...(estado !== c.status ? { status: estado } : {}),
      adminNotes: notas,
    });
    setGuardando(false);
    if (r.error) { setAviso({ ok: false, t: r.error }); return; }
    setAviso({ ok: true, t: 'Guardado.' });
    onSaved();
  }

  return (
    <div className="ts-det">
      <div className="ts-lados">
        <Lado titulo="Antes: donde más se trababa" s={c.before} tono="antes" />
        <Lado titulo="Después: donde mejor habla" s={c.after} tono="despues" />
      </div>

      <div className="ts-ia">
        <span className="ts-ia-t">Revisión de la IA</span>
        {c.aiReviewStatus === 'ready' && c.aiSummary && <p>{c.aiSummary}</p>}
        {c.aiReviewStatus === 'ready' && c.aiIsReal === false && <p className="ts-ia-no">No parece una mejora real: {c.aiReason}</p>}
        {c.aiReviewStatus === 'ready' && c.aiIsReal && c.aiReason && <p className="ts-gris">{c.aiReason}</p>}
        {c.aiReviewStatus === 'pending' && <p className="ts-gris">Pendiente. Se completa en la próxima tanda de “Analizar clases pasadas”.</p>}
        {c.aiReviewStatus === 'failed' && <p className="ts-gris">Falló ({c.aiError}). Se reintentará en la próxima tanda.</p>}
      </div>

      {c.status === 'descartado' && c.discardedBy && (
        <p className="ts-gris">Descartada por {c.discardedBy === 'ia' ? 'la IA' : 'el admin'} el {fecha(c.statusChangedAt)}.</p>
      )}

      <div className="ts-form">
        <label className="ts-campo">
          <span>Estado</span>
          <select value={estado} onChange={e => setEstado(e.target.value as TestimonialStatus)}>
            {TESTIMONIAL_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="ts-campo ts-notas">
          <span>Notas</span>
          <textarea rows={3} value={notas} onChange={e => setNotas(e.target.value)} placeholder="Ej.: pedido al profe el 02/10, alumno de acuerdo por WhatsApp…" />
        </label>
        <div className="ts-guardar">
          <button type="button" className="adm-btn adm-btn-primary" disabled={!cambios || guardando} onClick={guardar}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
          {estado === 'descartado' && c.status !== 'descartado' && (
            <span className="ts-gris">Al descartarla, este alumno no se volverá a proponer.</span>
          )}
          {aviso && <span className={aviso.ok ? 'ts-ok' : 'ts-error'}>{aviso.t}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
// Marca: verde #1E9E3A, amarillo #FFC400, fondo #F7F7F5, azul #2563eb, Radio Canada.
const ESTILOS = `
.ts { font-family: var(--font-app); color: #1a1c1a; }
.ts-head { margin-bottom: 14px; }
.ts-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.ts-sub { font-size: 13px; color: var(--text-muted); margin: 3px 0 0; }
.ts-lista { overflow: clip; }
.ts-ctl { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 12px 14px; border-bottom: 1px solid #ECECE8; }
.ts-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ts-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1.5px solid #e6e7e2; background: transparent; font-family: inherit; font-size: 13px; font-weight: 500; color: #4A4A4A; cursor: pointer; }
.ts-chip:hover { background: #F7F7F5; }
.ts-chip[aria-pressed="true"] { border-color: #1E9E3A; background: rgba(30,158,58,0.1); color: #1E9E3A; font-weight: 700; }
.ts-chip .n { font-size: 12px; font-weight: 700; color: #6E6E66; }
.ts-chip[aria-pressed="true"] .n { color: #1E9E3A; }
.ts-sel { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px 0 12px; border: 1px solid #e6e7e2; border-radius: 10px; background: #fff; min-width: 210px; }
.ts-sel-l { font-size: 13px; font-weight: 600; color: var(--text-muted); }
.ts-sel select { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; font-family: inherit; font-size: 13.5px; font-weight: 600; color: var(--text-primary); cursor: pointer; }
.ts-sel select:focus { outline: none; }
.ts-sel-x { width: 26px; height: 26px; min-height: 26px; border-radius: 999px; border: 0; background: #eef6ef; color: #15803d; display: grid; place-items: center; cursor: pointer; padding: 0; }
.ts-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.2fr) 150px 150px 70px 64px 150px 20px; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 6px 16px; border: 0; border-top: 1px solid #ECECE8; background: #fff; font-family: inherit; font-size: 13.5px; color: inherit; text-align: left; cursor: pointer; }
.ts-row:hover, .ts-row.open { background: #F7F7F5; }
.ts-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; cursor: default; }
.ts-al { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-pr { color: #167A2D; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-cl { color: #4A4A4A; white-space: nowrap; }
.ts-ml { display: none; }
.ts-no { font-weight: 600; white-space: nowrap; }
.ts-me { font-weight: 800; color: #1E9E3A; }
.ts-ch { color: #a4a7a1; transition: transform .2s; }
.ts-row.open .ts-ch { transform: rotate(180deg); }
.ts-est { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.ts-est.is-detectado { background: #EFEFEA; color: #4A4A4A; }
.ts-est.is-revisado { background: rgba(37,99,235,0.1); color: #2563eb; }
.ts-est.is-permiso_alumno { background: rgba(255,196,0,0.22); color: #7a5c00; }
.ts-est.is-listo { background: rgba(30,158,58,0.12); color: #1E9E3A; }
.ts-est.is-descartado { background: #F3F3F0; color: #a4a7a1; text-decoration: line-through; }
.ts-det { padding: 16px; background: #F7F7F5; border-top: 1px solid #ECECE8; display: flex; flex-direction: column; gap: 14px; }
.ts-lados { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ts-lado { background: #fff; border: 1px solid #ECECE8; border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; border-top: 3px solid #a4a7a1; }
.ts-lado.is-despues { border-top-color: #1E9E3A; }
.ts-lado-h { display: flex; flex-direction: column; gap: 2px; }
.ts-lado-t { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6E6E66; }
.ts-lado-m { font-size: 13px; color: #4A4A4A; }
.ts-cita { margin: 0; font-size: 14.5px; line-height: 1.5; color: #1a1c1a; }
.ts-min { display: inline-block; margin-right: 8px; padding: 1px 7px; border-radius: 6px; background: #EFEFEA; font-size: 12px; font-weight: 700; color: #4A4A4A; font-variant-numeric: tabular-nums; }
.ts-link { display: inline-flex; align-items: center; gap: 5px; align-self: flex-start; font-size: 13.5px; font-weight: 700; color: #2563eb; text-decoration: none; }
.ts-link:hover { text-decoration: underline; }
.ts-ia { background: #fff; border: 1px solid #ECECE8; border-radius: 12px; padding: 12px 14px; }
.ts-ia-t { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6E6E66; }
.ts-ia p { margin: 6px 0 0; font-size: 14px; line-height: 1.5; }
.ts-ia-no { color: #C81E1E; }
.ts-form { display: grid; grid-template-columns: 220px 1fr; gap: 12px; align-items: start; }
.ts-campo { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 600; color: #6E6E66; }
.ts-campo select, .ts-campo textarea { font-family: inherit; font-size: 14px; color: #1a1c1a; border: 1px solid #e6e7e2; border-radius: 10px; background: #fff; padding: 8px 10px; }
.ts-campo select { height: 40px; }
.ts-campo textarea { resize: vertical; }
.ts-guardar { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ts-gris { margin: 0; font-size: 13px; color: #6E6E66; }
.ts-ok { font-size: 13px; font-weight: 600; color: #1E9E3A; }
.ts-error { font-size: 13px; font-weight: 600; color: #C81E1E; margin: 0; padding: 0 16px; }
.ts-guardar .ts-error { padding: 0; }
.ts-vacio { padding: 20px 16px; margin: 0; font-size: 13.5px; color: #6E6E66; }

@media (max-width: 900px) {
  .ts-row.head { display: none; }
  .ts-row { grid-template-columns: 1fr auto; grid-template-areas: "al me" "pr es" "cl1 cl1" "cl2 cl2" "no no"; gap: 4px 10px; padding: 12px 14px; }
  .ts-al { grid-area: al; } .ts-me { grid-area: me; text-align: right; } .ts-pr { grid-area: pr; } .ts-es { grid-area: es; justify-self: end; }
  .ts-cl:nth-of-type(3) { grid-area: cl1; } .ts-cl:nth-of-type(4) { grid-area: cl2; }
  .ts-no { grid-area: no; font-size: 13px; color: #6E6E66; }
  .ts-no::before { content: 'Notas '; font-weight: 500; }
  .ts-ml { display: inline; font-weight: 700; color: #6E6E66; }
  .ts-ch { display: none; }
  .ts-lados, .ts-form { grid-template-columns: 1fr; }
  .ts-sel { min-width: 0; width: 100%; }
}
/* En el teléfono el título ya lo pone la cabecera de AdminNavMovil. */
@media (max-width: 767px) {
  .ts-title { display: none; }
  .ts-sub { margin-top: 0; }
}
`;
