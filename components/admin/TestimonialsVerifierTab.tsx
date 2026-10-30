'use client';

// Pestaña admin "Testimoniales" con VERIFICADOR (rama testimoniales-verificador).
//
// El buscador (V6) ya no enseña sus parejas: "Buscar y verificar" las pasa una a
// una por el verificador (lib/testimonialVerifier, una llamada al servidor por
// pareja) hasta reunir `parejas_por_tanda` aprobadas. Solo se enseñan esas, con
// la nota del juez, fotogramas, audio recortado y medidas. "No sirve" pide motivo:
// alimenta el banco de ejemplos y puede endurecer un umbral (que se puede deshacer).
//
// Todo pasa por /api/admin/testimonial-verify con la sesión de admin (adminFetch).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { adminFetch } from '@/lib/adminSessionClient';
import { formatSeconds } from '@/lib/fluency';
import { MOTIVOS_ADMIN, MOTIVO_LABEL, motivosFrase, type ClipMeasures, type Motivo } from '@/lib/testimonialMeasures';

type Kind = 'busqueda' | 'prueba';

interface Side {
  fecha: string; inicio: number; dur: number; fathom: string | null; audio: string | null; frames: string[];
  texto: string | null; textoFathom: string; medidas: ClipMeasures | null;
}
interface Verif {
  id: string; batch_id: string | null; student_name: string | null; teacher_name: string | null; status: string;
  motivo: Motivo | null; motivo_detalle: string | null; fathom_causa: string | null; antes: Side | null; despues: Side | null;
  semanas: number | null; juez_nota: number | null; juez_explicacion: string | null;
  consentimiento: 'sin_pedir' | 'pedido' | 'dado'; review: string | null; review_motivo: string | null;
  created_at: string; updated_at: string; files_deleted_at: string | null;
}
interface Tanda {
  id: string; startedAt: string; finishedAt: string | null; cancelled: boolean; planned: number; revisados: number;
  aprobados: number; errores: number; porMotivo: Record<string, number>; fuenteError: number; enlacesProbados: number;
  sirven: number; revisadas: number;
}
interface ResumenPrueba { total: number; descartados: number; aprobados: number; errores: number; porMotivo: Record<string, number> }
interface Estado {
  tarjetas: Verif[]; media: Record<string, string>; aprobadasPendientes: number; sirven: Verif[]; descartados: Verif[];
  tandas: Tanda[]; alarma: { fallos: number; probados: number } | null; motivosRechazo: Record<string, number>;
  revisionesMiradas: number;
  cambios: Array<{ id: number; key: string; antes: number; despues: number; motivo: string; detalle: string | null; created_at: string; reverted_at: string | null }>;
  umbrales: Array<{ key: string; value: number; description: string; motivo: string | null }>;
  prueba: { objetivo: number; todas: ResumenPrueba; sinEnlaceFalso: ResumenPrueba; conEnlaceFalso: number };
  escucha: Escucha | { error: string };
}
interface Escucha {
  activa: boolean; alumnos: number; fuera: Record<string, number>; clasesObjetivo: number; clases: Record<string, number>;
  minutos: number; porOutcome: Record<string, number>; sinPareja: Record<string, number>; sinProfeEnComun: string[];
  gasto: { minutos: { escucha: number; verificador: number }; usd: number; credito: number; queda: number } | null;
}
interface Progreso { kind: Kind | 'escucha'; hechas: number; total: number; aprobadas: number; errores: number }

