'use client';

// Pestaña admin "Testimoniales" → "Alumnos con mejora detectada".
//
// Alumnos que en una clase vieja se trababan hablando inglés y en una reciente
// hablan con soltura (parejas de lib/testimonialStore, confirmadas por la IA).
// El admin pulsa "Enviar al profesor": cada profe implicado recibe campanita +
// email para subir SU grabación a la pestaña "Testimoniales" del sheet, y aquí
// se ve "Notificación enviada al profesor" y, cuando él pulsa "Grabación
// subida", "Subida".
//
// Las parejas descartadas (por la IA o a mano) no se muestran. Descartar a mano
// bloquea al alumno: no se le vuelve a proponer.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Send, X } from 'lucide-react';
import { useTeachers } from '@/lib/TeachersContext';
import {
  dbGetTestimonialCandidates, dbUpdateTestimonialCandidate, dbGetRecordingRequests, sendTestimonialToTeachers,
  type TestimonialCandidate, type TestimonialSide, type RecordingRequest,
} from '@/lib/testimonialsDb';
import FluencyBackfillPanel from '@/components/admin/FluencyBackfillPanel';
import { requestsForPair, recordingItems, requestCopy } from '@/lib/testimonialRequests';

/** En qué punto está el aviso al profesor de una pareja. */
type Aviso = 'ia_pendiente' | 'sin_enviar' | 'enviada' | 'subida';
type Filtro = 'todas' | 'sin_enviar' | 'enviada' | 'subida';

const FILTROS: Array<{ id: Filtro; label: string }> = [
  { id: 'todas', label: 'Todas' },
  { id: 'sin_enviar', label: 'Sin enviar' },
  { id: 'enviada', label: 'Enviada, pendiente de subir' },
  { id: 'subida', label: 'Subida' },
];

const confirmadaPorIa = (c: TestimonialCandidate) => c.aiReviewStatus === 'ready' && c.aiIsReal === true;

function avisoDe(c: TestimonialCandidate, reqs: RecordingRequest[]): Aviso {
  if (reqs.length === 0) return confirmadaPorIa(c) ? 'sin_enviar' : 'ia_pendiente';
  return reqs.every(r => r.uploadedAt) ? 'subida' : 'enviada';
}

const pasaFiltro = (a: Aviso, f: Filtro) =>
  f === 'todas' || a === f || (f === 'sin_enviar' && a === 'ia_pendiente');

