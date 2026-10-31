'use client';

// Pestaña admin "Testimoniales": PANEL DE ANÁLISIS + VERIFICADOR.
//
// El admin elige qué se analiza (fechas, alumno, profe, cuántas parejas, cuántas
// por alumno, fuente, solo lo nunca analizado) y ve ANTES de gastar cuántas
// clases, alumnos y parejas salen y cuánto costaría (lib/testimonialAnalysis).
// "Analizar" abre una tanda guardada en Supabase: si es con la escucha, primero
// escucha las clases que falten; después verifica las parejas, 3 alumnos a la vez
// y una llamada al servidor por pareja. "Pausar" para y la tanda queda guardada;
// "Reanudar" (también tras cerrar la pestaña) sigue donde quedó sin repetir nada.
//
// Las aprobadas salen todas, de mejor a peor nota, con fotogramas, audio recortado
// y medidas. "No sirve" pide motivo: alimenta el banco de ejemplos y puede
// endurecer un umbral (que se puede deshacer).
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
  consentimiento: 'sin_pedir' | 'pedido' | 'dado'; review: string | null; review_motivo: string | null;
  created_at: string; updated_at: string; files_deleted_at: string | null; ajustes: Record<string, string> | null;
}
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
}
interface Estado {
  tarjetas: Verif[]; media: Record<string, string>; aprobadasPendientes: number; sirven: Verif[]; descartados: Verif[];
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
}
interface ResumenTanda { revisados: number; aprobados: number; porMotivo: Record<string, number>; costeDeepgram: number; costeClaude: number }
interface Recuento {
  clases: number; porEscuchar: number; alumnos: number; parejas: number; parejasMinimo: boolean; aVerificar: number;
  coste: { escucha: number; verificacion: number; total: number; porPareja: number };
}
interface ItemResultado { status: 'hecha' | 'saltada' | 'error'; motivo: string | null; resultado: { status: string } | null; fin: boolean }
interface Opcion { id: string; name: string }