const API = '/api/admin/testimonial-verify';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MESES[m - 1]} ${y}`;
};
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');
const CONSENT_LABEL = { sin_pedir: 'Sin pedir', pedido: 'Pedido', dado: 'Dado' } as const;

export default function TestimonialsVerifierTab() {
  const { user } = useAuth();
  const creds = useMemo(() => (user ? { username: user.username, password: user.password } : null), [user]);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const [grande, setGrande] = useState<string | null>(null);
  const cancelar = useRef(false);
  const vivo = useRef(true);

  const post = useCallback(async <T,>(accion: string, extra: Record<string, unknown> = {}): Promise<T> => {
    const res = await adminFetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion, ...extra }), cache: 'no-store',
    }, creds);
    const data = await res.json().catch(() => ({ error: `Error ${res.status} del servidor.` }));
    if (!res.ok) throw new Error(data.error ?? `Error ${res.status} del servidor.`);
    return data as T;
  }, [creds]);

  const cargar = useCallback(async () => {
    try {
      const e = await post<Estado>('estado');
      if (vivo.current) { setEstado(e); setError(null); }
    } catch (e) {
      if (vivo.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [post]);

  useEffect(() => {
    vivo.current = true;
    (async () => { await cargar(); })();
    return () => { vivo.current = false; cancelar.current = true; };
  }, [cargar]);

  const objetivo = estado?.umbrales.find(u => u.key === 'parejas_por_tanda')?.value ?? 5;

  /** Una tanda: una llamada por pareja. La búsqueda va de una en una y para al reunir `objetivo`. */
  const lanzar = useCallback(async (kind: Kind) => {
    cancelar.current = false;
    setError(null); setAviso(null);
    let batchId: string | null = null;
    try {
      const inicio = await post<{ batchId: string; ids: string[]; resincronizados: number }>('iniciar', { tipo: kind });
      batchId = inicio.batchId;
      const cola = [...inicio.ids];
      const p: Progreso = { kind, hechas: 0, total: cola.length, aprobadas: 0, errores: 0 };
      setProgreso({ ...p });
      let seguidos = 0;
      const trabajador = async () => {
        for (let id = cola.shift(); id; id = cola.shift()) {
          if (cancelar.current || !vivo.current) return;
          if (kind === 'busqueda' && p.aprobadas >= objetivo) return;
          try {
            const r = await post<{ status: string }>('verificar', { id, batchId, tipo: kind });
            if (r.status === 'aprobado') p.aprobadas++;
            if (r.status === 'error') p.errores++;
            seguidos = 0;
          } catch (e) {
            p.errores++;
            if (++seguidos >= 3) { cancelar.current = true; setError(`Se paró tras 3 fallos seguidos: ${e instanceof Error ? e.message : e}`); }
          }
          p.hechas++;
          if (vivo.current) setProgreso({ ...p });
        }
      };
      await Promise.all(Array.from({ length: kind === 'prueba' ? 3 : 1 }, trabajador));
      if (kind === 'busqueda' && vivo.current) {
        setAviso(p.total === 0 ? 'No hay parejas nuevas que verificar: el buscador aún no ha propuesto más.'
          : `Tanda terminada: ${p.aprobadas} aprobadas de ${p.hechas} verificadas.`);
      }
    } catch (e) {
      if (vivo.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (batchId) await post('cerrar', { batchId, cancelado: cancelar.current }).catch(() => {});
      if (vivo.current) { setProgreso(null); await cargar(); }
    }
  }, [post, cargar, objetivo]);

  /** Escucha dirigida: una llamada por clase, 3 a la vez; al acabar, rehace las parejas. */
  const escuchar = useCallback(async (alumnos?: number) => {
    cancelar.current = false;
    setError(null); setAviso(null);
    try {
      const q = await post<{ ids: string[]; alumnos: number; clases: number; yaEscuchadas: number }>('escucha-iniciar', alumnos ? { alumnos } : {});
      const cola = [...q.ids];
      const p: Progreso = { kind: 'escucha', hechas: 0, total: cola.length, aprobadas: 0, errores: 0 };
      setProgreso({ ...p });
      let seguidos = 0;
      const trabajador = async () => {
        for (let id = cola.shift(); id; id = cola.shift()) {
          if (cancelar.current || !vivo.current) return;
          try {
            const r = await post<{ status: string }>('escuchar', { id });
            if (r.status === 'error') p.errores++;
            seguidos = 0;
          } catch (e) {
            p.errores++;
            if (++seguidos >= 3) { cancelar.current = true; setError(`Se paró tras 3 fallos seguidos: ${e instanceof Error ? e.message : e}`); }
          }
          p.hechas++;
          if (vivo.current) setProgreso({ ...p });
        }
      };
      await Promise.all(Array.from({ length: 3 }, trabajador));
      const pares = await post<{ outcomes: Record<string, number>; creadas: number; actualizadas: number }>('escucha-emparejar');
      if (vivo.current) {
        setAviso(`Escucha${alumnos ? ` (prueba con ${q.alumnos} alumnos)` : ''}: ${p.hechas} clases escuchadas ahora`
          + `${q.yaEscuchadas ? `, ${q.yaEscuchadas} ya lo estaban` : ''}${p.errores ? `, ${p.errores} con error` : ''}.`
          + ` Parejas: ${pares.creadas} nuevas, ${pares.actualizadas} cambiadas. Ahora pulsa “Buscar y verificar”.`);
      }
    } catch (e) {
      if (vivo.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (vivo.current) { setProgreso(null); await cargar(); }
    }
  }, [post, cargar]);

  const emparejarEscucha = useCallback(async () => {
    try {
      const r = await post<{ creadas: number; actualizadas: number }>('escucha-emparejar');
      setAviso(`Parejas de la escucha rehechas: ${r.creadas} nuevas, ${r.actualizadas} cambiadas.`);
      await cargar();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar]);

  const revisar = useCallback(async (id: string, review: 'sirve' | 'no_sirve', motivo?: Motivo, texto?: string) => {
    try {
      const r = await post<{ endurecido: { key: string; antes: number; despues: number } | null }>('revisar', { id, review, motivo, texto });
      if (r.endurecido) setAviso(`Umbral endurecido: ${r.endurecido.key} pasa de ${r.endurecido.antes} a ${r.endurecido.despues}. Puedes deshacerlo en “Umbrales”.`);
      await cargar();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar]);

  const consentimiento = useCallback(async (id: string, valor: string) => {
    try { await post('consentimiento', { id, valor }); await cargar(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar]);

  const deshacer = useCallback(async (changeId: number) => {
    try { await post('deshacer-umbral', { changeId }); await cargar(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar]);

  const ultima = estado?.tandas.find(t => t.revisados > 0);

  return (
    <div className="tv">
      <h2 className="tv-title">Testimoniales</h2>

      {/* ── Barra superior ── */}
      <section className="tv-bar">
        <div className="tv-bar-acc">
          {progreso?.kind === 'busqueda' ? (
            <>
              <div className="tv-prog" role="status">
                <span>Verificando {Math.min(progreso.hechas + 1, progreso.total)} de {progreso.total}… · {progreso.aprobadas} de {objetivo} aprobadas</span>
                <div className="tv-prog-bar"><div style={{ width: `${progreso.total ? (progreso.hechas / progreso.total) * 100 : 0}%` }} /></div>
              </div>
              <button type="button" className="tv-btn tv-sec" onClick={() => { cancelar.current = true; }}>Cancelar</button>
            </>
          ) : (
            <button type="button" className="tv-btn tv-pri" disabled={!!progreso || !estado} onClick={() => lanzar('busqueda')}>
              Buscar y verificar
            </button>
          )}
        </div>

        {estado && <PanelEscucha e={estado.escucha} progreso={progreso?.kind === 'escucha' ? progreso : null} ocupado={!!progreso}
          onEscuchar={escuchar} onEmparejar={emparejarEscucha} onCancelar={() => { cancelar.current = true; }} />}

        {ultima && (
          <p className="tv-line">
            <b>Última tanda</b> ({fecha(ultima.startedAt)}{ultima.cancelled ? ', cancelada' : ''}): {ultima.revisados} revisados,
            {' '}{ultima.aprobados} aprobados{ultima.errores ? `, ${ultima.errores} con error` : ''}
            {Object.keys(ultima.porMotivo).length > 0 && <> · descartados: {motivosFrase(ultima.porMotivo)}</>}.
          </p>
        )}
        {estado && estado.tandas.some(t => t.revisados > 0) && (
          <p className="tv-line">
            <b>Aprobación por tanda</b> (verificador · tú):{' '}
            {estado.tandas.filter(t => t.revisados > 0).slice(0, 5).map(t =>
              `${fecha(t.startedAt)}: ${t.aprobados}/${t.revisados} · ${t.revisadas ? `${t.sirven}/${t.revisadas} sirven (${pct(t.sirven, t.revisadas)})` : 'sin revisar'}`,
            ).join('  |  ')}
          </p>
        )}
        {estado && Object.keys(estado.motivosRechazo).length > 0 && (
          <p className="tv-line"><b>Tus motivos de “No sirve”</b> (últimas {estado.revisionesMiradas} revisiones): {motivosFrase(estado.motivosRechazo)}.</p>
        )}
      </section>

      {estado?.alarma && (
        <p className="tv-alarma" role="alert">
          No se pudieron leer los videos de Fathom; puede que Fathom haya cambiado su página.
          <span> ({estado.alarma.fallos} de {estado.alarma.probados} enlaces fallaron por error técnico en la última tanda.)</span>
        </p>
      )}
      {error && <p className="tv-error">{error}</p>}
      {aviso && <p className="tv-aviso">{aviso} <button type="button" className="tv-link" onClick={() => setAviso(null)}>Cerrar</button></p>}

      {/* ── Tarjetas ── */}
      {!estado ? (
        !error && <p className="tv-vacio">Cargando…</p>
      ) : estado.tarjetas.length === 0 ? (
        <p className="tv-vacio">No hay parejas aprobadas por revisar. Pulsa “Buscar y verificar”.</p>
      ) : (
        <div className="tv-lista">
          {estado.aprobadasPendientes > estado.tarjetas.length && (
            <p className="tv-line">Mostrando las {estado.tarjetas.length} con mejor nota de {estado.aprobadasPendientes} aprobadas por revisar.</p>
          )}
          {estado.tarjetas.map(v => (
            <Tarjeta key={v.id} v={v} media={estado.media} onVer={setGrande} onRevisar={revisar} onConsentimiento={consentimiento} />
          ))}
        </div>
      )}

      {estado && (
        <>
          <Sirven lista={estado.sirven} onConsentimiento={consentimiento} />
          <Descartados lista={estado.descartados} post={post} onVer={setGrande} />
          <Umbrales estado={estado} onDeshacer={deshacer} />
          <Prueba estado={estado} progreso={progreso?.kind === 'prueba' ? progreso : null} ocupado={!!progreso}
            onLanzar={() => lanzar('prueba')} onCancelar={() => { cancelar.current = true; }} />
        </>
      )}

      {grande && (
        <div className="tv-lightbox" role="dialog" aria-label="Fotograma ampliado" onClick={() => setGrande(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={grande} alt="Fotograma ampliado" />
        </div>
      )}
      <style>{ESTILOS}</style>
    </div>
  );
}

// ── Tarjeta ──────────────────────────────────────────────────────────────────

function Tarjeta({ v, media, onVer, onRevisar, onConsentimiento }: {
  v: Verif; media: Record<string, string>; onVer: (u: string) => void;
  onRevisar: (id: string, r: 'sirve' | 'no_sirve', m?: Motivo, t?: string) => Promise<void>;
  onConsentimiento: (id: string, valor: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState<Motivo | null>(null);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const enviar = async (r: 'sirve' | 'no_sirve') => {
    setEnviando(true);
    await onRevisar(v.id, r, r === 'no_sirve' ? motivo ?? undefined : undefined, texto || undefined);
    setEnviando(false);
  };
  const puedeConfirmar = !!motivo && (motivo !== 'otro' || texto.trim().length > 0);

  return (
    <article className="tv-card">
      <div className="tv-cols">
        <Columna titulo="Antes" s={v.antes} media={media} onVer={onVer} tono="antes" />
        <Columna titulo="Después" s={v.despues} media={media} onVer={onVer} tono="despues" />
      </div>
      <div className="tv-pie">
        <div className="tv-datos">
          <span className="tv-alumno">{v.student_name ?? 'Alumno sin nombre'}</span>
          <span>Profe: {v.teacher_name ?? '—'}</span>
          <span>{v.semanas ?? '?'} semanas entre clases</span>
        </div>
        <p className="tv-juez"><span className="tv-nota">{v.juez_nota ?? '—'}</span> {v.juez_explicacion}</p>
        <label className="tv-consent">
          Consentimiento del alumno:
          <select value={v.consentimiento} onChange={e => onConsentimiento(v.id, e.target.value)}>
            {Object.entries(CONSENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>
      {!abierto ? (
        <footer className="tv-acc">
          <button type="button" className="tv-btn tv-si" disabled={enviando} onClick={() => enviar('sirve')}>✓ Sirve</button>
          <button type="button" className="tv-btn tv-no" disabled={enviando} onClick={() => setAbierto(true)}>✗ No sirve</button>
        </footer>
      ) : (
        <fieldset className="tv-motivos">
          <legend>¿Por qué no sirve? (obligatorio)</legend>
          <div className="tv-motivos-l">
            {MOTIVOS_ADMIN.map(m => (
              <label key={m} className="tv-radio">
                <input type="radio" name={`motivo-${v.id}`} checked={motivo === m} onChange={() => setMotivo(m)} /> {MOTIVO_LABEL[m]}
              </label>
            ))}
          </div>
          {motivo === 'otro' && (
            <input className="tv-input" type="text" placeholder="Escribe el motivo" value={texto} onChange={e => setTexto(e.target.value)} />
          )}
          <div className="tv-acc">
            <button type="button" className="tv-btn tv-no-conf" disabled={!puedeConfirmar || enviando} onClick={() => enviar('no_sirve')}>Confirmar “No sirve”</button>
            <button type="button" className="tv-btn tv-sec" disabled={enviando} onClick={() => { setAbierto(false); setMotivo(null); setTexto(''); }}>Cancelar</button>
          </div>
        </fieldset>
      )}
    </article>
  );
}

function Medidas({ m }: { m: ClipMeasures | null }) {
  if (!m) return <p className="tv-med">Sin medidas</p>;
  return (
    <p className="tv-med">
      <b>{m.ppm}</b> pal/min · <b>{m.pausas}</b> pausas{m.pausas ? ` (la mayor ${m.pausa_max_s} s)` : ''} · <b>{m.muletillas}</b> muletillas
    </p>
  );
}

function Columna({ titulo, s, media, onVer, tono }: {
  titulo: string; s: Side | null; media: Record<string, string>; onVer: (u: string) => void; tono: 'antes' | 'despues';
}) {
  if (!s) return <section className={`tv-col is-${tono}`}><span className="tv-et">{titulo}</span><p className="tv-med">Sin datos</p></section>;
  return (
    <section className={`tv-col is-${tono}`}>
      <div className="tv-col-h">
        <span className="tv-et">{titulo}</span>
        <span className="tv-fecha">{fecha(s.fecha)}</span>
      </div>
      <div className="tv-frames">
        {s.frames.map(p => media[p] ? (
          <button key={p} type="button" className="tv-frame" onClick={() => onVer(media[p])} aria-label="Ampliar fotograma">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={media[p]} alt="" loading="lazy" />
          </button>
        ) : <span key={p} className="tv-frame is-vacio" />)}
      </div>
      {s.audio && media[s.audio] && <audio className="tv-audio" controls preload="none" src={media[s.audio]} />}
      <blockquote className="tv-texto">“{s.texto || '—'}”</blockquote>
      <Medidas m={s.medidas} />
      {s.fathom && <a className="tv-fathom" href={s.fathom} target="_blank" rel="noopener noreferrer">▶ Ver en Fathom ({formatSeconds(Math.round(s.inicio))})</a>}
    </section>
  );
}

// ── Escucha dirigida ─────────────────────────────────────────────────────────

const usd = (x: number) => x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n = (x: number) => x.toLocaleString('es-ES');
const FUERA_LABEL: Record<string, string> = { menos_2_meses: 'con menos de 2 meses', pocas_clases: 'con pocas clases grabadas' };

function PanelEscucha({ e, progreso, ocupado, onEscuchar, onEmparejar, onCancelar }: {
  e: Escucha | { error: string }; progreso: Progreso | null; ocupado: boolean;
  onEscuchar: (alumnos?: number) => void; onEmparejar: () => void; onCancelar: () => void;
}) {
  if ('error' in e) return <p className="tv-line">Escucha de clases: {e.error}</p>;
  const hechas = (e.clases.escuchada ?? 0) + (e.clases.sin_tramos ?? 0) + (e.clases.enlace_roto ?? 0);
  const fuera = Object.entries(e.fuera).map(([k, v]) => `${v} ${FUERA_LABEL[k] ?? k}`).join(', ');
  const sinPareja = Object.entries(e.sinPareja).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
  return (
    <div className="tv-escucha">
      <div className="tv-bar-acc">
        {progreso ? (
          <>
            <div className="tv-prog" role="status">
              <span>Escuchando {Math.min(progreso.hechas + 1, progreso.total)} de {progreso.total} clases…{progreso.errores ? ` · ${progreso.errores} con error` : ''}</span>
              <div className="tv-prog-bar"><div style={{ width: `${progreso.total ? (progreso.hechas / progreso.total) * 100 : 0}%` }} /></div>
            </div>
            <button type="button" className="tv-btn tv-sec" onClick={onCancelar}>Cancelar</button>
          </>
        ) : (
          <>
            <button type="button" className="tv-btn tv-sec" disabled={ocupado} onClick={() => onEscuchar(10)}>Probar con 10 alumnos</button>
            <button type="button" className="tv-btn tv-sec" disabled={ocupado} onClick={() => onEscuchar()}>Escuchar clases</button>
            <button type="button" className="tv-link" disabled={ocupado} onClick={onEmparejar}>Rehacer parejas de la escucha</button>
          </>
        )}
      </div>
      <p className="tv-line">
        <b>Escucha de clases</b>{!e.activa && ' (apagada: manda el buscador viejo)'}: {n(e.alumnos)} alumnos
        {fuera && <> (fuera {fuera})</>} · {n(hechas)} de {n(e.clasesObjetivo)} clases escuchadas
        {e.clases.error ? `, ${e.clases.error} con error` : ''} · {n(e.minutos)} min de audio.
      </p>
      {Object.keys(e.porOutcome).length > 0 && (
        <p className="tv-line">
          <b>Resultado por alumno:</b> {e.porOutcome.pareja ?? 0} con pareja
          {e.porOutcome.ya_sirve ? ` · ${e.porOutcome.ya_sirve} ya tienen una que sirve` : ''}
          {e.porOutcome.pendiente ? ` · ${e.porOutcome.pendiente} con clases sin escuchar` : ''}
          {e.porOutcome.sin_profe_en_comun ? ` · ${e.porOutcome.sin_profe_en_comun} sin profe en común (${e.sinProfeEnComun.join(', ')})` : ''}
          {sinPareja && ` · sin pareja: ${sinPareja}`}.
        </p>
      )}
      {e.gasto && (
        <p className="tv-line">
          <b>Deepgram:</b> {usd(e.gasto.usd)} USD gastados (estimado: escucha {n(e.gasto.minutos.escucha)} min, verificador {n(e.gasto.minutos.verificador)} min)
          {' '}· quedan ≈ <b>{usd(e.gasto.queda)} USD</b> de {usd(e.gasto.credito)}.
        </p>
      )}
    </div>
  );
}

// ── Secciones plegadas ───────────────────────────────────────────────────────

function Sirven({ lista, onConsentimiento }: { lista: Verif[]; onConsentimiento: (id: string, valor: string) => void }) {
  return (
    <details className="tv-sec-box">
      <summary>Sirven ({lista.length})</summary>
      {lista.length === 0 ? <p className="tv-line">Todavía ninguna.</p> : (
        <ul className="tv-rows">
          {lista.map(v => (
            <li key={v.id}>
              <b>{v.student_name}</b> · {v.teacher_name ?? '—'} · {fecha(v.antes?.fecha)} → {fecha(v.despues?.fecha)} · nota {v.juez_nota ?? '—'}
              {v.antes?.fathom && <> · <a href={v.antes.fathom} target="_blank" rel="noopener noreferrer">antes</a></>}
              {v.despues?.fathom && <> · <a href={v.despues.fathom} target="_blank" rel="noopener noreferrer">después</a></>}
              <select className="tv-mini" value={v.consentimiento} onChange={e => onConsentimiento(v.id, e.target.value)} aria-label="Consentimiento">
                {Object.entries(CONSENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Descartados({ lista, post, onVer }: {
  lista: Verif[]; post: <T>(a: string, e?: Record<string, unknown>) => Promise<T>; onVer: (u: string) => void;
}) {
  const [media, setMedia] = useState<Record<string, string> | null>(null);
  const abrir = async (open: boolean) => {
    if (!open || media) return;
    try {
      const r = await post<{ media: Record<string, string> }>('medios', { ids: lista.filter(v => !v.files_deleted_at).map(v => v.id) });
      setMedia(r.media);
    } catch { setMedia({}); }
  };
  return (
    <details className="tv-sec-box" onToggle={e => abrir((e.target as HTMLDetailsElement).open)}>
      <summary>Descartados por el verificador ({lista.length})</summary>
      {lista.length === 0 ? <p className="tv-line">Ninguno todavía.</p> : (
        <ul className="tv-desc">
          {lista.map(v => (
            <li key={v.id}>
              <div>
                <b>{v.student_name}</b> · {v.teacher_name ?? '—'} · <span className="tv-motivo">{v.motivo ? MOTIVO_LABEL[v.motivo] : '—'}</span>
                {v.fathom_causa && <> ({v.fathom_causa})</>}
                <div className="tv-detalle">{v.motivo_detalle}</div>
              </div>
              <div className="tv-mini-frames">
                {[...(v.antes?.frames ?? []), ...(v.despues?.frames ?? [])].map(p => media?.[p] ? (
                  <button key={p} type="button" className="tv-frame is-mini" onClick={() => onVer(media[p])} aria-label="Ampliar fotograma">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={media[p]} alt="" loading="lazy" />
                  </button>
                ) : null)}
                {v.files_deleted_at && <span className="tv-detalle">Fotogramas borrados (más de 30 días)</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Umbrales({ estado, onDeshacer }: { estado: Estado; onDeshacer: (id: number) => void }) {
  const activos = estado.cambios.filter(c => !c.reverted_at);
  return (
    <details className="tv-sec-box" open={activos.length > 0}>
      <summary>Umbrales{activos.length ? ` (${activos.length} endurecidos)` : ''}</summary>
      {estado.cambios.length > 0 && (
        <ul className="tv-rows">
          {estado.cambios.map(c => (
            <li key={c.id}>
              {fecha(c.created_at)} · <b>{c.key}</b>: {c.antes} → {c.despues} · {c.detalle}
              {c.reverted_at ? <span className="tv-detalle"> (deshecho)</span>
                : <button type="button" className="tv-link" onClick={() => onDeshacer(c.id)}>Deshacer</button>}
            </li>
          ))}
        </ul>
      )}
      <table className="tv-tabla">
        <tbody>
          {estado.umbrales.map(u => (
            <tr key={u.key}><td><code>{u.key}</code></td><td className="tv-num">{u.value}</td><td>{u.description}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="tv-line">Se cambian en Supabase, tabla <code>testimonial_config</code>.</p>
    </details>
  );
}

function Prueba({ estado, progreso, ocupado, onLanzar, onCancelar }: {
  estado: Estado; progreso: Progreso | null; ocupado: boolean; onLanzar: () => void; onCancelar: () => void;
}) {
  const p = estado.prueba;
  const linea = (r: ResumenPrueba) => `${r.descartados} de ${r.total} descartadas (${pct(r.descartados, r.total)})`
    + `${r.aprobados ? ` · ${r.aprobados} aprobadas` : ''}${r.errores ? ` · ${r.errores} con error` : ''}`;
  return (
    <details className="tv-sec-box">
      <summary>Prueba con los “No sirve” ({p.todas.total} de {p.objetivo})</summary>
      <p className="tv-line">
        Pasa el verificador por las parejas que marcaste “No sirve” (no cambia nada de ellas). Objetivo: descartar al menos el 90 %.
      </p>
      {progreso ? (
        <div className="tv-bar-acc">
          <div className="tv-prog" role="status">
            <span>Verificando {progreso.hechas} de {progreso.total}…</span>
            <div className="tv-prog-bar"><div style={{ width: `${progreso.total ? (progreso.hechas / progreso.total) * 100 : 0}%` }} /></div>
          </div>
          <button type="button" className="tv-btn tv-sec" onClick={onCancelar}>Cancelar</button>
        </div>
      ) : (
        <button type="button" className="tv-btn tv-sec" disabled={ocupado} onClick={onLanzar}>
          {p.todas.total === 0 ? 'Empezar la prueba' : 'Seguir con las que faltan'}
        </button>
      )}
      {p.todas.total > 0 && (
        <>
          <p className="tv-line"><b>Todas:</b> {linea(p.todas)}. Motivos: {motivosFrase(p.todas.porMotivo) || '—'}.</p>
          <p className="tv-line"><b>Sin las {p.conEnlaceFalso} de enlace falso:</b> {linea(p.sinEnlaceFalso)}. Motivos: {motivosFrase(p.sinEnlaceFalso.porMotivo) || '—'}.</p>
        </>
      )}
    </details>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
// Marca: verde #1E9E3A, amarillo #FFC400, fondo #F7F7F5, Radio Canada.
const ESTILOS = `
.tv { --verde: #1E9E3A; --amarillo: #FFC400; --fondo: #F7F7F5; --azul: #2563eb; --tinta: #1a1c1a; --gris: #6E6E66; --linea: #E6E7E2; --rojo: #C81E1E;
  font-family: var(--font-app); color: var(--tinta); }
