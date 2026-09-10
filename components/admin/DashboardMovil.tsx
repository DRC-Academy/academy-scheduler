'use client';

// DASHBOARD EN EL TELÉFONO (por debajo de 768 px).
//
// No es la pantalla de escritorio apretada: está pensada para el pulgar, con
// una mano, en 360–430 px. El admin la abre varias veces al día para contestar
// UNA pregunta —"¿hay algo que tenga que resolver ahora?"— y, si no hay nada,
// ver en diez segundos cómo viene el mes.
//
// NO calcula nada. Recibe en `datos` los MISMOS números que la vista de
// escritorio arma en DashboardGeneral (una sola pasada por las finanzas, una
// sola carga de los extras); acá solo se decide cómo se ven. Si un número
// difiere entre el teléfono y el escritorio, el fallo está en DashboardGeneral.
//
// Reglas de la pantalla:
//   · Una columna. Los indicadores van en una fila deslizable (scroll-snap).
//   · Lo accionable primero: número grande, color de urgencia, botón "Ver".
//     Sin pendientes → "Todo al día".
//   · Cada sección es un <details> con el resumen en el encabezado, para leer
//     el estado sin abrirla. Abiertas: Requiere acción y Salud. El resto, no.
//   · Cuerpo ≥ 14 px, cifras secundarias 16 px, principales 32–36 px. Zonas
//     táctiles ≥ 44 px.
//   · Listas de cinco como máximo, con "Ver todos". Nunca tablas.
//   · Rojo SOLO para urgencia real.
//   · La barra de la app (logo, campana, menú) se conserva arriba: es la única
//     vía al resto de rutas y a "Salir". Abajo va una navegación fija con las
//     cuatro entradas que el admin usa desde el teléfono.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Settings, Users, Wallet, ChevronDown, ChevronRight, CircleCheck } from 'lucide-react';
import type { FilaProfesor, OperacionMes, DateRange } from '@/lib/dashboardMetrics';
import type { RiesgoResumen } from '@/lib/dashboardExtras';

// ─── Lo que recibe ───────────────────────────────────────────────────────────

export type TonoMovil = 'rojo' | 'aviso' | 'ok';

export interface AccionMovil {
  key: string;
  /** null = todavía cargando. */
  n: number | null;
  label: string;
  detalle: string;
  tono: 'rojo' | 'aviso';
  href?: string;
  /** Las colas que abren algo en la misma pantalla (Conflictos) en vez de navegar. */
  onClick?: () => void;
}

export interface DashboardDatos {
  ahora: Date;
  cargandoExtras: boolean;
  kpis: Array<{ label: string; valor: string; pie: string; barra?: number; color?: string }>;
  alumnos: { conClase: number; total: number };
  profesActivos: number;
  ocupacion: { pct: number; tono: 'ok' | 'aviso' | 'alerta' };
  acciones: AccionMovil[];
  riesgo: RiesgoResumen;
  urgentes: Array<{ alumno: string; profe: string; causa: string; dias: number | null }>;
  semana: DateRange;
  clasesSemana: number;
  programadas: number;
  op: OperacionMes;
  faltasProfe: number;
  /** null mientras cargan los extras. */
  bajasMes: number | null;
  filas: FilaProfesor[];
  finanzas: { total: number; pagable: number; aRevisar: number; retenido: number; pagados: number };
  totalProfes: number;
  emails: { pendientes: number; aTiempo: number; enRiesgo: number; fuera: number };
  /** Contador de la barra inferior (Finanzas). null mientras carga. */
  solicitudesRevision: number | null;
}

// ─── Piezas ──────────────────────────────────────────────────────────────────

const MAX_LISTA = 5;

const DOT: Record<TonoMovil, string> = { rojo: '#dc4a38', aviso: '#FFC400', ok: '#1E9E3A' };
const TONO = {
  rojo:  { fg: '#B42318', bg: 'rgba(220,74,56,0.08)', bd: 'rgba(220,74,56,0.30)' },
  aviso: { fg: '#8a6d00', bg: 'rgba(255,196,0,0.12)', bd: 'rgba(255,196,0,0.45)' },
} as const;