/** "14/07/2026" */
function fecha(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
/** "02/10" (fechas de avisos, en hora de España) */
function diaMes(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Madrid' });
}
const ultimo = (isos: Array<string | null>) => isos.filter(Boolean).sort().at(-1) ?? null;

export default function TestimonialsTab() {
  const { teachers } = useTeachers();
  const [rows, setRows] = useState<TestimonialCandidate[] | null | undefined>(undefined);
  const [reqs, setReqs] = useState<RecordingRequest[]>([]);
  const [faltaSqlAvisos, setFaltaSqlAvisos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [profe, setProfe] = useState('');
  const [abierta, setAbierta] = useState<string | null>(null);

  const leer = useCallback(async () => {
    const [c, r] = await Promise.all([dbGetTestimonialCandidates(), dbGetRecordingRequests()]);
    return { c, r };
  }, []);

  const cargar = useCallback(async () => {
    try {
      const { c, r } = await leer();
      setRows(c); setReqs(r ?? []); setFaltaSqlAvisos(r === null); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [leer]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { c, r } = await leer();
        if (cancelled) return;
        setRows(c); setReqs(r ?? []); setFaltaSqlAvisos(r === null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [leer]);

  const nombreProfe = useCallback((id: string | null) =>
    (id && teachers.find(t => t.id === id)?.name) || 'Sin profe', [teachers]);

  // Solo las mejoras vivas: lo descartado (por la IA o a mano) no se enseña.
  const lista = useMemo(() => (rows ?? []).filter(c => c.status !== 'descartado'), [rows]);
  const reqsDe = useCallback((id: string) => reqs.filter(r => r.candidateId === id), [reqs]);

  const profesEnLista = useMemo(() => {
    const ids = new Set(lista.flatMap(c => [c.before.teacherId, c.after.teacherId]).filter(Boolean) as string[]);
    return [...ids].map(id => ({ id, name: nombreProfe(id) })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [lista, nombreProfe]);

  const porProfe = lista.filter(c => !profe || c.before.teacherId === profe || c.after.teacherId === profe);
  const visibles = porProfe.filter(c => pasaFiltro(avisoDe(c, reqsDe(c.id)), filtro));
  const cuenta = (f: Filtro) => porProfe.filter(c => pasaFiltro(avisoDe(c, reqsDe(c.id)), f)).length;

  return (
    <div className="ts">
      <div className="ts-head">
        <h2 className="ts-title">Alumnos con mejora detectada</h2>
        <p className="ts-sub">Alumnos que en una clase vieja se trababan hablando inglés y en una reciente hablan con soltura. Envía el aviso al profesor para que suba las grabaciones al sheet.</p>
      </div>

      <FluencyBackfillPanel onPairs={cargar} />

      {rows === null ? (
        <div className="adm-card ts-vacio">Falta correr <code>supabase-testimoniales-candidatos.sql</code> en Supabase.</div>
      ) : (
        <div className="adm-card ts-lista">
          {faltaSqlAvisos && <p className="ts-error ts-pad">Falta correr <code>supabase-testimoniales-avisos.sql</code>: no se pueden enviar avisos.</p>}
          <div className="ts-ctl">
            <div className="ts-chips" role="group" aria-label="Filtrar por aviso">
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

          {error && <p className="ts-error ts-pad">{error}</p>}
          {rows === undefined ? (
            <p className="ts-vacio">Cargando…</p>
          ) : visibles.length === 0 ? (
            <p className="ts-vacio">
              {lista.length === 0
                ? 'Todavía no hay alumnos con mejora detectada. Aparecen solos a medida que los transcripts reciben su nota de fluidez.'
                : 'Ningún alumno con estos filtros.'}
            </p>
          ) : (
            <>
              <div className="ts-row head" aria-hidden>
                <span>Alumno</span><span>Profe</span><span>Antes</span><span>Después</span><span>Mejora</span><span>Profesor</span><span>Grabación</span><span />
              </div>
              {visibles.map(c => {
                const open = abierta === c.id;
                const rq = reqsDe(c.id);
                const aviso = avisoDe(c, rq);
                const pa = nombreProfe(c.before.teacherId), pd = nombreProfe(c.after.teacherId);
                const subidas = rq.filter(r => r.uploadedAt).length;
                return (
                  <Fragment key={c.id}>
                    <button type="button" className={`ts-row${open ? ' open' : ''}`} aria-expanded={open}
                      onClick={() => setAbierta(open ? null : c.id)}>
                      <span className="ts-al">{c.studentName ?? 'Alumno sin nombre'}</span>
                      <span className="ts-pr">{pa === pd ? pd : `${pa} → ${pd}`}</span>
                      <span className="ts-cl"><span className="ts-ml">Antes </span>Clase {c.before.classNumber ?? '?'} · {fecha(c.before.classDate)}</span>
                      <span className="ts-cl"><span className="ts-ml">Después </span>Clase {c.after.classNumber ?? '?'} · {fecha(c.after.classDate)}</span>
                      <span className="ts-me">{c.before.score} → {c.after.score} <b>+{c.improvement}</b></span>
                      <span className="ts-av">
                        {aviso === 'ia_pendiente' && <span className="ts-tag is-gris">Revisión IA pendiente</span>}
                        {aviso === 'sin_enviar' && <span className="ts-tag is-gris">Sin enviar</span>}
                        {(aviso === 'enviada' || aviso === 'subida') && (
                          <span className="ts-tag is-azul" title="Notificación enviada al profesor">
                            Notificación enviada al profesor · {diaMes(ultimo(rq.map(r => r.notifiedAt)))}
                          </span>
                        )}
                      </span>
                      <span className="ts-gr">
                        {rq.length === 0 && <span className="ts-gris">—</span>}
                        {aviso === 'subida' && <span className="ts-tag is-verde">Subida · {diaMes(ultimo(rq.map(r => r.uploadedAt)))}</span>}
                        {aviso === 'enviada' && (
                          <span className="ts-tag is-amarillo">Pendiente{rq.length > 1 ? ` (${subidas} de ${rq.length} subidas)` : ''}</span>
                        )}
                      </span>
                      <ChevronDown size={16} className="ts-ch" aria-hidden />
                    </button>
                    {open && <Detalle c={c} rq={rq} aviso={aviso} nombreProfe={nombreProfe} onChanged={cargar} sinTabla={faltaSqlAvisos} />}
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

function Lado({ titulo, s, profe, tono }: { titulo: string; s: TestimonialSide; profe: string; tono: 'antes' | 'despues' }) {
  return (
    <div className={`ts-lado is-${tono}`}>
      <div className="ts-lado-h">
        <span className="ts-lado-t">{titulo}</span>
        <span className="ts-lado-m">Clase {s.classNumber ?? '?'} · {fecha(s.classDate)} · nota {s.score ?? '?'} · {profe}</span>
      </div>
      {s.excerpt
        ? <blockquote className="ts-cita"><span className="ts-min">{s.excerptAt ?? '?'}</span>“{s.excerpt}”</blockquote>
        : <p className="ts-gris">Sin fragmento.</p>}
      {s.fathomUrl
        ? <a className="ts-link" href={s.fathomUrl} target="_blank" rel="noopener noreferrer">
            Abrir grabación{s.excerptAt ? ` (min ${s.excerptAt})` : ''} <ExternalLink size={13} aria-hidden />
          </a>
        : <p className="ts-gris">Sin enlace de grabación en el transcript.</p>}
    </div>
  );
}

function Detalle({ c, rq, aviso, nombreProfe, onChanged, sinTabla }: {
  c: TestimonialCandidate; rq: RecordingRequest[]; aviso: Aviso;
  nombreProfe: (id: string | null) => string; onChanged: () => void; sinTabla: boolean;
}) {
  const [enviando, setEnviando] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [confirmarDescarte, setConfirmarDescarte] = useState(false);
  const [notas, setNotas] = useState(c.adminNotes ?? '');
  const notasCambiadas = (notas.trim() || null) !== (c.adminNotes ?? null);

  async function enviar() {
    setEnviando(true); setMsg(null);
    const r = await sendTestimonialToTeachers(c.id);
    setEnviando(false);
    if (r.error) { setMsg({ ok: false, t: r.error }); return; }
    const partes = (r.results ?? []).map(x => {
      const n = nombreProfe(x.teacherId);
      if (x.outcome === 'error') return `${n}: error (${x.error})`;
      if (x.outcome === 'ya_subida') return `${n}: ya la había subido`;
      return `${n}: ${x.outcome === 'reenviado' ? 'reenviado' : 'enviado'}${x.emailSent ? ' (campanita + email)' : ' (campanita; el email falló)'}`;
    });
    setMsg({ ok: !(r.results ?? []).some(x => x.outcome === 'error'), t: partes.join(' · ') });
    onChanged();
  }

  async function descartar() {
    const r = await dbUpdateTestimonialCandidate(c.id, { status: 'descartado' });
    if (r.error) { setMsg({ ok: false, t: r.error }); return; }
    onChanged();
  }

  async function guardarNotas() {
    const r = await dbUpdateTestimonialCandidate(c.id, { adminNotes: notas });
    setMsg(r.error ? { ok: false, t: r.error } : { ok: true, t: 'Notas guardadas.' });
    if (!r.error) onChanged();
  }

  const pendientes = rq.filter(r => !r.uploadedAt).length;

  return (
    <div className="ts-det">
      <div className="ts-lados">
        <Lado titulo="Antes: donde más se trababa" s={c.before} profe={nombreProfe(c.before.teacherId)} tono="antes" />
        <Lado titulo="Después: donde mejor habla" s={c.after} profe={nombreProfe(c.after.teacherId)} tono="despues" />
      </div>

      <div className="ts-caja">
        <span className="ts-caja-t">Revisión de la IA</span>
        {c.aiReviewStatus === 'ready' && c.aiSummary && <p>{c.aiSummary}</p>}
        {c.aiReviewStatus === 'pending' && <p className="ts-gris">Pendiente. Se completa en la próxima tanda de “Analizar clases pasadas” o con el siguiente transcript del alumno.</p>}
        {c.aiReviewStatus === 'failed' && <p className="ts-gris">Falló ({c.aiError}). Se reintentará en la próxima tanda.</p>}
      </div>

      <div className="ts-caja">
        <span className="ts-caja-t">Aviso al profesor</span>
        {rq.length === 0 ? (
          <>
            <p className="ts-gris">{aviso === 'ia_pendiente'
              ? 'Se podrá enviar cuando la IA confirme que la mejora es real.'
              : 'Todavía no se ha enviado. Esto es lo que recibirá cada profesor (campanita y email):'}</p>
            {aviso !== 'ia_pendiente' && requestsForPair(c).map(r => (
              <blockquote key={r.teacherId} className="ts-preview">
                {requestCopy(c.studentName ?? 'el alumno', recordingItems(c, r.sides), nombreProfe(r.teacherId)).body}
              </blockquote>
            ))}
          </>
        ) : (
          <ul className="ts-avisos">
            {rq.map(r => (
              <li key={r.id}>
                <b>{nombreProfe(r.teacherId)}</b>
                {' · '}{r.sides.length === 2 ? 'las dos clases' : r.sides[0] === 'antes' ? 'clase antes' : 'clase después'}
                {' · '}Notificación enviada al profesor el {diaMes(r.notifiedAt)}
                {r.timesNotified > 1 ? ` (${r.timesNotified} veces)` : ''}
                {r.emailSent ? '' : ' · el email falló'}
                {' · '}{r.uploadedAt
                  ? <span className="ts-ok">Subida el {diaMes(r.uploadedAt)}</span>
                  : <span className="ts-pend">Pendiente de subir</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="ts-acc">
          {aviso !== 'subida' && (
            <button type="button" className={`adm-btn ${rq.length === 0 ? 'adm-btn-primary ts-verde' : 'adm-btn-ghost'}`}
              disabled={enviando || aviso === 'ia_pendiente' || sinTabla} onClick={enviar}>
              <Send size={14} aria-hidden /> {enviando ? 'Enviando…' : rq.length === 0 ? 'Enviar al profesor' : `Reenviar aviso${pendientes > 1 ? 's' : ''}`}
            </button>
          )}
          {!confirmarDescarte
            ? <button type="button" className="adm-btn adm-btn-ghost ts-desc" onClick={() => setConfirmarDescarte(true)}>Descartar</button>
            : <span className="ts-conf">
                Se quitará de la lista y este alumno no se volverá a proponer.
                <button type="button" className="adm-btn adm-btn-ghost ts-desc" onClick={descartar}>Sí, descartar</button>
                <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setConfirmarDescarte(false)}>Cancelar</button>
              </span>}
        </div>
        {msg && <p className={msg.ok ? 'ts-ok' : 'ts-error'}>{msg.t}</p>}
      </div>

      <label className="ts-campo">
        <span>Notas</span>
        <textarea rows={2} value={notas} onChange={e => setNotas(e.target.value)} placeholder="Ej.: el alumno autoriza el uso por email el 05/10…" />
      </label>
      {notasCambiadas && (
        <div><button type="button" className="adm-btn adm-btn-primary" onClick={guardarNotas}>Guardar notas</button></div>
      )}
    </div>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
// Marca: verde #1E9E3A, amarillo #FFC400, fondo #F7F7F5, azul #2563eb, Radio Canada.
const ESTILOS = `
.ts { font-family: var(--font-app); color: #1a1c1a; }
.ts-head { margin-bottom: 14px; }
.ts-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.ts-sub { font-size: 13px; color: var(--text-muted); margin: 3px 0 0; max-width: 720px; }
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
.ts-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.1fr) 140px 140px 96px minmax(0, 1.5fr) minmax(0, 1fr) 20px; align-items: center; gap: 12px; width: 100%; min-height: 50px; padding: 6px 16px; border: 0; border-top: 1px solid #ECECE8; background: #fff; font-family: inherit; font-size: 13.5px; color: inherit; text-align: left; cursor: pointer; }
.ts-row:hover, .ts-row.open { background: #F7F7F5; }
.ts-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; cursor: default; }
.ts-al { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-pr { color: #167A2D; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts-cl { color: #4A4A4A; white-space: nowrap; }
.ts-ml { display: none; }
.ts-me { white-space: nowrap; color: #4A4A4A; }
.ts-me b { color: #1E9E3A; font-weight: 800; margin-left: 2px; }
.ts-av, .ts-gr { min-width: 0; }
.ts-tag { display: inline-block; max-width: 100%; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; line-height: 1.35; white-space: normal; }
.ts-tag.is-gris { background: #EFEFEA; color: #4A4A4A; }
.ts-tag.is-azul { background: rgba(37,99,235,0.1); color: #2563eb; }
.ts-tag.is-amarillo { background: rgba(255,196,0,0.22); color: #7a5c00; }
.ts-tag.is-verde { background: rgba(30,158,58,0.12); color: #1E9E3A; }
.ts-ch { color: #a4a7a1; transition: transform .2s; }
.ts-row.open .ts-ch { transform: rotate(180deg); }
.ts-det { padding: 16px; background: #F7F7F5; border-top: 1px solid #ECECE8; display: flex; flex-direction: column; gap: 12px; }
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
.ts-caja { background: #fff; border: 1px solid #ECECE8; border-radius: 12px; padding: 12px 14px; }
.ts-caja-t { font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6E6E66; }
.ts-caja p { margin: 6px 0 0; font-size: 14px; line-height: 1.5; }
.ts-preview { margin: 8px 0 0; padding: 10px 12px; border-left: 3px solid #1E9E3A; background: #F7F7F5; border-radius: 0 8px 8px 0; font-size: 13.5px; line-height: 1.55; color: #1a1c1a; }
.ts-avisos { margin: 8px 0 0; padding-left: 18px; font-size: 13.5px; line-height: 1.7; }
.ts-acc { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.ts-acc .adm-btn { display: inline-flex; align-items: center; gap: 6px; }
.ts-verde { background: #1E9E3A; border-color: #1E9E3A; }
.ts-desc { color: #C81E1E; }
.ts-conf { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; color: #4A4A4A; }
.ts-campo { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 600; color: #6E6E66; }
.ts-campo textarea { font-family: inherit; font-size: 14px; color: #1a1c1a; border: 1px solid #e6e7e2; border-radius: 10px; background: #fff; padding: 8px 10px; resize: vertical; }
.ts-gris { margin: 0; font-size: 13px; color: #6E6E66; }
.ts-ok { font-size: 13px; font-weight: 600; color: #1E9E3A; }
.ts-pend { font-weight: 600; color: #7a5c00; }
.ts-error { font-size: 13px; font-weight: 600; color: #C81E1E; margin: 6px 0 0; }
.ts-pad { padding: 10px 16px 0; margin: 0; }
.ts-vacio { padding: 20px 16px; margin: 0; font-size: 13.5px; color: #6E6E66; }

@media (max-width: 1000px) {
  .ts-row.head { display: none; }
  .ts-row { grid-template-columns: 1fr auto; grid-template-areas: "al me" "pr pr" "cl1 cl1" "cl2 cl2" "av av" "gr gr"; gap: 5px 10px; padding: 12px 14px; }
  .ts-al { grid-area: al; } .ts-me { grid-area: me; text-align: right; } .ts-pr { grid-area: pr; }
  .ts-cl:nth-of-type(3) { grid-area: cl1; } .ts-cl:nth-of-type(4) { grid-area: cl2; }
  .ts-av { grid-area: av; } .ts-gr { grid-area: gr; }
  .ts-gr:has(> .ts-gris) { display: none; }
  .ts-ml { display: inline; font-weight: 700; color: #6E6E66; }
  .ts-ch { display: none; }
  .ts-lados { grid-template-columns: 1fr; }
  .ts-sel { min-width: 0; width: 100%; }
}
/* En el teléfono el título ya lo pone la cabecera de AdminNavMovil. */
@media (max-width: 767px) {
  .ts-title { display: none; }
  .ts-sub { margin-top: 0; }
}
`;