.tv-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 12px; }
.tv-bar { margin: 0 0 14px; padding: 14px 16px; border-radius: 14px; background: var(--fondo); display: flex; flex-direction: column; gap: 8px; }
.tv-bar-acc { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tv-line { margin: 0; font-size: 13.5px; line-height: 1.5; color: #4A4A4A; font-variant-numeric: tabular-nums; }
.tv-escucha { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--linea); }
.tv-prog { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 600; }
.tv-prog-bar { height: 8px; border-radius: 999px; background: #E3E4DE; overflow: hidden; }
.tv-prog-bar > div { height: 100%; background: var(--verde); transition: width .3s; }
.tv-alarma { margin: 0 0 12px; padding: 12px 14px; border-radius: 12px; background: rgba(255,196,0,0.18); border: 1.5px solid var(--amarillo); font-size: 14px; font-weight: 700; color: #6b5200; }
.tv-alarma span { font-weight: 500; }
.tv-error { margin: 0 0 12px; font-size: 13.5px; font-weight: 600; color: var(--rojo); }
.tv-aviso { margin: 0 0 12px; padding: 10px 14px; border-radius: 12px; background: rgba(30,158,58,0.08); font-size: 13.5px; color: #20562d; }
.tv-vacio { margin: 0; padding: 28px 16px; border-radius: 14px; background: var(--fondo); font-size: 14px; color: var(--gris); text-align: center; }
.tv-link { border: 0; background: none; padding: 0 0 0 8px; min-height: 0; font-family: inherit; font-size: inherit; font-weight: 700; color: var(--azul); cursor: pointer; text-decoration: underline; }

.tv-btn { min-height: 44px; padding: 0 18px; border-radius: 10px; font-family: inherit; font-size: 14.5px; font-weight: 700; cursor: pointer; }
.tv-btn:disabled { opacity: .5; cursor: default; }
.tv-pri { border: 0; background: var(--verde); color: #fff; }
.tv-pri:hover:not(:disabled) { background: #188531; }
.tv-sec { border: 1.5px solid var(--linea); background: #fff; color: #4A4A4A; }
.tv-si { border: 1.5px solid var(--verde); background: #fff; color: var(--verde); }
.tv-si:hover:not(:disabled) { background: rgba(30,158,58,0.08); }
.tv-no { border: 1.5px solid var(--linea); background: #fff; color: #4A4A4A; }
.tv-no:hover:not(:disabled) { border-color: var(--rojo); color: var(--rojo); }
.tv-no-conf { border: 0; background: var(--rojo); color: #fff; }

.tv-lista { display: grid; gap: 16px; }
.tv-card { background: #fff; border: 1px solid var(--linea); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.tv-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.tv-col { background: var(--fondo); border-radius: 12px; padding: 12px 14px; border-top: 4px solid var(--amarillo); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.tv-col.is-despues { border-top-color: var(--verde); }
.tv-col-h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.tv-et { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #8a6a00; }
.tv-col.is-despues .tv-et { color: var(--verde); }
.tv-fecha { font-size: 13px; color: var(--gris); }
.tv-frames { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.tv-frame { padding: 0; border: 0; border-radius: 8px; overflow: hidden; background: #ddd; aspect-ratio: 16 / 9; cursor: zoom-in; min-height: 0; }
.tv-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tv-frame.is-vacio { display: block; }
.tv-frame.is-mini { width: 96px; flex: 0 0 auto; }
.tv-audio { width: 100%; height: 36px; }
.tv-texto { margin: 0; font-size: 14.5px; line-height: 1.5; }
.tv-med { margin: 0; font-size: 13px; color: #4A4A4A; font-variant-numeric: tabular-nums; }
.tv-fathom { font-size: 13.5px; font-weight: 700; color: var(--azul); text-decoration: none; }
.tv-fathom:hover { text-decoration: underline; }
.tv-pie { display: flex; flex-direction: column; gap: 8px; }
.tv-datos { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; font-size: 14px; color: var(--gris); }
.tv-alumno { font-size: 17px; font-weight: 700; color: var(--tinta); }
.tv-juez { margin: 0; font-size: 14px; line-height: 1.5; display: flex; gap: 10px; align-items: baseline; }
.tv-nota { flex: 0 0 auto; min-width: 44px; padding: 2px 10px; border-radius: 999px; background: rgba(30,158,58,0.12); color: var(--verde); font-weight: 800; text-align: center; }
.tv-consent { font-size: 13.5px; color: #4A4A4A; display: flex; gap: 8px; align-items: center; }
.tv-consent select, .tv-mini { font-family: inherit; font-size: 13.5px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--linea); background: #fff; min-height: 32px; }
.tv-mini { margin-left: 10px; }
.tv-acc { display: flex; gap: 10px; flex-wrap: wrap; }
.tv-motivos { border: 1px solid var(--linea); border-radius: 12px; padding: 12px 14px; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.tv-motivos legend { font-size: 14px; font-weight: 700; padding: 0 4px; }
.tv-motivos-l { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px 12px; }
.tv-radio { display: flex; align-items: center; gap: 8px; font-size: 14px; min-height: 32px; cursor: pointer; }
.tv-input { font-family: inherit; font-size: 14px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--linea); }

.tv-sec-box { margin-top: 14px; padding: 12px 14px; border-radius: 12px; background: var(--fondo); }
.tv-sec-box > summary { cursor: pointer; font-size: 14px; font-weight: 700; min-height: 32px; display: flex; align-items: center; }
.tv-sec-box > * + * { margin-top: 10px; }
.tv-rows { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 13.5px; }
.tv-rows a { color: var(--azul); font-weight: 600; }
.tv-desc { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.tv-desc li { background: #fff; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 13.5px; }
.tv-motivo { font-weight: 700; color: var(--rojo); }
.tv-detalle { font-size: 12.5px; color: var(--gris); }
.tv-mini-frames { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tv-tabla { width: 100%; border-collapse: collapse; font-size: 13px; }
.tv-tabla td { padding: 6px 8px; border-top: 1px solid var(--linea); vertical-align: top; }
.tv-num { font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

.tv-lightbox { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out; }
.tv-lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }

@media (max-width: 900px) { .tv-cols { grid-template-columns: 1fr; } }
@media (max-width: 767px) { .tv-title { display: none; } .tv-card { padding: 14px; } }
`;