const eur = (n: number) => `${Math.round(n).toLocaleString('es-ES')} €`;

function fechaLarga(d: Date): string {
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Sección plegable. El encabezado lleva el punto de estado y un resumen de una
 * línea, para que la pantalla se lea entera sin abrir nada. `<details>` nativo:
 * accesible, sin JS, y el estado abierto/cerrado lo maneja el navegador.
 */
function Seccion({ id, titulo, resumen, tono, abierta = false, children }: {
  id: string; titulo: string; resumen: string; tono?: TonoMovil; abierta?: boolean; children: React.ReactNode;
}) {
  return (
    <details className="dpm-sec" open={abierta} id={id}>
      <summary className="dpm-sum">
        {tono && <span className="adm-dot dpm-sum-dot" style={{ background: DOT[tono] }} />}
        <span className="dpm-sum-body">
          <span className="dpm-sum-title">{titulo}</span>
          <span className="dpm-sum-res">{resumen}</span>
        </span>
        <ChevronDown className="dpm-chev" size={20} strokeWidth={2} aria-hidden />
      </summary>
      <div className="dpm-body">{children}</div>
    </details>
  );
}

/** Barra apilada de segmentos, sin tooltip: los números van en la lista de abajo. */
function Apilada({ partes }: { partes: Array<{ n: number; color: string }> }) {
  const total = partes.reduce((s, p) => s + p.n, 0);
  return (
    <div className="dpm-stack" aria-hidden>
      {partes.map((p, i) => (
        <div key={i} className="dpm-stack-seg" style={{ width: `${total > 0 ? (p.n / total) * 100 : 0}%`, background: p.color }} />
      ))}
    </div>
  );
}

/** Fila "etiqueta … número" con su barra debajo. Una sola línea de lectura. */
function FilaBarra({ label, valor, pct, color = '#1E9E3A' }: {
  label: React.ReactNode; valor: React.ReactNode; pct: number; color?: string;
}) {
  return (
    <div className="dpm-brow">
      <div className="dpm-brow-top">
        <span className="dpm-brow-label">{label}</span>
        <span className="dpm-brow-n">{valor}</span>
      </div>
      <div className="dpm-brow-track">
        <div className="dpm-brow-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

function BotonEnlace({ href, children, primario = false }: { href: string; children: React.ReactNode; primario?: boolean }) {
  return (
    <Link href={href} className={`dpm-btn${primario ? ' is-primary' : ''}`}>
      {children} <ChevronRight size={18} strokeWidth={2} aria-hidden />
    </Link>
  );
}

function Vacio({ children }: { children: React.ReactNode }) {
  return <div className="dpm-note" style={{ margin: 0, textAlign: 'center', padding: '10px 0' }}>{children}</div>;
}

// ─── 1 · Requiere acción hoy ─────────────────────────────────────────────────

function RequiereAccion({ acciones }: { acciones: AccionMovil[] }) {
  const [verTodas, setVerTodas] = useState(false);
  // Orden de urgencia: rojas, después avisos. Las colas en cero no se listan
  // (en el teléfono el sitio se lo lleva lo que sí espera); las que aún cargan
  // van al final, atenuadas, para que se sepa que falta un número.
  const conNumero = acciones.filter(a => a.n != null && a.n > 0)
    .sort((a, b) => (a.tono === b.tono ? 0 : a.tono === 'rojo' ? -1 : 1));
  const cargando = acciones.filter(a => a.n == null);
  const rojas = conNumero.filter(a => a.tono === 'rojo').length;
  const avisos = conNumero.length - rojas;
  const tono: TonoMovil = rojas ? 'rojo' : avisos ? 'aviso' : 'ok';
  const partes = [
    rojas && `${rojas} urgente${rojas > 1 ? 's' : ''}`,
    avisos && `${avisos} pendiente${avisos > 1 ? 's' : ''}`,
    cargando.length && 'cargando…',
  ].filter(Boolean);
  const resumen = partes.length ? partes.join(' · ') : 'Todo al día';
  const lista = [...conNumero, ...cargando];
  const visibles = verTodas ? lista : lista.slice(0, MAX_LISTA);
  const ocultas = lista.length - visibles.length;

  return (
    <Seccion id="accion" titulo="Requiere acción hoy" resumen={resumen} tono={tono} abierta>
      {lista.length === 0 ? (
        <div className="adm-card dpm-card dpm-vacio">
          <CircleCheck size={40} strokeWidth={1.75} color="#1E9E3A" aria-hidden />
          <div className="dpm-vacio-title">Todo al día</div>
          <div className="dpm-vacio-sub">No hay nada que resolver ahora mismo.</div>
        </div>
      ) : (
        <div className="dpm-acts">
          {visibles.map((a, i) => {
            const t = TONO[a.tono];
            const cargandoEsta = a.n == null;
            const inner = (
              <>
                <span className="dpm-act-n" style={{ color: cargandoEsta ? 'var(--text-muted)' : t.fg }}>{cargandoEsta ? '·' : a.n}</span>
                <span className="dpm-act-body">
                  <span className="dpm-act-label">{a.label}</span>
                  <span className="dpm-act-det">{cargandoEsta ? 'Cargando…' : a.detalle}</span>
                </span>
                <span className="dpm-act-btn" style={{ color: t.fg, borderColor: t.bd }}>
                  Ver <ChevronRight size={16} strokeWidth={2.25} aria-hidden />
                </span>
              </>
            );
            const cls = `dpm-act${i === 0 && !cargandoEsta ? ' is-first' : ''}`;
            const style = cargandoEsta
              ? { background: 'var(--bg-surface)', borderColor: 'var(--border)' }
              : { background: t.bg, borderColor: t.bd };
            return a.onClick
              ? <button key={a.key} type="button" className={cls} style={style} onClick={a.onClick}>{inner}</button>
              : <Link key={a.key} href={a.href ?? '#'} className={cls} style={style}>{inner}</Link>;
          })}
          {ocultas > 0 && (
            <button type="button" className="dpm-btn is-ghost" onClick={() => setVerTodas(true)}>
              Ver {ocultas === 1 ? 'la que falta' : `las ${ocultas} restantes`} <ChevronDown size={18} strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
      )}
    </Seccion>
  );
}

// ─── 2 · Salud del negocio ───────────────────────────────────────────────────

function SaludNegocio({ d }: { d: DashboardDatos }) {
  const tono: TonoMovil = d.ocupacion.tono === 'ok' ? 'ok' : d.ocupacion.tono === 'aviso' ? 'aviso' : 'rojo';
  return (
    <Seccion id="salud" titulo="Salud del negocio" tono={tono} abierta
      resumen={`${d.alumnos.conClase} con clase · ${d.profesActivos} profes activos · ocupación ${d.ocupacion.pct} %`}>
      {/* Fila deslizable: la tercera tarjeta asoma, que es la pista de que hay más. */}
      <div className="dpm-kpis">
        {d.kpis.map(k => (
          <div key={k.label} className="dpm-kpi">
            <div className="dpm-kpi-l">{k.label}</div>
            <div className="dpm-kpi-v">{k.valor}</div>
            {k.barra != null && (
              <div className="dpm-track" aria-hidden><div className="dpm-fill" style={{ width: `${k.barra}%`, background: k.color }} /></div>
            )}
            <div className="dpm-kpi-p">{k.pie}</div>
          </div>
        ))}
      </div>
    </Seccion>
  );
}

// ─── 3 · Riesgo de baja ──────────────────────────────────────────────────────

function Riesgo({ d }: { d: DashboardDatos }) {
  const { rojo, verde } = d.riesgo;
  const total = rojo + verde;
  const pct = total > 0 ? Math.round((rojo / total) * 100) : 0;
  // Umbral: a partir del 10 % de los analizados en rojo, la sección entera se
  // marca en rojo; con alguno en rojo pero menos del 10 %, aviso.
  const tono: TonoMovil = d.cargandoExtras ? 'ok' : pct >= 10 ? 'rojo' : rojo > 0 ? 'aviso' : 'ok';
  const resumen = d.cargandoExtras ? 'Cargando…' : total === 0 ? 'Sin clases analizadas' : `${rojo} en rojo · ${pct} % de los analizados`;

  return (
    <Seccion id="riesgo" titulo="Riesgo de baja" tono={tono} resumen={resumen}>
      <div className="adm-card dpm-card">
        {d.cargandoExtras ? <Vacio>Cargando…</Vacio> : total === 0 ? <Vacio>Todavía no hay clases analizadas.</Vacio> : (
          <>
            <div className="dpm-figure">
              <span className="dpm-big" style={{ color: '#B42318' }}>{rojo}</span>
              <span className="dpm-big-cap">alumnos con alerta abierta</span>
            </div>
            <Apilada partes={[{ n: verde, color: '#1E9E3A' }, { n: rojo, color: '#dc4a38' }]} />
            <ul className="dpm-list">
              <li className="dpm-row"><span className="adm-dot" style={{ background: '#1E9E3A' }} /><span className="dpm-row-label">Sin señales</span><span className="dpm-row-n">{verde}</span></li>
              <li className="dpm-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dpm-row-label">Con alerta</span><span className="dpm-row-n">{rojo}</span></li>
            </ul>
            <p className="dpm-note">La IA clasifica cada clase en verde o rojo. No hay nivel intermedio.</p>
          </>
        )}
      </div>

      <div className="adm-card dpm-card dpm-card-list">
        <div className="dpm-card-head">Los más urgentes</div>
        {d.cargandoExtras ? <Vacio>Cargando…</Vacio> : d.urgentes.length === 0 ? <Vacio>Ningún alumno en rojo.</Vacio> : (
          <ul className="dpm-people">
            {d.urgentes.slice(0, MAX_LISTA).map((u, i) => (
              <li key={`${u.alumno}-${i}`}>
                <Link href="/admin?tab=ai" className="dpm-person">
                  <span className="adm-dot" style={{ background: '#dc4a38' }} />
                  <span className="dpm-person-body">
                    <span className="dpm-person-name">{u.alumno}</span>
                    <span className="dpm-person-sub">{u.causa}</span>
                  </span>
                  <span className="dpm-person-meta">
                    <span>{u.profe}</span>
                    {u.dias != null && <span className="dpm-person-dias">hace {u.dias} d</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <BotonEnlace href="/admin?tab=ai">{rojo > 0 ? `Ver los ${rojo} en riesgo` : 'Abrir Riesgo'}</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 4 · Clases de la semana ─────────────────────────────────────────────────

function Clases({ d }: { d: DashboardDatos }) {
  const pct = d.programadas > 0 ? Math.round((d.clasesSemana / d.programadas) * 100) : 0;
  // Umbral: menos del 80 % dado es rojo; menos del 90 %, o cualquier falta sin
  // aviso en el mes, aviso.
  const tono: TonoMovil = d.programadas === 0 ? 'ok' : pct < 80 ? 'rojo' : (pct < 90 || d.op.faltasSinAviso > 0) ? 'aviso' : 'ok';

  return (
    <Seccion id="clases" titulo="Clases de la semana" tono={tono}
      resumen={`${d.clasesSemana} de ${d.programadas} dadas · ${d.op.faltasSinAviso} falta${d.op.faltasSinAviso === 1 ? '' : 's'} sin aviso`}>
      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Dadas esta semana</div>
        <div className="dpm-figure is-left">
          <span className="dpm-big">{d.clasesSemana}<span className="dpm-big-of"> / {d.programadas}</span></span>
        </div>
        <div className="dpm-track" aria-hidden><div className="dpm-fill" style={{ width: `${pct}%` }} /></div>
        <p className="dpm-note">{pct} % de lo que el calendario tiene previsto. Del {d.semana.from.slice(8)} al {d.semana.to.slice(8)}.</p>
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Del mes</div>
        <ul className="dpm-list">
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#1E9E3A' }} /><span className="dpm-row-label">Clases dadas</span><span className="dpm-row-n">{d.op.dadas}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dpm-row-label">Faltas del alumno sin aviso</span><span className="dpm-row-n">{d.op.faltasSinAviso}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dpm-row-label">Cancelaciones del profesor</span><span className="dpm-row-n">{d.faltasProfe}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#FFC400' }} /><span className="dpm-row-label">Pendientes de recuperar</span><span className="dpm-row-n">{d.op.recuperacionesPendientes}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#2563eb' }} /><span className="dpm-row-label">Recuperaciones dadas</span><span className="dpm-row-n">{d.op.recuperaciones}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: 'var(--text-muted)' }} /><span className="dpm-row-label">Bajas este mes</span><span className="dpm-row-n">{d.bajasMes ?? '·'}</span></li>
        </ul>
        <p className="dpm-note">Una falta sin aviso no cuenta como pendiente de recuperar: se le cobró al alumno.</p>
        <BotonEnlace href="/admin?tab=classlog">Registro de clases</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 5 · Finanzas del mes ────────────────────────────────────────────────────

function Finanzas({ d }: { d: DashboardDatos }) {
  const f = d.finanzas;
  const partes = [
    { label: 'Pagable',   n: f.pagable,  color: '#1E9E3A' },
    { label: 'A revisar', n: f.aRevisar, color: '#FFC400' },
    { label: 'Retenido',  n: f.retenido, color: '#C8C8C0' },
  ];
  const tono: TonoMovil = f.aRevisar > 0 ? 'aviso' : 'ok';

  return (
    <Seccion id="finanzas" titulo="Finanzas del mes" tono={tono}
      resumen={`${eur(f.total)} a pagar · ${eur(f.aRevisar)} a revisar`}>
      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Total a pagar</div>
        <div className="dpm-figure is-left"><span className="dpm-big">{eur(f.total)}</span></div>
        <p className="dpm-note">Incluye bonus y penalizaciones del mes.</p>
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">En qué estado está</div>
        <Apilada partes={partes} />
        <ul className="dpm-list">
          {partes.map(p => (
            <li key={p.label} className="dpm-row">
              <span className="adm-dot" style={{ background: p.color }} />
              <span className="dpm-row-label">{p.label}</span>
              <span className="dpm-row-n">{eur(p.n)}</span>
            </li>
          ))}
        </ul>
        <p className="dpm-note">«A revisar» son clases esperando validación: hasta que se resuelvan, el profesor no cobra.</p>
      </div>

      <div className="adm-card dpm-card">
        <FilaBarra label="Profesores pagados este mes" valor={<>{f.pagados} <span className="dpm-brow-unit">/ {d.totalProfes}</span></>}
          pct={d.totalProfes > 0 ? (f.pagados / d.totalProfes) * 100 : 0} />
        <BotonEnlace href="/finanzas" primario>Abrir finanzas</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 6 · Profesores ──────────────────────────────────────────────────────────

function Profesores({ d }: { d: DashboardDatos }) {
  const sinSubir = d.filas.reduce((s, f) => s + f.transcriptsPendientes, 0);
  const cupos = d.filas.reduce((s, f) => s + f.cuposLibres, 0);
  const max = Math.max(0, ...d.filas.map(f => f.clases));
  // Primero los que arrastran transcripts: es lo que el admin tiene que reclamar.
  const orden = [...d.filas].sort((a, b) => b.transcriptsPendientes - a.transcriptsPendientes || b.clases - a.clases).slice(0, MAX_LISTA);
  const usan = d.filas.filter(f => f.usaIA).length;
  const tono: TonoMovil = sinSubir > 0 ? 'aviso' : 'ok';

  return (
    <Seccion id="profesores" titulo="Profesores" tono={tono}
      resumen={`${sinSubir} transcript${sinSubir === 1 ? '' : 's'} sin subir · ${cupos} cupo${cupos === 1 ? '' : 's'} libre${cupos === 1 ? '' : 's'}`}>
      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Clases del mes</div>
        {orden.length === 0 ? <Vacio>Sin profesores.</Vacio> : (
          <div className="dpm-brows">
            {orden.map(f => (
              <FilaBarra key={f.teacherId} pct={max > 0 ? (f.clases / max) * 100 : 0} valor={f.clases}
                label={<>
                  {f.teacherName}
                  {f.transcriptsPendientes > 0 && <span className="dpm-tag is-warn">{f.transcriptsPendientes} sin subir</span>}
                  {f.cuposLibres > 0 && <span className="dpm-tag is-ok">{f.cuposLibres} libres</span>}
                </>} />
            ))}
          </div>
        )}
        <BotonEnlace href="/admin?tab=teachers">Ver los {d.filas.length} profesores</BotonEnlace>
      </div>

      <div className="adm-card dpm-card">
        {d.cargandoExtras ? <Vacio>Cargando…</Vacio> : (
          <FilaBarra label="Usan la IA para preparar clases" valor={<>{usan} <span className="dpm-brow-unit">/ {d.filas.length}</span></>}
            pct={d.filas.length > 0 ? (usan / d.filas.length) * 100 : 0} />
        )}
        <BotonEnlace href="/admin?tab=aiusage">Uso de la IA</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 7 · Emails de presentación ──────────────────────────────────────────────

function Emails({ d }: { d: DashboardDatos }) {
  const e = d.emails;
  const tono: TonoMovil = e.fuera > 0 ? 'rojo' : e.enRiesgo > 0 ? 'aviso' : 'ok';
  const filas = [
    { label: 'Pendientes a tiempo',    n: e.aTiempo,  dot: '#16a34a', filter: 'pending' },
    { label: 'En riesgo (más de 12 h)', n: e.enRiesgo, dot: '#e0912f', filter: 'at_risk' },
    { label: 'Fuera de tiempo (más de 24 h)', n: e.fuera, dot: '#dc4a38', filter: 'overdue' },
  ];
  return (
    <Seccion id="emails" titulo="Emails de presentación" tono={tono}
      resumen={`${e.pendientes} pendiente${e.pendientes === 1 ? '' : 's'} · ${e.fuera} fuera de tiempo`}>
      <div className="adm-card dpm-card dpm-card-list">
        <ul className="dpm-tools">
          {filas.map(f => (
            <li key={f.filter}>
              <Link href={`/admin?tab=emails&filter=${f.filter}`} className="dpm-tool">
                <span className="dpm-row-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <span className="adm-dot" style={{ background: f.dot }} />{f.label}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="dpm-row-n">{f.n}</span>
                  <ChevronRight size={18} strokeWidth={2} aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Seccion>
  );
}

// ─── Navegación inferior ─────────────────────────────────────────────────────

/**
 * Las cuatro entradas que el admin usa desde el teléfono. Inicio es esta misma
 * pantalla; Admin concentra la mayoría de las colas de "Requiere acción";
 * Alumnos es donde se busca a alguien cuando escribe o llama; Finanzas es la
 * única entrada de la barra de arriba que lleva contador (solicitudes de
 * revisión). Buscar (setter) y Próximos a cancelar siguen en el menú de arriba.
 */
const NAV = [
  { href: '/dashboard', label: 'Inicio',   Icon: LayoutDashboard },
  { href: '/admin',     label: 'Admin',    Icon: Settings },
  { href: '/students',  label: 'Alumnos',  Icon: Users },
  { href: '/finanzas',  label: 'Finanzas', Icon: Wallet },
];

function NavInferior({ revisiones }: { revisiones: number | null }) {
  const path = usePathname();
  return (
    <nav className="dpm-nav" aria-label="Navegación principal">
      {NAV.map(({ href, label, Icon }) => {
        const activo = path === href;
        const badge = href === '/finanzas' ? (revisiones ?? 0) : 0;
        return (
          <Link key={href} href={href} className={`dpm-nav-item${activo ? ' is-active' : ''}`} aria-current={activo ? 'page' : undefined}>
            <span className="dpm-nav-icon">
              <Icon size={22} strokeWidth={activo ? 2.25 : 1.75} aria-hidden />
              {badge > 0 && <span className="dpm-nav-badge">{badge}</span>}
            </span>
            <span className="dpm-nav-label">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function DashboardMovil({ datos }: { datos: DashboardDatos }) {
  return (
    <div className="dpm">
      <p className="dpm-fecha">{fechaLarga(datos.ahora)}</p>
      <div className="dpm-main">
        <RequiereAccion acciones={datos.acciones} />
        <SaludNegocio d={datos} />
        <Riesgo d={datos} />
        <Clases d={datos} />
        <Finanzas d={datos} />
        <Profesores d={datos} />
        <Emails d={datos} />
      </div>
      <NavInferior revisiones={datos.solicitudesRevision} />
      <style>{ESTILOS}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Estilos de la vista móvil, con prefijo `dpm-`. Mismos colores y tokens que la
// app; nada de esto toca otra pantalla. Tamaños: cuerpo 14 px, cifras
// secundarias 16 px, principales 32–36 px. Zonas táctiles ≥ 44 px.
// ─────────────────────────────────────────────────────────────────────────────

const ESTILOS = `
.dpm { font-size: 14px; line-height: 1.45; color: var(--text-primary); }
.dpm a { -webkit-tap-highlight-color: rgba(30,158,58,0.15); }
.dpm-fecha { margin: 0 0 10px 2px; font-size: 14px; font-weight: 600; color: var(--text-secondary); }
.dpm-main { display: flex; flex-direction: column; gap: 10px; }

/* ── Sección plegable ── */
.dpm-sec { background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; box-shadow: 0 1px 2px rgba(16,24,16,0.04); }
.dpm-sum { list-style: none; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 10px 14px 10px 16px; }
.dpm-sum::-webkit-details-marker { display: none; }
.dpm-sum-dot { width: 10px; height: 10px; }
.dpm-sum-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dpm-sum-title { font-size: 16px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; }
.dpm-sum-res { font-size: 14px; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dpm-chev { color: var(--text-muted); flex-shrink: 0; transition: transform 0.18s ease; }
.dpm-sec[open] > .dpm-sum .dpm-chev { transform: rotate(180deg); }
.dpm-sec[open] > .dpm-sum { border-bottom: 1px solid var(--border); }
.dpm-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--bg-base); border-radius: 0 0 14px 14px; }

/* ── Tarjetas dentro de la sección ── */
.dpm-card { padding: 14px; display: flex; flex-direction: column; }
.dpm-card-list { padding-bottom: 12px; }
.dpm-card-head { font-size: 14px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 10px; }
.dpm-note { margin: 10px 0 0; font-size: 14px; color: var(--text-muted); line-height: 1.45; }

/* ── Requiere acción ── */
.dpm-acts { display: flex; flex-direction: column; gap: 8px; }
.dpm-act { display: flex; align-items: center; gap: 12px; width: 100%; border: 1px solid; border-radius: 12px; padding: 12px 12px 12px 14px; min-height: 64px; text-decoration: none; color: inherit; text-align: left; font-family: inherit; cursor: pointer; }
.dpm-act:active { transform: scale(0.99); }
.dpm-act-n { font-size: 32px; font-weight: 700; line-height: 1; min-width: 44px; text-align: center; }
.dpm-act.is-first { min-height: 76px; }
.dpm-act.is-first .dpm-act-n { font-size: 36px; }
.dpm-act-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dpm-act-label { font-size: 15px; font-weight: 600; line-height: 1.3; color: var(--text-primary); }
.dpm-act-det { font-size: 14px; color: var(--text-secondary); }
.dpm-act-btn { display: inline-flex; align-items: center; justify-content: center; gap: 2px; flex-shrink: 0; min-height: 44px; min-width: 64px; padding: 0 10px 0 14px; background: #fff; border: 1px solid; border-radius: 10px; font-size: 15px; font-weight: 700; }
.dpm-vacio { align-items: center; text-align: center; padding: 26px 16px 24px; gap: 6px; }
.dpm-vacio-title { font-size: 22px; font-weight: 700; margin-top: 4px; }
.dpm-vacio-sub { font-size: 14px; color: var(--text-muted); }

/* ── Botones ── */
.dpm-btn { display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 48px; margin-top: 12px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--border-light); background: #fff; font-family: inherit; font-size: 15px; font-weight: 600; color: var(--accent); text-decoration: none; cursor: pointer; }
.dpm-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.dpm-btn.is-ghost { margin-top: 2px; border-color: transparent; background: transparent; }
.dpm-btn:active { opacity: 0.85; }

/* ── Indicadores en fila deslizable ── */
.dpm-kpis { display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory; margin: 0 -12px; padding: 0 12px 4px; scroll-padding-left: 12px; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.dpm-kpis::-webkit-scrollbar { display: none; }
/* Dos tarjetas y un tercio de la siguiente asomando, en cualquier ancho. */
.dpm-kpi { flex: 0 0 calc(50% - 22px); scroll-snap-align: start; background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; padding: 12px 14px 13px; }
.dpm-kpi-l { font-size: 13px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-muted); line-height: 1.25; }
.dpm-kpi-v { font-size: 28px; font-weight: 700; line-height: 1.15; margin-top: 6px; }
.dpm-kpi-p { font-size: 14px; color: var(--text-muted); margin-top: 4px; }

.dpm-track { height: 8px; border-radius: 4px; background: var(--bg-surface-3); overflow: hidden; margin-top: 8px; }
.dpm-fill { height: 100%; background: #1E9E3A; border-radius: 4px; }

/* ── Listas ── */
.dpm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-row { display: flex; align-items: center; gap: 10px; min-height: 36px; font-size: 14px; }
.dpm-row-label { color: var(--text-secondary); flex: 1; min-width: 0; }
.dpm-row-n { font-size: 16px; font-weight: 700; min-width: 40px; text-align: right; }

/* ── Barra apilada ── */
.dpm-stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; gap: 2px; margin-bottom: 8px; }
.dpm-stack-seg { height: 100%; }

/* ── Fila con barra debajo ── */
.dpm-brows { display: flex; flex-direction: column; gap: 10px; }
.dpm-brow { display: flex; flex-direction: column; gap: 5px; }
.dpm-brow-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 14px; }
.dpm-brow-label { color: var(--text-secondary); display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.dpm-brow-n { font-size: 16px; font-weight: 700; white-space: nowrap; }
.dpm-brow-unit { font-size: 14px; font-weight: 500; color: var(--text-muted); }
.dpm-brow-track { height: 10px; border-radius: 5px; background: var(--bg-surface-3); overflow: hidden; }
.dpm-brow-fill { height: 100%; border-radius: 5px; }
.dpm-tag { font-size: 13px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.dpm-tag.is-ok { background: rgba(22,122,45,0.10); color: #167A2D; }
.dpm-tag.is-warn { background: rgba(255,196,0,0.22); color: #8a6d00; }

/* ── Cifras grandes ── */
.dpm-figure { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2px; padding: 4px 0 10px; }
.dpm-figure.is-left { align-items: flex-start; text-align: left; padding: 0 0 4px; }
.dpm-big { font-size: 34px; font-weight: 700; line-height: 1.1; }
.dpm-big-of { font-size: 18px; font-weight: 500; color: var(--text-muted); }
.dpm-big-cap { font-size: 14px; color: var(--text-muted); }

/* ── Personas (riesgo) ── */
.dpm-people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-person { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 0; border-top: 1px solid var(--border); text-decoration: none; color: inherit; }
.dpm-people li:first-child .dpm-person { border-top: 0; }
.dpm-person-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dpm-person-name { font-size: 15px; font-weight: 600; }
.dpm-person-sub { font-size: 14px; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dpm-person-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 14px; color: var(--text-secondary); white-space: nowrap; }
.dpm-person-dias { color: var(--text-muted); }

/* ── Filas con flecha (emails) ── */
.dpm-tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-tool { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 48px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 15px; color: var(--text-primary); text-decoration: none; }
.dpm-tools li:first-child .dpm-tool { border-top: 0; }
.dpm-tool svg { color: var(--text-muted); flex-shrink: 0; }

/* ── Navegación inferior fija, respetando la zona segura del iPhone ── */
.dpm-nav { position: fixed; bottom: 0; left: 0; right: 0; z-index: 39; display: grid; grid-template-columns: repeat(4, 1fr); height: calc(64px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); background: #fff; border-top: 1px solid var(--border); }
.dpm-nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 44px; text-decoration: none; color: var(--text-muted); }
.dpm-nav-item.is-active { color: var(--accent); }
.dpm-nav-icon { position: relative; display: inline-flex; }
.dpm-nav-badge { position: absolute; top: -6px; right: -12px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #FFC400; color: #3d3000; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.dpm-nav-label { font-size: 12px; font-weight: 600; letter-spacing: 0.01em; }
`;