const API = '/api/admin/testimonial-verify';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MESES[m - 1]} ${y}`;
};
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');
const CONSENT_LABEL = { sin_pedir: 'Sin pedir', pedido: 'Pedido', dado: 'Dado' } as const;
const usd = (x: number) => `${x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const n = (x: number) => x.toLocaleString('es-ES');
const gasto = (t: { costeDeepgram: number; costeClaude: number }) =>
  `${usd(t.costeDeepgram + t.costeClaude)} (Deepgram ${usd(t.costeDeepgram)} + Claude ${usd(t.costeClaude)})`;
const CANTIDADES = ['50', '200', '500', '1000', 'todas'] as const;
const POR_ALUMNO = [1, 5, 10, 20] as const;
const TARJETAS_PAGINA = 20;
const AJUSTE_LADO = { antes: 'Antes', despues: 'Después' } as const;

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
        saltadas: t.parejas.saltadas, errores: t.parejas.errores, pausando: false,
      };
      const pintar = () => { if (vivo.current) setAnalisis({ ...p }); };
      pintar();

      if (t.fase === 'escuchar') {
        const cola = [...t.escuchar.pendientes];
        let cortado = false;
        const trabajador = async () => {
          for (let i = cola.shift(); i != null; i = cola.shift()) {
            if (pausar.current || !vivo.current) { cortado = true; return; }
            try { await post('analisis-escuchar', { batchId, idx: i }); seguidos = 0; } catch (e) { p.errores++; fallo(e); }
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

      // Parejas: cada trabajador coge un alumno y prueba sus parejas en orden hasta aprobar una.
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
              // Con una aprobada, el alumno ya está: sus otras parejas no se prueban.
              otroAlumno = r.resultado?.status === 'aprobado' || r.motivo === 'alumno_aprobado';
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
          ? 'No había parejas que verificar con esos filtros (todo lo posible ya se probó o está vetado).'
          : `Tanda terminada: ${res.aprobados} aprobadas de ${res.revisados} verificadas`
            + `${Object.keys(res.porMotivo).length ? ` · descartes: ${motivosFrase(res.porMotivo)}` : ''}. Gasto estimado: ${gasto(res)}.`);
      }
    } catch (e) {
      if (e instanceof Pausa) {
        await post('analisis-pausar', { batchId, pausada: true }).catch(() => {});
        if (vivo.current && !parado) setAviso('Tanda en pausa. Está guardada: pulsa “Reanudar” cuando quieras (también otro día).');
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

  const terminar = useCallback(async (batchId: string) => {
    try {
      const r = await post<{ resumen: ResumenTanda }>('cerrar', { batchId, cancelado: true });
      setAviso(`Tanda terminada a mano: ${r.resumen.aprobados} aprobadas de ${r.resumen.revisados} verificadas. Gasto estimado: ${gasto(r.resumen)}.`);
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
  const ocupado = !!progreso || !!analisis;

  return (
    <div className="tv">
      <h2 className="tv-title">Testimoniales</h2>

      <section className="tv-bar">
        {estado && (
          <PanelAnalisis post={post} analisis={analisis} abierta={analisis ? null : estado.abierta} ocupado={ocupado}
            onAnalizar={analizar} onReanudar={correr} onTerminar={terminar}
            onPausar={() => { pausar.current = true; setAnalisis(a => (a ? { ...a, pausando: true } : a)); }} />
        )}

        {ultima && (
          <p className="tv-line">
            <b>Última tanda</b> ({fecha(ultima.startedAt)}{ultima.cancelled ? ', terminada a mano' : ''}{!ultima.finishedAt ? ', en pausa' : ''}): {n(ultima.revisados)} verificadas,
            {' '}{ultima.aprobados} aprobadas{ultima.errores ? `, ${ultima.errores} con error` : ''}
            {Object.keys(ultima.porMotivo).length > 0 && <> · descartes: {motivosFrase(ultima.porMotivo)}</>}
            {ultima.costeDeepgram + ultima.costeClaude > 0 && <> · gasto estimado: {gasto(ultima)}</>}.
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
        {estado?.gasto && (
          <p className="tv-line">
            <b>Deepgram:</b> {usd(estado.gasto.usd)} gastados (estimado: escucha {n(estado.gasto.minutos.escucha)} min, verificador {n(estado.gasto.minutos.verificador)} min)
            {' '}· quedan ≈ <b>{usd(estado.gasto.queda)}</b> de {usd(estado.gasto.credito)}.
          </p>
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

      {!estado ? (
        !error && <p className="tv-vacio">Cargando…</p>
      ) : estado.tarjetas.length === 0 ? (
        <p className="tv-vacio">No hay parejas aprobadas por revisar. Elige los filtros y pulsa “Analizar”.</p>
      ) : (
        <Aprobadas estado={estado} post={post} onVer={setGrande} onRevisar={revisar} onConsentimiento={consentimiento} />
      )}

      {estado && (
        <>
          <Sirven lista={estado.sirven} onConsentimiento={consentimiento} />
          <Descartados lista={estado.descartados} post={post} onVer={setGrande} />
          <Umbrales estado={estado} onDeshacer={deshacer} />
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

function PanelAnalisis({ post, analisis, abierta, ocupado, onAnalizar, onReanudar, onTerminar, onPausar }: {
  post: <T>(a: string, e?: Record<string, unknown>) => Promise<T>;
  analisis: Analisis | null; abierta: TandaEstado | null; ocupado: boolean;
  onAnalizar: (opciones: Record<string, unknown>) => void; onReanudar: (batchId: string) => void;
  onTerminar: (batchId: string) => void; onPausar: () => void;
}) {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [alumnoTxt, setAlumnoTxt] = useState('');
  const [profeTxt, setProfeTxt] = useState('');
  const [cantidad, setCantidad] = useState<typeof CANTIDADES[number]>('200');
  const [porAlumno, setPorAlumno] = useState<number>(10);
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
    cantidad: cantidad === 'todas' ? null : Number(cantidad), porAlumno, fuente, soloNuevas,
  }), [desde, hasta, alumno, profe, cantidad, porAlumno, fuente, soloNuevas]);

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
        <label className="tv-campo">Parejas en esta tanda
          <select value={cantidad} onChange={e => setCantidad(e.target.value as typeof CANTIDADES[number])} disabled={ocupado}>
            {CANTIDADES.map(c => <option key={c} value={c}>{c === 'todas' ? 'Todas las que cumplan los filtros' : n(Number(c))}</option>)}
          </select>
        </label>
        <label className="tv-campo">Parejas por alumno
          <select value={porAlumno} onChange={e => setPorAlumno(Number(e.target.value))} disabled={ocupado}>
            {POR_ALUMNO.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="tv-campo">Fuente
          <select value={fuente} onChange={e => setFuente(e.target.value as Fuente)} disabled={ocupado}>
            <option value="escucha">Escucha (audio)</option>
            <option value="texto">Texto de Fathom (antiguo)</option>
          </select>
        </label>
        <label className="tv-check">
          <input type="checkbox" checked={soloNuevas} onChange={e => setSoloNuevas(e.target.checked)} disabled={ocupado} /> Solo lo que nunca se analizó
        </label>
      </div>

      <p className="tv-cuenta" aria-live="polite">
        {alumnoMal || profeMal ? `Elige ${alumnoMal ? 'el alumno' : 'el profe'} de la lista.`
          : errCuenta ? <span className="tv-error">{errCuenta}</span>
          : !cuenta ? 'Calculando…'
          : <>
              <b>Con estos filtros:</b> {n(cuenta.clases)} clases{cuenta.porEscuchar ? ` (${n(cuenta.porEscuchar)} por escuchar)` : ''} · {n(cuenta.alumnos)} alumnos
              {' '}· {cuenta.parejasMinimo ? 'al menos ' : ''}{n(cuenta.parejas)} parejas posibles{cuenta.parejasMinimo ? ' (salen más al escuchar)' : ''}
              {' '}· coste estimado <b>{usd(cuenta.coste.total)}</b>
              <span className="tv-detalle"> ({cuenta.coste.escucha > 0 ? `escuchar ${usd(cuenta.coste.escucha)} + ` : ''}verificar {n(cuenta.aVerificar)} parejas × {usd(cuenta.coste.porPareja)})</span>
              {contando && <span className="tv-detalle"> · recalculando…</span>}
            </>}
      </p>

      <div className="tv-bar-acc">
        {a ? (
          <>
            <div className="tv-prog" role="status">
              <span>
                {a.fase === 'escuchar'
                  ? `Escuchando clases: ${n(a.escHechas)} de ${n(a.escTotal)}…`
                  : `Verificando: ${n(a.hechas)} de ${n(a.total)} parejas · ${n(a.aprobadas)} aprobadas`
                    + `${a.saltadas ? ` · ${n(a.saltadas)} saltadas` : ''}${a.errores ? ` · ${n(a.errores)} con error` : ''}`}
                {a.pausando && ' · pausando (acaban las que están en curso)…'}
              </span>
              <div className="tv-prog-bar">
                <div style={{ width: `${a.fase === 'escuchar' ? (a.escTotal ? (a.escHechas / a.escTotal) * 100 : 0) : (a.total ? Math.min(100, (a.hechas / a.total) * 100) : 0)}%` }} />
              </div>
            </div>
            <button type="button" className="tv-btn tv-sec" disabled={a.pausando} onClick={onPausar}>Pausar</button>
          </>
        ) : (
          <button type="button" className="tv-btn tv-pri" disabled={ocupado || !cuenta || alumnoMal || profeMal || !!abierta}
            onClick={() => onAnalizar(elegidas)}>
            Analizar
          </button>
        )}
      </div>

      {abierta && !a && (
        <div className="tv-abierta">
          <span>
            <b>Tanda en pausa</b> ({abierta.fuente === 'escucha' ? 'escucha' : 'texto de Fathom'}):{' '}
            {abierta.fase === 'escuchar'
              ? `${n(abierta.escuchar.hechas)} de ${n(abierta.escuchar.total)} clases escuchadas`
              : `${n(abierta.parejas.hechas)} de ${n(abierta.objetivo ?? abierta.parejas.total)} parejas verificadas, ${n(abierta.parejas.aprobadas)} aprobadas`}
            {' '}· gastado {gasto(abierta.resumen)}.
          </span>
          <button type="button" className="tv-btn tv-pri" disabled={ocupado} onClick={() => onReanudar(abierta.batchId)}>Reanudar</button>
          <button type="button" className="tv-btn tv-sec" disabled={ocupado} onClick={() => onTerminar(abierta.batchId)}>Terminarla</button>
        </div>
      )}
    </div>
  );
}

// ── Aprobadas (todas, de mejor a peor nota) ──────────────────────────────────

function Aprobadas({ estado, post, onVer, onRevisar, onConsentimiento }: {
  estado: Estado; post: <T>(a: string, e?: Record<string, unknown>) => Promise<T>; onVer: (u: string) => void;
  onRevisar: (id: string, r: 'sirve' | 'no_sirve', m?: Motivo, t?: string) => Promise<void>;
  onConsentimiento: (id: string, valor: string) => void;
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
      <p className="tv-line"><b>{n(estado.aprobadasPendientes)} aprobadas por revisar</b>, de mejor a peor nota del juez.</p>
      {lista.map(v => (
        <Tarjeta key={v.id} v={v} media={media} onVer={onVer} onRevisar={onRevisar} onConsentimiento={onConsentimiento} />
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
        <Ajustes a={v.ajustes} />
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
                <Ajustes a={v.ajustes} />
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
.tv-panel { display: flex; flex-direction: column; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--linea); }
.tv-filtros { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px 12px; align-items: end; }
.tv-campo { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; font-weight: 700; color: #4A4A4A; min-width: 0; }
.tv-campo.is-ancho { grid-column: span 2; }
.tv-campo input, .tv-campo select { font-family: inherit; font-size: 14px; font-weight: 500; padding: 0 10px; min-height: 40px; border-radius: 8px; border: 1px solid var(--linea); background: #fff; color: var(--tinta); min-width: 0; width: 100%; box-sizing: border-box; }
.tv-campo.is-mal input { border-color: var(--rojo); }
.tv-check { display: flex; align-items: center; gap: 8px; font-size: 14px; min-height: 40px; cursor: pointer; }
.tv-cuenta { margin: 0; font-size: 14px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.tv-abierta { display: flex; align-items: center; gap: 10px 12px; flex-wrap: wrap; padding: 10px 12px; border-radius: 10px; background: rgba(255,196,0,0.14); font-size: 13.5px; }
.tv-abierta > span { flex: 1; min-width: 220px; }
@media (max-width: 600px) { .tv-campo.is-ancho { grid-column: auto; } }
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
