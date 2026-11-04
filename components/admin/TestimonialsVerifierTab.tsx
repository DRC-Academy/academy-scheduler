'use client';

// Pestaña admin "Testimoniales": PANEL DE ANÁLISIS + VERIFICADOR.
//
// El admin elige qué se analiza (fechas, alumno, profe, cuántos testimonios,
// fuente, solo lo nunca analizado) y ve ANTES de gastar cuántas clases y alumnos
// salen y cuánto costaría (lib/testimonialAnalysis). Cuántas combinaciones se
// prueban por alumno NO se elige aquí: es testimonial_config.parejas_por_alumno.
//
// Texto para el admin: "testimonio/testimonios". En el código y la base sigue
// llamándose "pareja" (testimonial_candidates, tipo 'pareja', etc.).
// "Analizar" abre una tanda guardada en Supabase: si es con la escucha, primero
// escucha las clases que falten; después verifica las parejas, 3 alumnos a la vez
// y una llamada al servidor por pareja. "Pausar" para y la tanda queda guardada;
// "Reanudar" (también tras cerrar la pestaña) sigue donde quedó sin repetir nada.
// "Solo verificar" hace lo mismo sin escuchar clases nuevas.
//
// Las aprobadas salen primero las de alumnos con progreso medio real y, dentro, de
// mejor a peor nota, con fotogramas, audio recortado y medidas. "No sirve" pide
// motivo: alimenta el banco de ejemplos y puede endurecer un umbral (que se deshace
// en "Detalles de la última tanda").
//
// "Revisar descartes": todos los descartes por motivo. "Descarte injusto" los pasa a
// Por revisar; con muchos injustos en un motivo se propone aflojar su regla (nunca
// se cambia sola).
//
// Orden de la pantalla: panel de filtros, tarjetas por revisar y, plegadas, Sirven,
// Revisar descartes y Prueba. Los umbrales NO se muestran: viven en testimonial_config.
// El consentimiento tampoco (todos lo dieron); la columna y la API siguen ahí.
//
// Todo pasa por /api/admin/testimonial-verify con la sesión de admin (adminFetch).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { adminFetch } from '@/lib/adminSessionClient';
import { formatSeconds } from '@/lib/fluency';
import { MOTIVOS_ADMIN, MOTIVO_LABEL, motivosFrase, type ClipMeasures, type Motivo } from '@/lib/testimonialMeasures';

interface Side {
  fecha: string; inicio: number; dur: number; fathom: string | null; audio: string | null; frames: string[];
  texto: string | null; textoFathom: string; medidas: ClipMeasures | null;
}
interface Verif {
  id: string; batch_id: string | null; student_name: string | null; teacher_name: string | null; status: string;
  motivo: Motivo | null; motivo_detalle: string | null; fathom_causa: string | null; antes: Side | null; despues: Side | null;
  semanas: number | null; juez_nota: number | null; juez_explicacion: string | null;
  review: string | null; review_motivo: string | null;
  created_at: string; updated_at: string; files_deleted_at: string | null; ajustes: Record<string, string> | null;
  descarte_revision: 'injusto' | 'justo' | null; descarte_nota: string | null;
  /** Solo en "Por revisar": velocidad media de las primeras clases y de las últimas. */
  progreso?: { antes: number; despues: number; factor: number; clases: number } | null;
}
type ConteoDescartes = Record<string, { injustos: number; justos: number }>;
interface Tanda {
  id: string; startedAt: string; finishedAt: string | null; cancelled: boolean; planned: number; revisados: number;
  aprobados: number; errores: number; porMotivo: Record<string, number>; fuenteError: number; enlacesProbados: number;
  sirven: number; revisadas: number; alumnos: number | null; costeDeepgram: number; costeClaude: number;
}
interface ResumenPrueba { total: number; descartados: number; aprobados: number; errores: number; porMotivo: Record<string, number> }
type Fuente = 'escucha' | 'texto';
interface TandaEstado {
  batchId: string; fuente: Fuente; fase: 'escuchar' | 'verificar'; objetivo: number | null; porAlumno: number; pausada: boolean;
  escuchar: { total: number; hechas: number; pendientes: number[] };
  parejas: { total: number; hechas: number; aprobadas: number; saltadas: number; errores: number; pendientes: Array<{ g: string; idx: number[] }> };
  resumen: ResumenTanda;
  gasto?: { escucha: number; verificacion: number; total: number };
}
interface Estado {
  tarjetas: Verif[]; media: Record<string, string>; aprobadasPendientes: number; progresoMin: number; sirven: Verif[];
  descartesTotal: number; avisosDescartes: Array<{ motivo: Motivo; injustos: number; revisados: number; regla: string | null }>;
  tandas: Tanda[]; alarma: { fallos: number; probados: number } | null; motivosRechazo: Record<string, number>;
  revisionesMiradas: number;
  cambios: Array<{ id: number; key: string; antes: number; despues: number; motivo: string; detalle: string | null; created_at: string; reverted_at: string | null }>;
  umbrales: Array<{ key: string; value: number; description: string; motivo: string | null }>;
  prueba: { objetivo: number; todas: ResumenPrueba; sinEnlaceFalso: ResumenPrueba; conEnlaceFalso: number };
  gasto: { minutos: { escucha: number; verificador: number }; usd: number; credito: number; queda: number } | null;
  abierta: TandaEstado | null;
}
interface Progreso { kind: 'prueba'; hechas: number; total: number; aprobadas: number; errores: number }
interface Analisis {
  batchId: string; fase: 'escuchar' | 'verificar'; escHechas: number; escTotal: number;
  hechas: number; total: number; aprobadas: number; saltadas: number; errores: number; pausando: boolean;
  /** Gasto acumulado de la tanda en $ (escucha + verificación). */
  gasto: number;
}
interface ResumenTanda { revisados: number; aprobados: number; porMotivo: Record<string, number>; costeDeepgram: number; costeClaude: number }
interface Recuento {
  clases: number; porEscuchar: number; alumnos: number; parejas: number; parejasMinimo: boolean; aVerificar: number;
  coste: { escucha: number; verificacion: number; total: number; porPareja: number };
}
interface ItemResultado { status: 'hecha' | 'saltada' | 'error'; motivo: string | null; resultado: { status: string; coste?: number } | null; fin: boolean }
interface Opcion { id: string; name: string }

const API = '/api/admin/testimonial-verify';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MESES[m - 1]} ${y}`;
};
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');
const usd = (x: number) => `${x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const n = (x: number) => x.toLocaleString('es-ES');
const gasto = (t: { costeDeepgram: number; costeClaude: number }) =>
  `${usd(t.costeDeepgram + t.costeClaude)} (Deepgram ${usd(t.costeDeepgram)} + Claude ${usd(t.costeClaude)})`;
const CANTIDADES = ['50', '200', '500', '1000', 'todas'] as const;
const TARJETAS_PAGINA = 20;
const AJUSTE_LADO = { antes: 'Antes', despues: 'Después', aviso: 'Revisar' } as const;

export default function TestimonialsVerifierTab() {
  const { user } = useAuth();
  const creds = useMemo(() => (user ? { username: user.username, password: user.password } : null), [user]);
  const [estado, setEstado] = useState<Estado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const [analisis, setAnalisis] = useState<Analisis | null>(null);
  const [grande, setGrande] = useState<string | null>(null);
  const cancelar = useRef(false);
  const pausar = useRef(false);
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
    return () => { vivo.current = false; cancelar.current = true; pausar.current = true; };
  }, [cargar]);

  const paralelo = Math.max(1, estado?.umbrales.find(u => u.key === 'analisis_en_paralelo')?.value ?? 3);

  /**
   * Lleva una tanda del panel hasta el final o hasta "Pausar": primero las clases
   * por escuchar (si las hay) y luego las parejas, alumno a alumno.
   */
  const correr = useCallback(async (batchId: string) => {
    pausar.current = false;
    setError(null); setAviso(null);
    let seguidos = 0, parado = false;
    const fallo = (e: unknown) => {
      if (++seguidos >= 3) { parado = true; pausar.current = true; setError(`Se paró tras 3 fallos seguidos: ${e instanceof Error ? e.message : e}`); }
    };
    try {
      let t = await post<TandaEstado>('analisis-estado', { batchId });
      if (t.pausada) await post('analisis-pausar', { batchId, pausada: false });
      const p: Analisis = {
        batchId, fase: t.fase, escHechas: t.escuchar.hechas, escTotal: t.escuchar.total,
        hechas: t.parejas.hechas, total: t.objetivo ?? t.parejas.total, aprobadas: t.parejas.aprobadas,
        saltadas: t.parejas.saltadas, errores: t.parejas.errores, pausando: false, gasto: t.gasto?.total ?? 0,
      };
      const pintar = () => { if (vivo.current) setAnalisis({ ...p }); };
      pintar();

      if (t.fase === 'escuchar') {
        const cola = [...t.escuchar.pendientes];
        let cortado = false;
        const trabajador = async () => {
          for (let i = cola.shift(); i != null; i = cola.shift()) {
            if (pausar.current || !vivo.current) { cortado = true; return; }
            try {
              const r = await post<{ result: { usd?: number } | null }>('analisis-escuchar', { batchId, idx: i });
              p.gasto += r.result?.usd ?? 0;
              seguidos = 0;
            } catch (e) { p.errores++; fallo(e); }
            p.escHechas++;
            pintar();
          }
        };
        await Promise.all(Array.from({ length: paralelo }, trabajador));
        if (cortado) throw new Pausa();
        t = await post<TandaEstado>('analisis-planificar', { batchId });
        Object.assign(p, { fase: 'verificar', total: t.objetivo ?? t.parejas.total });
        pintar();
      }

      // Parejas: cada trabajador coge un alumno y prueba sus parejas en orden hasta su tope de testimonios.
      const alumnos = [...t.parejas.pendientes];
      let enCurso = 0, fin = false, cortado = false;
      const trabajador = async () => {
        for (let al = alumnos.shift(); al; al = alumnos.shift()) {
          for (const i of al.idx) {
            if (fin) return;
            if (pausar.current || !vivo.current) { cortado = true; return; }
            if (t.objetivo != null && p.hechas + enCurso >= t.objetivo) { fin = true; return; }
            enCurso++;
            let otroAlumno = false;
            try {
              const r = await post<ItemResultado>('analisis-verificar', { batchId, idx: i });
              if (r.status === 'hecha') p.hechas++;
              if (r.status === 'saltada') p.saltadas++;
              if (r.status === 'error') p.errores++;
              if (r.resultado?.status === 'aprobado') p.aprobadas++;
              p.gasto += r.resultado?.coste ?? 0;
              // Con el tope de testimonios, el alumno ya está: sus otras parejas no se prueban.
              otroAlumno = r.motivo === 'alumno_aprobado';
              if (r.fin) fin = true;
              seguidos = 0;
            } catch (e) { p.errores++; fallo(e); }
            enCurso--;
            pintar();
            if (otroAlumno) break;
          }
        }
      };
      await Promise.all(Array.from({ length: paralelo }, trabajador));
      if (cortado && !fin) throw new Pausa();

      const r = await post<{ resumen: ResumenTanda }>('cerrar', { batchId, cancelado: false });
      if (vivo.current) {
        const res = r.resumen;
        setAviso(res.revisados === 0
          ? 'No había testimonios que verificar con esos filtros.'
          : `Tanda terminada: ${res.aprobados} aprobados de ${res.revisados} verificados.`);
      }
    } catch (e) {
      if (e instanceof Pausa) {
        await post('analisis-pausar', { batchId, pausada: true }).catch(() => {});
        if (vivo.current && !parado) setAviso('Tanda en pausa y guardada.');
      } else if (vivo.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (vivo.current) { setAnalisis(null); await cargar(); }
    }
  }, [post, cargar, paralelo]);

  const analizar = useCallback(async (opciones: Record<string, unknown>) => {
    setError(null); setAviso(null);
    try {
      const t = await post<TandaEstado>('analisis-iniciar', { opciones });
      await correr(t.batchId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, correr]);

  /**
   * "Reanalizar todo": cuenta lo que haría y su coste, pide confirmación y borra
   * los veredictos del verificador (no lo marcado a mano) antes de abrir la tanda.
   */
  const reanalizar = useCallback(async () => {
    setError(null); setAviso(null);
    try {
      const r = await post<Recuento>('reanalizar-contar');
      const msg = [
        'REANALIZAR TODO con las reglas actuales.',
        '',
        'Se borran los veredictos anteriores del verificador (descartes y aprobados sin revisar).',
        'Lo que marcaste a mano (Sirve / No sirve) se queda como está.',
        '',
        `Clases por escuchar: ${n(r.porEscuchar)} (≈ ${usd(r.coste.escucha)}). Lo ya escuchado no se vuelve a pagar.`,
        `Testimonios a verificar: ${r.parejasMinimo ? 'al menos ' : ''}${n(r.parejas)} ya posibles (≈ ${usd(r.parejas * r.coste.porPareja)}).`,
        `Como mucho, si ninguno aprobara: ${n(r.aVerificar)} (≈ ${usd(r.coste.verificacion)}).`,
        '',
        '¿Seguir?',
      ].join('\n');
      if (!window.confirm(msg)) return;
      const t = await post<TandaEstado>('reanalizar-todo', { confirmado: true });
      await cargar();
      await correr(t.batchId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar, correr]);

  const terminar = useCallback(async (batchId: string) => {
    try {
      const r = await post<{ resumen: ResumenTanda }>('cerrar', { batchId, cancelado: true });
      setAviso(`Tanda terminada a mano: ${r.resumen.aprobados} aprobados de ${r.resumen.revisados} verificados.`);
      await cargar();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar]);

  /** Tanda de PRUEBA (los "No sirve" del admin): una llamada por pareja, 3 a la vez. */
  const probar = useCallback(async () => {
    cancelar.current = false;
    setError(null); setAviso(null);
    let batchId: string | null = null;
    try {
      const inicio = await post<{ batchId: string; ids: string[] }>('iniciar', { tipo: 'prueba' });
      batchId = inicio.batchId;
      const cola = [...inicio.ids];
      const p: Progreso = { kind: 'prueba', hechas: 0, total: cola.length, aprobadas: 0, errores: 0 };
      setProgreso({ ...p });
      let seguidos = 0;
      const trabajador = async () => {
        for (let id = cola.shift(); id; id = cola.shift()) {
          if (cancelar.current || !vivo.current) return;
          try {
            const r = await post<{ status: string }>('verificar', { id, batchId, tipo: 'prueba' });
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
      await Promise.all(Array.from({ length: 3 }, trabajador));
    } catch (e) {
      if (vivo.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (batchId) await post('cerrar', { batchId, cancelado: cancelar.current }).catch(() => {});
      if (vivo.current) { setProgreso(null); await cargar(); }
    }
  }, [post, cargar]);

  const revisar = useCallback(async (id: string, review: 'sirve' | 'no_sirve', motivo?: Motivo, texto?: string) => {
    try {
      const r = await post<{ endurecido: { key: string; antes: number; despues: number } | null }>('revisar', { id, review, motivo, texto });
      if (r.endurecido) setAviso(`Umbral endurecido: ${r.endurecido.key} pasa de ${r.endurecido.antes} a ${r.endurecido.despues}. Se deshace en “Detalles de la última tanda”.`);
      await cargar();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar]);

  const deshacer = useCallback(async (changeId: number) => {
    try { await post('deshacer-umbral', { changeId }); await cargar(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [post, cargar]);

  const ocupado = !!progreso || !!analisis;

  return (
    <div className="tv">
      <h2 className="tv-title">Testimoniales</h2>

      {estado && (
        <section className="tv-bar">
          <PanelAnalisis post={post} analisis={analisis} abierta={analisis ? null : estado.abierta} ocupado={ocupado}
            onAnalizar={analizar} onReanudar={correr} onTerminar={terminar} onReanalizar={reanalizar}
            onPausar={() => { pausar.current = true; setAnalisis(a => (a ? { ...a, pausando: true } : a)); }} />
          <Detalles estado={estado} onDeshacer={deshacer} />
        </section>
      )}

      {estado?.alarma && (
        <p className="tv-alarma" role="alert">
          No se pudieron leer los videos de Fathom: fallaron {estado.alarma.fallos} de {estado.alarma.probados} enlaces en la última tanda.
        </p>
      )}
      {estado?.avisosDescartes.map(a => (
        <p key={a.motivo} className="tv-alarma" role="status">
          {MOTIVO_LABEL[a.motivo]}: marcaste {a.injustos} descartes injustos de {a.revisados} revisados.
          {a.regla ? ` Propuesta: aflojar ${a.regla}.` : ''} No se cambia solo.
        </p>
      ))}
      {error && <p className="tv-error">{error}</p>}
      {aviso && <p className="tv-aviso">{aviso} <button type="button" className="tv-link" onClick={() => setAviso(null)}>Cerrar</button></p>}

      {!estado ? (
        !error && <p className="tv-vacio">Cargando…</p>
      ) : estado.tarjetas.length === 0 ? (
        <p className="tv-vacio">No hay testimonios por revisar.</p>
      ) : (
        <Aprobadas estado={estado} post={post} onVer={setGrande} onRevisar={revisar} />
      )}

      {estado && (
        <>
          <Sirven lista={estado.sirven} />
          <RevisarDescartes total={estado.descartesTotal} post={post} onVer={setGrande} onCambio={cargar} />
          <Prueba estado={estado} progreso={progreso} ocupado={ocupado}
            onLanzar={probar} onCancelar={() => { cancelar.current = true; }} />
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

/** Corte de la tanda por "Pausar" (o por cerrar la pestaña): se guarda como pausada. */
class Pausa extends Error {}

// ── Panel de análisis ────────────────────────────────────────────────────────

function PanelAnalisis({ post, analisis, abierta, ocupado, onAnalizar, onReanudar, onTerminar, onPausar, onReanalizar }: {
  post: <T>(a: string, e?: Record<string, unknown>) => Promise<T>;
  analisis: Analisis | null; abierta: TandaEstado | null; ocupado: boolean;
  onAnalizar: (opciones: Record<string, unknown>) => void; onReanudar: (batchId: string) => void;
  onTerminar: (batchId: string) => void; onPausar: () => void; onReanalizar: () => void;
}) {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [alumnoTxt, setAlumnoTxt] = useState('');
  const [profeTxt, setProfeTxt] = useState('');
  const [cantidad, setCantidad] = useState<typeof CANTIDADES[number]>('200');
  const [fuente, setFuente] = useState<Fuente>('escucha');
  const [soloNuevas, setSoloNuevas] = useState(true);
  const [opciones, setOpciones] = useState<{ alumnos: Opcion[]; profes: Opcion[] } | null>(null);
  const [cuenta, setCuenta] = useState<Recuento | null>(null);
  const [contando, setContando] = useState(false);
  const [errCuenta, setErrCuenta] = useState<string | null>(null);

  useEffect(() => {
    let ok = true;
    post<{ alumnos: Opcion[]; profes: Opcion[] }>('analisis-opciones').then(o => { if (ok) setOpciones(o); }).catch(() => { if (ok) setOpciones({ alumnos: [], profes: [] }); });
    return () => { ok = false; };
  }, [post]);

  // El texto escrito se convierte en id solo si coincide con un nombre de la lista.
  const porNombre = (lista: Opcion[] | undefined, txt: string) => lista?.find(o => o.name.toLowerCase() === txt.trim().toLowerCase())?.id ?? null;
  const alumno = porNombre(opciones?.alumnos, alumnoTxt), profe = porNombre(opciones?.profes, profeTxt);
  const alumnoMal = !!alumnoTxt.trim() && !alumno, profeMal = !!profeTxt.trim() && !profe;
  const elegidas = useMemo(() => ({
    filtros: { desde: desde || null, hasta: hasta || null, alumno, profe },
    cantidad: cantidad === 'todas' ? null : Number(cantidad), fuente, soloNuevas,
  }), [desde, hasta, alumno, profe, cantidad, fuente, soloNuevas]);

  // Contador en vivo: se recalcula al cambiar los filtros (con una pequeña espera).
  useEffect(() => {
    if (alumnoMal || profeMal) return;
    let ok = true;
    const t = setTimeout(async () => {
      setContando(true); setErrCuenta(null);
      try {
        const r = await post<Recuento>('analisis-contar', { opciones: elegidas });
        if (ok) setCuenta(r);
      } catch (e) { if (ok) setErrCuenta(e instanceof Error ? e.message : String(e)); }
      finally { if (ok) setContando(false); }
    }, 700);
    return () => { ok = false; clearTimeout(t); };
  }, [post, elegidas, alumnoMal, profeMal]);

  const a = analisis;
  return (
    <div className="tv-panel">
      <div className="tv-filtros">
        <label className="tv-campo">Desde<input type="date" value={desde} onChange={e => setDesde(e.target.value)} disabled={ocupado} /></label>
        <label className="tv-campo">Hasta<input type="date" value={hasta} onChange={e => setHasta(e.target.value)} disabled={ocupado} /></label>
        <label className={`tv-campo is-ancho${alumnoMal ? ' is-mal' : ''}`}>Alumno
          <input type="search" list="tv-alumnos" placeholder="Todos" value={alumnoTxt} onChange={e => setAlumnoTxt(e.target.value)} disabled={ocupado} />
        </label>
        <label className={`tv-campo is-ancho${profeMal ? ' is-mal' : ''}`}>Profe
          <input type="search" list="tv-profes" placeholder="Todos" value={profeTxt} onChange={e => setProfeTxt(e.target.value)} disabled={ocupado} />
        </label>
        <datalist id="tv-alumnos">{opciones?.alumnos.map(o => <option key={o.id} value={o.name} />)}</datalist>
        <datalist id="tv-profes">{opciones?.profes.map(o => <option key={o.id} value={o.name} />)}</datalist>
        <label className="tv-campo is-corto">Cantidad
          <select value={cantidad} onChange={e => setCantidad(e.target.value as typeof CANTIDADES[number])} disabled={ocupado}>
            {CANTIDADES.map(c => <option key={c} value={c}>{c === 'todas' ? 'Todas' : n(Number(c))}</option>)}
          </select>
        </label>
        <label className="tv-campo">Fuente
          <select value={fuente} onChange={e => setFuente(e.target.value as Fuente)} disabled={ocupado}>
            <option value="escucha">Escucha</option>
            <option value="texto">Texto (antiguo)</option>
          </select>
        </label>
        <label className="tv-check" title="Solo lo que nunca se analizó">
          <input type="checkbox" checked={soloNuevas} onChange={e => setSoloNuevas(e.target.checked)} disabled={ocupado} /> Solo nuevas
        </label>
      </div>

      <div className="tv-fila">
        {!a && (
          <p className="tv-cuenta" aria-live="polite">
            {alumnoMal || profeMal ? `Elige ${alumnoMal ? 'el alumno' : 'el profe'} de la lista.`
              : errCuenta ? <span className="tv-error">{errCuenta}</span>
              : !cuenta ? 'Calculando…'
              : <>
                  {n(cuenta.clases)} clases · {n(cuenta.alumnos)} alumnos · <b>{usd(cuenta.coste.total)}</b> estimados
                  {contando && ' · recalculando…'}
                </>}
          </p>
        )}
        <div className="tv-bar-acc">
          {a ? (
            <>
              <div className="tv-prog" role="status">
                <span>
                  {a.fase === 'escuchar'
                    ? `Escuchando clases: ${n(a.escHechas)} de ${n(a.escTotal)}…`
                    : `Verificando: ${n(a.hechas)} de ${n(a.total)} · ${n(a.aprobadas)} aprobados`
                      + `${a.saltadas ? ` · ${n(a.saltadas)} saltados` : ''}${a.errores ? ` · ${n(a.errores)} con error` : ''}`}
                  {` · gastado ≈ ${usd(a.gasto)}`}
                  {a.pausando && ' · pausando…'}
                </span>
                <div className="tv-prog-bar">
                  <div style={{ width: `${a.fase === 'escuchar' ? (a.escTotal ? (a.escHechas / a.escTotal) * 100 : 0) : (a.total ? Math.min(100, (a.hechas / a.total) * 100) : 0)}%` }} />
                </div>
              </div>
              <button type="button" className="tv-btn tv-sec" disabled={a.pausando} onClick={onPausar}>Pausar</button>
            </>
          ) : (
            <>
              <button type="button" className="tv-btn tv-pri" disabled={ocupado || !cuenta || alumnoMal || profeMal || !!abierta}
                onClick={() => onAnalizar(elegidas)}>
                Analizar
              </button>
              <button type="button" className="tv-btn tv-sec" disabled={ocupado || !cuenta?.parejas || alumnoMal || profeMal || !!abierta}
                title="Verifica los testimonios ya posibles sin escuchar clases nuevas"
                onClick={() => {
                  if (!cuenta) return;
                  const parejas = Math.min(elegidas.cantidad ?? cuenta.parejas, cuenta.parejas);
                  if (window.confirm(`SOLO VERIFICAR: ${n(parejas)} testimonios (≈ ${usd(parejas * cuenta.coste.porPareja)}). No se escucha ninguna clase nueva.\n\n¿Seguir?`)) {
                    onAnalizar({ ...elegidas, soloVerificar: true });
                  }
                }}>
                Solo verificar
              </button>
              <button type="button" className="tv-btn tv-sec" disabled={ocupado} onClick={onReanalizar}
                title="Borra los veredictos del verificador (no lo que marcaste a mano) y vuelve a analizar todo con las reglas actuales">
                Reanalizar todo
              </button>
            </>
          )}
        </div>
      </div>

      {abierta && !a && (
        <div className="tv-abierta">
          <span>
            <b>Tanda en pausa:</b>{' '}
            {abierta.fase === 'escuchar'
              ? `${n(abierta.escuchar.hechas)} de ${n(abierta.escuchar.total)} clases escuchadas`
              : `${n(abierta.parejas.hechas)} de ${n(abierta.objetivo ?? abierta.parejas.total)} verificados, ${n(abierta.parejas.aprobadas)} aprobados`}
            {' '}· gastado ≈ {abierta.gasto ? usd(abierta.gasto.total) : gasto(abierta.resumen)}.
          </span>
          <button type="button" className="tv-btn tv-pri" disabled={ocupado} onClick={() => onReanudar(abierta.batchId)}>Reanudar</button>
          <button type="button" className="tv-btn tv-sec" disabled={ocupado} onClick={() => onTerminar(abierta.batchId)}>Terminarla</button>
        </div>
      )}
    </div>
  );
}

// ── Estado de las tandas (una línea + desplegable cerrado) ───────────────────

function Detalles({ estado, onDeshacer }: { estado: Estado; onDeshacer: (id: number) => void }) {
  const conDatos = estado.tandas.filter(t => t.revisados > 0);
  const ultima = conDatos[0];
  const endurecidos = estado.cambios.filter(c => !c.reverted_at);
  const conMotivos = Object.keys(estado.motivosRechazo).length > 0;
  if (!ultima && !conMotivos && !estado.gasto && !endurecidos.length) return null;
  return (
    <div className="tv-ultima">
      {ultima && <p className="tv-ultima-l">Última tanda: {n(ultima.revisados)} verificados · {n(ultima.aprobados)} aprobados</p>}
      <details className="tv-detalles">
        <summary>Detalles de la última tanda</summary>
        <div className="tv-detalles-c">
          {ultima && (
            <p className="tv-line">
              <b>Última tanda</b> ({fecha(ultima.startedAt)}{ultima.cancelled ? ', terminada a mano' : ''}{!ultima.finishedAt ? ', en pausa' : ''}): {n(ultima.revisados)} verificados,
              {' '}{ultima.aprobados} aprobados{ultima.errores ? `, ${ultima.errores} con error` : ''}
              {Object.keys(ultima.porMotivo).length > 0 && <> · descartes: {motivosFrase(ultima.porMotivo)}</>}
              {ultima.costeDeepgram + ultima.costeClaude > 0 && <> · gasto estimado: {gasto(ultima)}</>}.
            </p>
          )}
          {conDatos.length > 0 && (
            <p className="tv-line">
              <b>Aprobación por tanda</b> (verificador · tú):{' '}
              {conDatos.slice(0, 5).map(t =>
                `${fecha(t.startedAt)}: ${t.aprobados}/${t.revisados} · ${t.revisadas ? `${t.sirven}/${t.revisadas} sirven (${pct(t.sirven, t.revisadas)})` : 'sin revisar'}`,
              ).join('  |  ')}
            </p>
          )}
          {conMotivos && (
            <p className="tv-line"><b>Tus motivos de “No sirve”</b> (últimas {estado.revisionesMiradas} revisiones): {motivosFrase(estado.motivosRechazo)}.</p>
          )}
          {estado.gasto && (
            <p className="tv-line">
              <b>Deepgram:</b> {usd(estado.gasto.usd)} gastados (escucha {n(estado.gasto.minutos.escucha)} min, verificador {n(estado.gasto.minutos.verificador)} min)
              {' '}· quedan ≈ <b>{usd(estado.gasto.queda)}</b> de {usd(estado.gasto.credito)}.
            </p>
          )}
          {endurecidos.map(c => (
            <p key={c.id} className="tv-line">
              <b>{c.motivo === 'manual' ? 'Umbral cambiado' : 'Umbral endurecido'}</b> ({fecha(c.created_at)}): {c.key} de {c.antes} a {c.despues}.
              <button type="button" className="tv-link" onClick={() => onDeshacer(c.id)}>Deshacer</button>
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}

// ── Aprobadas (primero el progreso medio real; dentro, de mejor a peor nota) ─

function Aprobadas({ estado, post, onVer, onRevisar }: {
  estado: Estado; post: <T>(a: string, e?: Record<string, unknown>) => Promise<T>; onVer: (u: string) => void;
  onRevisar: (id: string, r: 'sirve' | 'no_sirve', m?: Motivo, t?: string) => Promise<void>;
}) {
  const [vistas, setVistas] = useState(TARJETAS_PAGINA);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(false);
  const media = useMemo(() => ({ ...estado.media, ...extra }), [estado.media, extra]);
  const lista = estado.tarjetas.slice(0, vistas);
  const verMas = async () => {
    const siguientes = estado.tarjetas.slice(vistas, vistas + TARJETAS_PAGINA);
    setCargando(true);
    try {
      const r = await post<{ media: Record<string, string> }>('medios', { ids: siguientes.map(v => v.id) });
      setExtra(e => ({ ...e, ...r.media }));
    } catch { /* sin medios: se ven igual, sin fotogramas */ }
    setCargando(false);
    setVistas(v => v + TARJETAS_PAGINA);
  };
  return (
    <div className="tv-lista">
      <h3 className="tv-lista-h">Por revisar ({n(estado.aprobadasPendientes)})</h3>
      {lista.map(v => (
        <Tarjeta key={v.id} v={v} media={media} progresoMin={estado.progresoMin} onVer={onVer} onRevisar={onRevisar} />
      ))}
      {estado.tarjetas.length > vistas && (
        <button type="button" className="tv-btn tv-sec" disabled={cargando} onClick={verMas}>
          {cargando ? 'Cargando…' : `Ver ${Math.min(TARJETAS_PAGINA, estado.tarjetas.length - vistas)} más`}
        </button>
      )}
    </div>
  );
}

/** "Antes: recortado a 11 s… · Después: voz partida…" */
function Ajustes({ a }: { a: Record<string, string> | null }) {
  if (!a || !Object.keys(a).length) return null;
  return (
    <p className="tv-detalle">
      {Object.entries(a).map(([k, t]) => `${AJUSTE_LADO[k as keyof typeof AJUSTE_LADO] ?? k}: ${t}`).join(' · ')}
    </p>
  );
}

// ── Tarjeta ──────────────────────────────────────────────────────────────────

const ppm = (x: number | null | undefined) => (x == null ? '—' : String(Math.round(x)));

/** "Clip: 64 → 138 ppm · Media del alumno: 70 → 95 ppm", con su etiqueta si la media mejora poco. */
function Progreso({ v, min }: { v: Verif; min: number }) {
  const p = v.progreso;
  return (
    <p className="tv-progreso">
      <span>Clip: <b>{ppm(v.antes?.medidas?.ppm)} → {ppm(v.despues?.medidas?.ppm)} ppm</b></span>
      <span>Media del alumno: <b>{p ? `${ppm(p.antes)} → ${ppm(p.despues)} ppm` : 'sin datos'}</b></span>
      {p && p.factor < min && <span className="tv-etiqueta">progreso medio bajo</span>}
    </p>
  );
}

function Tarjeta({ v, media, progresoMin, onVer, onRevisar }: {
  v: Verif; media: Record<string, string>; progresoMin: number; onVer: (u: string) => void;
  onRevisar: (id: string, r: 'sirve' | 'no_sirve', m?: Motivo, t?: string) => Promise<void>;
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
      <header className="tv-datos">
        <span className="tv-alumno">{v.student_name ?? 'Alumno sin nombre'}</span>
        <span>{v.teacher_name ?? '—'} · {v.semanas ?? '?'} semanas</span>
      </header>
      <Progreso v={v} min={progresoMin} />
      <div className="tv-cols">
        <Columna titulo="ANTES" s={v.antes} media={media} onVer={onVer} tono="antes" />
        <Columna titulo="DESPUÉS" s={v.despues} media={media} onVer={onVer} tono="despues" />
      </div>
      <div className="tv-pie">
        {v.juez_nota != null && <p className="tv-juez"><span className="tv-nota" title="Nota del juez">{v.juez_nota}</span> {v.juez_explicacion}</p>}
        {v.descarte_revision === 'injusto' && (
          <p className="tv-detalle">
            <b>Rescatado de los descartes</b> ({v.motivo ? MOTIVO_LABEL[v.motivo] : '—'}): {v.motivo_detalle}
            {v.descarte_nota && <> · Tu nota: {v.descarte_nota}</>}
          </p>
        )}
        <Ajustes a={v.ajustes} />
      </div>
      {!abierto ? (
        <footer className="tv-acc">
          <button type="button" className="tv-btn tv-si" disabled={enviando} onClick={() => enviar('sirve')}>✓ Sirve</button>
          <button type="button" className="tv-btn tv-no" disabled={enviando} onClick={() => setAbierto(true)}>✗ No sirve</button>
        </footer>
      ) : (
        <fieldset className="tv-motivos">
          <legend>¿Por qué no sirve?</legend>
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
      <b>{m.ppm}</b> pal/min · <b>{m.pausas}</b> {m.pausas === 1 ? 'pausa' : 'pausas'}{m.pausas ? ` (la mayor ${m.pausa_max_s} s)` : ''} · <b>{m.muletillas}</b> muletillas
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
      {s.audio && media[s.audio] && <audio className="tv-audio" controls preload="none" src={media[s.audio]} />}
      <div className="tv-frames">
        {s.frames.map(p => media[p] ? (
          <button key={p} type="button" className="tv-frame" onClick={() => onVer(media[p])} aria-label="Ampliar fotograma">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={media[p]} alt="" loading="lazy" />
          </button>
        ) : <span key={p} className="tv-frame is-vacio" />)}
      </div>
      <blockquote className="tv-texto">“{s.texto || '—'}”</blockquote>
      <Medidas m={s.medidas} />
      {s.fathom && <a className="tv-fathom" href={s.fathom} target="_blank" rel="noopener noreferrer">▶ Ver en Fathom ({formatSeconds(Math.round(s.inicio))})</a>}
    </section>
  );
}

// ── Secciones plegadas ───────────────────────────────────────────────────────

function Sirven({ lista }: { lista: Verif[] }) {
  return (
    <details className="tv-sec-box">
      <summary>Sirven ({lista.length})</summary>
      {lista.length === 0 ? <p className="tv-line">Todavía ninguno.</p> : (
        <ul className="tv-rows">
          {lista.map(v => (
            <li key={v.id}>
              <b>{v.student_name}</b> · {v.teacher_name ?? '—'} · {fecha(v.antes?.fecha)} → {fecha(v.despues?.fecha)} · nota {v.juez_nota ?? '—'}
              {v.antes?.fathom && <> · <a href={v.antes.fathom} target="_blank" rel="noopener noreferrer">antes</a></>}
              {v.despues?.fathom && <> · <a href={v.despues.fathom} target="_blank" rel="noopener noreferrer">después</a></>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

type Post = <T>(a: string, e?: Record<string, unknown>) => Promise<T>;
type DecisionDescarte = 'injusto' | 'justo' | null;

const motivoDe = (v: Verif) => v.motivo ?? 'otro';

/** Todos los descartes, por motivo. Se cargan al abrir la sección. */
function RevisarDescartes({ total, post, onVer, onCambio }: { total: number; post: Post; onVer: (u: string) => void; onCambio: () => Promise<void> }) {
  const [datos, setDatos] = useState<{ lista: Verif[]; conteo: ConteoDescartes } | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const abrir = async (open: boolean) => {
    if (!open || datos) return;
    try { setDatos(await post<{ lista: Verif[]; conteo: ConteoDescartes }>('descartes')); setFallo(null); }
    catch (e) { setFallo(e instanceof Error ? e.message : String(e)); }
  };
  const decidir = async (v: Verif, decision: DecisionDescarte, nota: string) => {
    await post('descarte-revisar', { id: v.id, decision, nota: nota || null });
    setDatos(d => {
      if (!d) return d;
      const m = motivoDe(v), c = d.conteo[m] ?? { injustos: 0, justos: 0 };
      if (decision === 'injusto') {
        return { lista: d.lista.filter(x => x.id !== v.id), conteo: { ...d.conteo, [m]: { ...c, injustos: c.injustos + 1 } } };
      }
      return {
        lista: d.lista.map(x => (x.id === v.id ? { ...x, descarte_revision: decision } : x)),
        conteo: { ...d.conteo, [m]: { ...c, justos: c.justos + (decision === 'justo' ? 1 : -1) } },
      };
    });
    if (decision === 'injusto') await onCambio();
  };
  const grupos = useMemo(() => {
    const m = new Map<Motivo, Verif[]>();
    for (const v of datos?.lista ?? []) m.set(motivoDe(v), [...(m.get(motivoDe(v)) ?? []), v]);
    return [...m].sort((a, b) => b[1].length - a[1].length);
  }, [datos]);
  return (
    <details className="tv-sec-box" onToggle={e => abrir((e.target as HTMLDetailsElement).open)}>
      <summary>Revisar descartes ({n(datos?.lista.length ?? total)})</summary>
      {fallo && <p className="tv-error">{fallo}</p>}
      {!datos ? !fallo && <p className="tv-line">Cargando…</p>
        : grupos.length === 0 ? <p className="tv-line">Ninguno todavía.</p>
        : grupos.map(([motivo, lista]) => (
          <GrupoDescartes key={motivo} motivo={motivo} lista={lista} conteo={datos.conteo[motivo]} post={post} onVer={onVer} onDecidir={decidir} />
        ))}
    </details>
  );
}

function GrupoDescartes({ motivo, lista, conteo, post, onVer, onDecidir }: {
  motivo: Motivo; lista: Verif[]; conteo?: { injustos: number; justos: number }; post: Post; onVer: (u: string) => void;
  onDecidir: (v: Verif, d: DecisionDescarte, nota: string) => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [vistas, setVistas] = useState(TARJETAS_PAGINA);
  const [media, setMedia] = useState<Record<string, string>>({});
  const pedidos = useRef(new Set<string>());
  const visibles = lista.slice(0, vistas);
  // Enlaces firmados de lo que se ve, solo con el grupo abierto y una sola vez.
  useEffect(() => {
    if (!abierto) return;
    const ids = visibles.filter(v => !v.files_deleted_at && !pedidos.current.has(v.id)).map(v => v.id);
    if (!ids.length) return;
    ids.forEach(id => pedidos.current.add(id));
    let ok = true;
    post<{ media: Record<string, string> }>('medios', { ids })
      .then(r => { if (ok) setMedia(m => ({ ...m, ...r.media })); })
      .catch(() => { /* sin medios: se ven las medidas y el motivo */ });
    return () => { ok = false; };
  }, [abierto, visibles, post]);
  const injustos = conteo?.injustos ?? 0, revisados = injustos + (conteo?.justos ?? 0);
  return (
    <details className="tv-grupo" onToggle={e => setAbierto((e.target as HTMLDetailsElement).open)}>
      <summary>
        {MOTIVO_LABEL[motivo] ?? motivo} ({n(lista.length)})
        {revisados > 0 && <span className="tv-grupo-rev"> · {n(revisados)} {revisados === 1 ? 'revisado' : 'revisados'}, {n(injustos)} {injustos === 1 ? 'injusto' : 'injustos'}</span>}
      </summary>
      {abierto && (
        <div className="tv-grupo-c">
          {visibles.map(v => <DescarteCard key={v.id} v={v} media={media} onVer={onVer} onDecidir={onDecidir} />)}
          {lista.length > vistas && (
            <button type="button" className="tv-btn tv-sec" onClick={() => setVistas(x => x + TARJETAS_PAGINA)}>
              Ver {n(Math.min(TARJETAS_PAGINA, lista.length - vistas))} más
            </button>
          )}
        </div>
      )}
    </details>
  );
}

function DescarteCard({ v, media, onVer, onDecidir }: {
  v: Verif; media: Record<string, string>; onVer: (u: string) => void;
  onDecidir: (v: Verif, d: DecisionDescarte, nota: string) => Promise<void>;
}) {
  const [nota, setNota] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  const decidir = async (d: DecisionDescarte) => {
    setEnviando(true); setFallo(null);
    try { await onDecidir(v, d, nota); } catch (e) { setFallo(e instanceof Error ? e.message : String(e)); }
    setEnviando(false);
  };
  return (
    <article className="tv-card">
      <header className="tv-datos">
        <span className="tv-alumno">{v.student_name ?? 'Alumno sin nombre'}</span>
        <span>{v.teacher_name ?? '—'} · {v.semanas ?? '?'} semanas</span>
        {v.juez_nota != null && <span>Nota del juez: <b>{v.juez_nota}</b></span>}
      </header>
      <p className="tv-motivo-det">
        <span className="tv-motivo">{MOTIVO_LABEL[motivoDe(v)] ?? motivoDe(v)}{v.fathom_causa ? ` (${v.fathom_causa})` : ''}:</span>{' '}
        {v.motivo_detalle ?? v.juez_explicacion ?? 'Sin detalle.'}
      </p>
      {v.motivo_detalle && v.juez_explicacion && <p className="tv-detalle">{v.juez_explicacion}</p>}
      <Ajustes a={v.ajustes} />
      <div className="tv-cols">
        <Columna titulo="ANTES" s={v.antes} media={media} onVer={onVer} tono="antes" />
        <Columna titulo="DESPUÉS" s={v.despues} media={media} onVer={onVer} tono="despues" />
      </div>
      {v.files_deleted_at && <p className="tv-detalle">Audio y fotogramas borrados (más de 90 días).</p>}
      {fallo && <p className="tv-error">{fallo}</p>}
      {v.descarte_revision === 'justo' ? (
        <p className="tv-line">
          Marcado como bien descartado.
          <button type="button" className="tv-link" disabled={enviando} onClick={() => decidir(null)}>Deshacer</button>
        </p>
      ) : v.antes && v.despues && (
        <footer className="tv-acc tv-acc-desc">
          <input className="tv-input tv-nota-desc" type="text" placeholder="Nota (opcional)" aria-label="Nota sobre el descarte" value={nota} onChange={e => setNota(e.target.value)} disabled={enviando} />
          <button type="button" className="tv-btn tv-pri" disabled={enviando} onClick={() => decidir('injusto')}>Descarte injusto</button>
          <button type="button" className="tv-btn tv-sec" disabled={enviando} onClick={() => decidir('justo')}>Bien descartado</button>
        </footer>
      )}
    </article>
  );
}

function Prueba({ estado, progreso, ocupado, onLanzar, onCancelar }: {
  estado: Estado; progreso: Progreso | null; ocupado: boolean; onLanzar: () => void; onCancelar: () => void;
}) {
  const p = estado.prueba;
  const linea = (r: ResumenPrueba) => `${r.descartados} de ${r.total} descartados (${pct(r.descartados, r.total)})`
    + `${r.aprobados ? ` · ${r.aprobados} aprobados` : ''}${r.errores ? ` · ${r.errores} con error` : ''}`;
  return (
    <details className="tv-sec-box">
      <summary>Prueba con los “No sirve” ({p.todas.total} de {p.objetivo})</summary>
      <p className="tv-line">Objetivo: que el verificador descarte al menos el 90 %.</p>
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
.tv { --verde: #1E9E3A; --amarillo: #FFC400; --fondo: #F7F7F5; --azul: #2563eb; --tinta: #111; --linea: #E6E7E2; --borde: #CFD0C9; --rojo: #C81E1E;
  font-family: var(--font-app); color: var(--tinta); }
.tv-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 12px; }
.tv-bar { margin: 0 0 18px; padding: 12px 14px; border-radius: 14px; background: var(--fondo); display: flex; flex-direction: column; gap: 10px; }
.tv-bar-acc { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tv-line { margin: 0; font-size: 14px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.tv-panel { display: flex; flex-direction: column; gap: 10px; }
.tv-panel .tv-btn { min-height: 40px; }
.tv-filtros { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: flex-end; }
.tv-campo { flex: 0 1 136px; display: flex; flex-direction: column; gap: 3px; font-size: 13px; font-weight: 600; color: var(--tinta); margin: 0; min-width: 0; }
.tv-campo.is-ancho { flex: 1 1 150px; }
.tv-campo.is-corto { flex: 0 1 84px; }
.tv-campo input, .tv-campo select { font-family: inherit; font-size: 14px; font-weight: 500; padding: 0 8px; min-height: 38px; border-radius: 8px; border: 1px solid var(--borde); background: #fff; color: var(--tinta); min-width: 0; width: 100%; box-sizing: border-box; }
.tv-campo input::placeholder { color: var(--tinta); opacity: .75; }
.tv-campo.is-mal input { border-color: var(--rojo); }
.tv-check { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; color: var(--tinta); margin: 0; min-height: 38px; white-space: nowrap; cursor: pointer; }
.tv-check input, .tv-radio input { flex: 0 0 auto; width: 16px; height: 16px; min-height: 0; margin: 0; padding: 0; }
.tv-fila { display: flex; align-items: center; justify-content: space-between; gap: 8px 14px; flex-wrap: wrap; }
.tv-fila > .tv-bar-acc:only-child { flex: 1; }
.tv-cuenta { flex: 1 1 240px; margin: 0; font-size: 14px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.tv-abierta { display: flex; align-items: center; gap: 10px 12px; flex-wrap: wrap; padding: 10px 12px; border-radius: 10px; background: rgba(255,196,0,0.14); font-size: 14px; }
.tv-abierta > span { flex: 1; min-width: 220px; }
.tv-ultima { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 14px; padding-top: 8px; border-top: 1px solid var(--linea); font-size: 14px; }
.tv-ultima-l { margin: 0; font-variant-numeric: tabular-nums; }
.tv-detalles > summary { cursor: pointer; font-size: 13.5px; font-weight: 600; min-height: 24px; }
.tv-detalles[open] { flex-basis: 100%; }
.tv-detalles-c { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; }
@media (max-width: 600px) {
  .tv-campo, .tv-campo.is-corto { flex: 1 1 calc(50% - 5px); }
  .tv-campo.is-ancho { flex: 1 1 100%; }
}
.tv-prog { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 600; }
.tv-prog-bar { height: 8px; border-radius: 999px; background: #E3E4DE; overflow: hidden; }
.tv-prog-bar > div { height: 100%; background: var(--verde); transition: width .3s; }
.tv-alarma { margin: 0 0 12px; padding: 12px 14px; border-radius: 12px; background: rgba(255,196,0,0.18); border: 1.5px solid var(--amarillo); font-size: 14px; font-weight: 700; color: #6b5200; }
.tv-error { margin: 0 0 12px; font-size: 13.5px; font-weight: 600; color: var(--rojo); }
.tv-aviso { margin: 0 0 12px; padding: 10px 14px; border-radius: 12px; background: rgba(30,158,58,0.08); font-size: 13.5px; color: #20562d; }
.tv-vacio { margin: 0; padding: 28px 16px; border-radius: 14px; background: var(--fondo); font-size: 15px; text-align: center; }
.tv-link { border: 0; background: none; padding: 0 0 0 8px; min-height: 0; font-family: inherit; font-size: inherit; font-weight: 700; color: var(--azul); cursor: pointer; text-decoration: underline; }

.tv-btn { min-height: 44px; padding: 0 18px; border-radius: 10px; font-family: inherit; font-size: 14.5px; font-weight: 700; cursor: pointer; }
.tv-btn:disabled { opacity: .5; cursor: default; }
.tv-pri { border: 0; background: var(--verde); color: #fff; }
.tv-pri:hover:not(:disabled) { background: #188531; }
.tv-sec { border: 1.5px solid var(--borde); background: #fff; color: var(--tinta); }
.tv-si { flex: 1 1 160px; max-width: 280px; border: 0; background: var(--verde); color: #fff; }
.tv-si:hover:not(:disabled) { background: #188531; }
.tv-no { flex: 1 1 160px; max-width: 280px; border: 1.5px solid var(--borde); background: #fff; color: var(--tinta); }
.tv-no:hover:not(:disabled) { border-color: var(--rojo); color: var(--rojo); }
.tv-no-conf { border: 0; background: var(--rojo); color: #fff; }

.tv-lista { display: grid; gap: 16px; }
.tv-lista-h { margin: 0; font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.tv-card { background: #fff; border: 1px solid var(--linea); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.tv-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.tv-col { background: var(--fondo); border-radius: 12px; padding: 12px 14px; border-top: 4px solid var(--amarillo); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.tv-col.is-despues { border-top-color: var(--verde); }
.tv-col-h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.tv-et { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #8a6a00; }
.tv-col.is-despues .tv-et { color: var(--verde); }
.tv-fecha { font-size: 14px; }
.tv-frames { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.tv-frame { padding: 0; border: 0; border-radius: 8px; overflow: hidden; background: #ddd; aspect-ratio: 16 / 9; cursor: zoom-in; min-height: 0; }
.tv-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tv-frame.is-vacio { display: block; }
.tv-frame.is-mini { width: 96px; flex: 0 0 auto; }
.tv-audio { width: 100%; height: 36px; }
.tv-texto { margin: 0; font-size: 15.5px; line-height: 1.5; }
.tv-med { margin: 0; font-size: 14px; font-variant-numeric: tabular-nums; }
.tv-fathom { font-size: 14px; font-weight: 700; color: var(--azul); text-decoration: none; }
.tv-fathom:hover { text-decoration: underline; }
.tv-pie { display: flex; flex-direction: column; gap: 8px; }
.tv-datos { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; font-size: 14.5px; }
.tv-alumno { font-size: 18px; font-weight: 700; }
.tv-juez { margin: 0; font-size: 14.5px; line-height: 1.5; display: flex; gap: 10px; align-items: baseline; }
.tv-nota { flex: 0 0 auto; min-width: 44px; padding: 2px 10px; border-radius: 999px; background: rgba(30,158,58,0.12); color: var(--verde); font-weight: 800; text-align: center; }
.tv-acc { display: flex; gap: 10px; flex-wrap: wrap; }
.tv-motivos { border: 1px solid var(--linea); border-radius: 12px; padding: 12px 14px; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.tv-motivos legend { font-size: 14px; font-weight: 700; padding: 0 4px; }
.tv-motivos-l { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px 12px; }
.tv-radio { display: flex; align-items: center; gap: 8px; font-size: 14.5px; font-weight: 500; color: var(--tinta); margin: 0; min-height: 32px; cursor: pointer; }
.tv-input { font-family: inherit; font-size: 14px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--linea); }

.tv-sec-box { margin-top: 14px; padding: 12px 14px; border-radius: 12px; background: var(--fondo); }
.tv-sec-box > summary { cursor: pointer; font-size: 14px; font-weight: 700; min-height: 32px; display: flex; align-items: center; }
.tv-sec-box > * + * { margin-top: 10px; }
.tv-rows { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 14px; }
.tv-rows a { color: var(--azul); font-weight: 600; }
.tv-motivo { font-weight: 700; color: var(--rojo); }
.tv-motivo-det { margin: 0; font-size: 14.5px; line-height: 1.5; }
.tv-detalle { margin: 0; font-size: 13.5px; line-height: 1.5; }
.tv-progreso { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; font-size: 14.5px; font-variant-numeric: tabular-nums; }
.tv-etiqueta { padding: 2px 10px; border-radius: 999px; background: rgba(255,196,0,0.22); color: #6b5200; font-size: 13px; font-weight: 700; }
.tv-grupo { background: #fff; border-radius: 10px; padding: 8px 12px; }
.tv-grupo > summary { cursor: pointer; font-size: 14.5px; font-weight: 700; min-height: 32px; display: flex; align-items: center; flex-wrap: wrap; gap: 0 6px; font-variant-numeric: tabular-nums; }
.tv-grupo-rev { font-weight: 500; }
.tv-grupo-c { display: grid; gap: 12px; padding: 10px 0 6px; }
.tv-grupo .tv-card { padding: 14px; border-color: var(--borde); }
.tv-acc-desc { align-items: center; }
.tv-acc-desc .tv-btn { min-height: 44px; }
.tv-nota-desc { flex: 1 1 200px; min-width: 0; min-height: 44px; box-sizing: border-box; }

.tv-lightbox { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out; }
.tv-lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }

@media (max-width: 900px) { .tv-cols { grid-template-columns: 1fr; } }
@media (max-width: 767px) { .tv-title { display: none; } .tv-card { padding: 14px; } }
`;
