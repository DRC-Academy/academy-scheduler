'use client';

// VISTA MÓVIL de la maqueta del dashboard (por debajo de 768 px).
//
// No es la pantalla de escritorio apretada: está pensada para el pulgar, con
// una mano, en 360–430 px. El admin la abre varias veces al día para contestar
// UNA pregunta —"¿hay algo que tenga que resolver ahora?"— y, si no hay nada,
// ver en diez segundos cómo viene el mes.
//
// Reglas que gobiernan esta pantalla:
//   · Una columna. Los KPI van en una fila deslizable (scroll-snap), nunca en
//     rejilla.
//   · Lo accionable primero: número grande, color de urgencia, botón "Ver".
//     Sin pendientes → "Todo al día".
//   · Cada sección es un <details> con el resumen en el encabezado, para leer
//     el estado sin abrirla. Abiertas: Requiere acción y Salud. El resto, no.
//   · Cuerpo ≥ 14 px, cifras secundarias 16 px, principales 32–36 px. Zonas
//     táctiles ≥ 44 px.
//   · Gráficos que se entienden sin hover: barras, semáforos, seis puntos.
//   · Listas de 5 como máximo, con "Ver todos". Nunca tablas.
//   · Rojo SOLO para urgencia real. Las bajas del gráfico de movimiento van en
//     gris por eso mismo: una baja no es una emergencia del admin.
//
// Los datos son los MISMOS de ./datos-ejemplo.ts que usa la vista de
// escritorio. Nada sale de la base. Los enlaces sí son reales.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Settings, Users, Wallet, ChevronDown, ChevronRight, CircleCheck } from 'lucide-react';
import {
  HOY, RESUMEN, ACCIONES, SUSCRIPCIONES, MOVIMIENTO, EMBUDO_NIVEL, RIESGO,
  OPERACION, PROFESORES, IA, FINANZAS, HERRAMIENTAS, TONO, eur, fechaCorta,
  type Tono,
} from './datos-ejemplo';

const MAX_LISTA = 5;

// ─── Piezas ──────────────────────────────────────────────────────────────────

/**
 * Sección plegable. El encabezado lleva el punto de estado y un resumen de una
 * línea, para que la pantalla se lea entera sin abrir nada. `<details>` nativo:
 * accesible, sin JS, y el estado abierto/cerrado lo maneja el navegador.
 */
function Seccion({ id, titulo, resumen, tono, abierta = false, children }: {
  id: string; titulo: string; resumen: string; tono?: Tono; abierta?: boolean; children: React.ReactNode;
}) {
  return (
    <details className="dpm-sec" open={abierta} id={id}>
      <summary className="dpm-sum">
        {tono && <span className="adm-dot dpm-sum-dot" style={{ background: TONO[tono].dot }} />}
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
        <div key={i} className="dpm-stack-seg" style={{ width: `${(p.n / total) * 100}%`, background: p.color }} />
      ))}
    </div>
  );
}

/** Fila "etiqueta … número" con su barra debajo. Una sola línea de lectura. */
function FilaBarra({ label, valor, pct, color = '#1E9E3A', track, sub }: {
  label: React.ReactNode; valor: React.ReactNode; pct: number; color?: string; track?: string; sub?: React.ReactNode;
}) {
  return (
    <div className="dpm-brow">
      <div className="dpm-brow-top">
        <span className="dpm-brow-label">{label}</span>
        <span className="dpm-brow-n">{valor}</span>
      </div>
      <div className="dpm-brow-track" style={{ background: track }}>
        <div className="dpm-brow-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
      </div>
      {sub && <div className="dpm-brow-sub">{sub}</div>}
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

// ─── 1 · Requiere acción hoy ─────────────────────────────────────────────────

function RequiereAccion({ simularVacio, onSimular }: { simularVacio: boolean; onSimular: () => void }) {
  const [verTodas, setVerTodas] = useState(false);
  // Orden de urgencia: rojas, después amarillas. Las colas en cero no se listan:
  // una cola vacía no es una noticia, y el sitio se lo lleva lo que sí espera.
  const pendientes = simularVacio ? [] : ACCIONES.filter(a => a.n > 0)
    .sort((a, b) => (a.tono === b.tono ? 0 : a.tono === 'rojo' ? -1 : 1));
  const rojas = pendientes.filter(a => a.tono === 'rojo').length;
  const amarillas = pendientes.length - rojas;
  const tono: Tono = rojas ? 'rojo' : amarillas ? 'amarillo' : 'ok';
  const resumen = pendientes.length === 0
    ? 'Todo al día'
    : [rojas && `${rojas} urgente${rojas > 1 ? 's' : ''}`, amarillas && `${amarillas} pendiente${amarillas > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  const visibles = verTodas ? pendientes : pendientes.slice(0, MAX_LISTA);
  const ocultas = pendientes.length - visibles.length;

  return (
    <Seccion id="accion" titulo="Requiere acción hoy" resumen={resumen} tono={tono} abierta>
      {pendientes.length === 0 ? (
        <div className="adm-card dpm-card dpm-vacio">
          <CircleCheck size={40} strokeWidth={1.75} color="#1E9E3A" aria-hidden />
          <div className="dpm-vacio-title">Todo al día</div>
          <div className="dpm-vacio-sub">No hay nada que resolver ahora mismo.</div>
        </div>
      ) : (
        <div className="dpm-acts">
          {visibles.map((a, i) => {
            const t = TONO[a.tono];
            return (
              <Link key={a.label} href={a.href} className={`dpm-act${i === 0 ? ' is-first' : ''}`}
                style={{ background: t.bg, borderColor: t.bd }}>
                <span className="dpm-act-n" style={{ color: t.fg }}>{a.n}</span>
                <span className="dpm-act-body">
                  <span className="dpm-act-label">{a.label}</span>
                  <span className="dpm-act-det">{a.detalle}</span>
                </span>
                <span className="dpm-act-btn" style={{ color: t.fg, borderColor: t.bd }}>
                  Ver <ChevronRight size={16} strokeWidth={2.25} aria-hidden />
                </span>
              </Link>
            );
          })}
          {ocultas > 0 && (
            <button type="button" className="dpm-btn is-ghost" onClick={() => setVerTodas(true)}>
              Ver {ocultas === 1 ? 'la que falta' : `las ${ocultas} restantes`} <ChevronDown size={18} strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
      )}
      {/* Control SOLO de la maqueta: para ver los dos estados sin tocar datos. */}
      <button type="button" className="dpm-mock" onClick={onSimular}>
        {simularVacio ? 'Volver a los datos de ejemplo' : 'Ver cómo queda sin pendientes'} <span>· solo maqueta</span>
      </button>
    </Seccion>
  );
}

// ─── 2 · Salud del negocio ───────────────────────────────────────────────────

function SaludNegocio() {
  const deltaCoste = RESUMEN.costeProfesoresMes - RESUMEN.costeProfesoresMesAnterior;
  const kpis = [
    { label: 'Alumnos activos',    valor: String(RESUMEN.alumnosActivos),   pie: `de ${RESUMEN.alumnosTotales} en la base` },
    { label: 'Profesores activos', valor: String(RESUMEN.profesoresActivos), pie: `de ${RESUMEN.profesoresTotales}` },
    { label: 'Clases esta semana', valor: String(RESUMEN.clasesSemana),      pie: `${RESUMEN.clasesSemanaProgramadas} programadas` },
    { label: 'Coste profesores',   valor: eur(RESUMEN.costeProfesoresMes),   pie: `${deltaCoste >= 0 ? '+' : ''}${eur(deltaCoste)} vs. mes anterior` },
    { label: 'Ocupación',          valor: `${RESUMEN.ocupacion} %`,          pie: 'clases sobre cupos', barra: RESUMEN.ocupacion },
  ];
  const mesActual = MOVIMIENTO[MOVIMIENTO.length - 1];
  const neto = mesActual.altas - mesActual.bajas;
  const maxMov = Math.max(...MOVIMIENTO.flatMap(m => [m.altas, m.bajas]));
  const maxEstado = Math.max(...SUSCRIPCIONES.porEstado.map(s => s.n));
  const maxEmbudo = EMBUDO_NIVEL[0].n;
  const totalOrigen = SUSCRIPCIONES.porOrigen.reduce((s, o) => s + o.n, 0);

  return (
    <Seccion id="salud" titulo="Salud del negocio" tono={neto < 0 ? 'amarillo' : 'ok'} abierta
      resumen={`${RESUMEN.alumnosActivos} activos · ${neto >= 0 ? '+' : ''}${neto} en ${mesActual.mes.toLowerCase()}`}>

      {/* KPI en fila deslizable: se ve la tercera tarjeta asomando, que es la pista de que hay más. */}
      <div className="dpm-kpis">
        {kpis.map(k => (
          <div key={k.label} className="dpm-kpi">
            <div className="dpm-kpi-l">{k.label}</div>
            <div className="dpm-kpi-v">{k.valor}</div>
            {k.barra != null && (
              <div className="dpm-track" aria-hidden><div className="dpm-fill" style={{ width: `${k.barra}%` }} /></div>
            )}
            <div className="dpm-kpi-p">{k.pie}</div>
          </div>
        ))}
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Activos por origen</div>
        <Apilada partes={SUSCRIPCIONES.porOrigen} />
        <ul className="dpm-list">
          {SUSCRIPCIONES.porOrigen.map(o => (
            <li key={o.origen} className="dpm-row">
              <span className="adm-dot" style={{ background: o.color }} />
              <span className="dpm-row-label">{o.origen}</span>
              <span className="dpm-row-pct">{Math.round((o.n / totalOrigen) * 100)} %</span>
              <span className="dpm-row-n">{o.n}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Suscripciones por estado</div>
        <div className="dpm-brows">
          {SUSCRIPCIONES.porEstado.map(s => (
            <FilaBarra key={s.estado}
              label={<><span className="adm-dot" style={{ background: s.acceso ? '#1E9E3A' : '#C8C8C0' }} /> {s.label}</>}
              valor={s.n} pct={(s.n / maxEstado) * 100} color={s.acceso ? '#1E9E3A' : '#C8C8C0'} />
          ))}
        </div>
        <p className="dpm-note">El punto verde marca los estados que dan acceso a clase.</p>
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Altas y bajas · 6 meses</div>
        <div className="dpm-months">
          {MOVIMIENTO.map(m => {
            const n = m.altas - m.bajas;
            return (
              <div key={m.mes} className="dpm-month">
                <div className="dpm-month-bars">
                  <div className="dpm-bar" style={{ height: `${(m.altas / maxMov) * 100}%`, background: '#1E9E3A' }} />
                  <div className="dpm-bar" style={{ height: `${(m.bajas / maxMov) * 100}%`, background: '#C8C8C0' }} />
                </div>
                <div className="dpm-month-l">{m.mes}</div>
                <div className="dpm-month-net" style={{ color: n < 0 ? '#B42318' : '#167A2D' }}>{n >= 0 ? '+' : ''}{n}</div>
              </div>
            );
          })}
        </div>
        <div className="dpm-legend">
          <span><i className="dpm-sw" style={{ background: '#1E9E3A' }} /> Altas</span>
          <span><i className="dpm-sw" style={{ background: '#C8C8C0' }} /> Bajas</span>
          <span className="dpm-legend-note">{mesActual.mes} en curso</span>
        </div>
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Captación</div>
        <div className="dpm-brows">
          {EMBUDO_NIVEL.map((p, i) => {
            const caida = i === 0 ? 0 : EMBUDO_NIVEL[i - 1].n - p.n;
            return (
              <FilaBarra key={p.paso} label={p.paso} pct={(p.n / maxEmbudo) * 100}
                valor={<>{i > 0 && <span className="dpm-drop">−{caida}</span>} {p.n}</>} />
            );
          })}
        </div>
        <BotonEnlace href="/admin?tab=leveltests">Tests de nivel</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 3 · Riesgo de baja ──────────────────────────────────────────────────────

function Riesgo() {
  const total = RIESGO.verde + RIESGO.rojo;
  const pct = Math.round((RIESGO.rojo / total) * 100);
  // Umbral a validar: a partir del 10 % del alumnado en rojo, la sección entera
  // se marca en rojo; con alguno en rojo pero menos del 10 %, amarillo.
  const tono: Tono = pct >= 10 ? 'rojo' : RIESGO.rojo > 0 ? 'amarillo' : 'ok';

  return (
    <Seccion id="riesgo" titulo="Riesgo de baja" tono={tono} resumen={`${RIESGO.rojo} en rojo · ${pct} % del alumnado`}>
      <div className="adm-card dpm-card">
        <div className="dpm-figure">
          <span className="dpm-big" style={{ color: '#B42318' }}>{RIESGO.rojo}</span>
          <span className="dpm-big-cap">alumnos con alerta abierta</span>
        </div>
        <Apilada partes={[{ n: RIESGO.verde, color: '#1E9E3A' }, { n: RIESGO.rojo, color: '#dc4a38' }]} />
        <ul className="dpm-list">
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#1E9E3A' }} /><span className="dpm-row-label">Sin señales</span><span className="dpm-row-n">{RIESGO.verde}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dpm-row-label">Con alerta abierta</span><span className="dpm-row-n">{RIESGO.rojo}</span></li>
        </ul>
        <p className="dpm-note">La IA clasifica cada clase en verde o rojo. No hay nivel intermedio.</p>
      </div>

      <div className="adm-card dpm-card dpm-card-list">
        <div className="dpm-card-head">Los cinco más urgentes</div>
        <ul className="dpm-people">
          {RIESGO.urgentes.slice(0, MAX_LISTA).map(u => (
            <li key={u.alumno}>
              <Link href="/admin?tab=ai" className="dpm-person">
                <span className="adm-dot" style={{ background: '#dc4a38' }} />
                <span className="dpm-person-body">
                  <span className="dpm-person-name">{u.alumno}</span>
                  <span className="dpm-person-sub">{u.causa}</span>
                </span>
                <span className="dpm-person-meta">
                  <span>{u.profe}</span>
                  <span className="dpm-person-dias">hace {u.dias} d</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <BotonEnlace href="/admin?tab=ai">Ver los {RIESGO.rojo} en riesgo</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 4 · Clases de la semana ─────────────────────────────────────────────────

function Clases() {
  const pct = Math.round((OPERACION.dadas / OPERACION.programadas) * 100);
  // Umbral a validar: menos del 80 % dado es rojo; menos del 90 %, o cualquier
  // falta sin aviso, amarillo.
  const tono: Tono = pct < 80 ? 'rojo' : (pct < 90 || OPERACION.faltasSinAviso > 0) ? 'amarillo' : 'ok';

  return (
    <Seccion id="clases" titulo="Clases de la semana" tono={tono}
      resumen={`${OPERACION.dadas} de ${OPERACION.programadas} dadas · ${OPERACION.faltasSinAviso} faltas sin aviso`}>
      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Dadas sobre programadas</div>
        <div className="dpm-figure is-left">
          <span className="dpm-big">{OPERACION.dadas}<span className="dpm-big-of"> / {OPERACION.programadas}</span></span>
        </div>
        <div className="dpm-track" aria-hidden><div className="dpm-fill" style={{ width: `${pct}%` }} /></div>
        <p className="dpm-note">{pct} % de lo programado se dio. Las {OPERACION.programadas - OPERACION.dadas} restantes están sin registrar o se cancelaron.</p>
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Del mes</div>
        <ul className="dpm-list">
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dpm-row-label">Faltas sin aviso</span><span className="dpm-row-n">{OPERACION.faltasSinAviso}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#FFC400' }} /><span className="dpm-row-label">Recuperaciones pendientes</span><span className="dpm-row-n">{OPERACION.recuperacionesPendientes}</span></li>
          <li className="dpm-row"><span className="adm-dot" style={{ background: '#2563eb' }} /><span className="dpm-row-label">Sesiones de 2 h</span><span className="dpm-row-n">{OPERACION.clases2h}</span></li>
        </ul>
      </div>

      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Cupos libres por franja</div>
        <div className="dpm-brows">
          {OPERACION.franjas.map(f => {
            const total = f.ocupados + f.libres;
            return (
              <FilaBarra key={f.franja} label={`${f.franja} h`} valor={<>{f.libres} <span className="dpm-brow-unit">libres</span></>}
                pct={(f.ocupados / total) * 100} track="#CFE6D5" />
            );
          })}
        </div>
        <p className="dpm-note">La parte clara es lo que queda libre. La franja de tarde está al tope.</p>
        <BotonEnlace href="/admin?tab=classlog">Registro de clases</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 5 · Finanzas del mes ────────────────────────────────────────────────────

function Finanzas() {
  const delta = FINANZAS.totalAPagar - FINANZAS.mesAnterior;
  const pctDelta = Math.round((delta / FINANZAS.mesAnterior) * 100);
  const partes = [
    { label: 'Pagable',   n: FINANZAS.montoPagable,  color: '#1E9E3A' },
    { label: 'A revisar', n: FINANZAS.montoARevisar, color: '#FFC400' },
    { label: 'Retenido',  n: FINANZAS.montoRetenido, color: '#C8C8C0' },
  ];
  const tono: Tono = FINANZAS.montoARevisar > 0 ? 'amarillo' : 'ok';

  return (
    <Seccion id="finanzas" titulo="Finanzas del mes" tono={tono}
      resumen={`${eur(FINANZAS.totalAPagar)} a pagar · ${eur(FINANZAS.montoARevisar)} a revisar`}>
      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Total a pagar</div>
        <div className="dpm-figure is-left">
          <span className="dpm-big">{eur(FINANZAS.totalAPagar)}</span>
        </div>
        <div className="dpm-delta" style={{ color: delta >= 0 ? '#8a6d00' : '#167A2D' }}>
          {delta >= 0 ? '↑' : '↓'} {eur(Math.abs(delta))} ({pctDelta >= 0 ? '+' : ''}{pctDelta} %) vs. mes anterior
        </div>
        <p className="dpm-note">Incluye {eur(FINANZAS.bonus)} de bonus y {eur(FINANZAS.penalizaciones)} de penalizaciones.</p>
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
        <p className="dpm-note">&quot;A revisar&quot; son clases que esperan validación: hasta que se resuelvan, el profesor no cobra.</p>
      </div>

      <div className="adm-card dpm-card">
        <FilaBarra label="Profesores pagados este mes" valor={<>{FINANZAS.profesoresPagados} <span className="dpm-brow-unit">/ {FINANZAS.profesoresTotales}</span></>}
          pct={(FINANZAS.profesoresPagados / FINANZAS.profesoresTotales) * 100} />
        <BotonEnlace href="/finanzas" primario>Abrir finanzas</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 6 · Profesores ──────────────────────────────────────────────────────────

function Profesores() {
  const transcriptsTarde = PROFESORES.reduce((s, p) => s + p.transcriptsTarde, 0);
  const cuposLibres = PROFESORES.reduce((s, p) => s + p.cuposLibres, 0);
  const max = Math.max(...PROFESORES.map(p => p.clases));
  // Primero los que arrastran transcripts: es lo que el admin tiene que reclamar.
  const orden = [...PROFESORES].sort((a, b) => b.transcriptsTarde - a.transcriptsTarde || b.clases - a.clases).slice(0, MAX_LISTA);
  const sinIA = PROFESORES.filter(p => !p.usaIA).map(p => p.nombre);
  const tono: Tono = transcriptsTarde > 0 ? 'amarillo' : 'ok';

  return (
    <Seccion id="profesores" titulo="Profesores" tono={tono}
      resumen={`${transcriptsTarde} transcripts atrasados · ${cuposLibres} cupos libres`}>
      <div className="adm-card dpm-card">
        <div className="dpm-card-head">Clases del mes</div>
        <div className="dpm-brows">
          {orden.map(p => (
            <FilaBarra key={p.nombre} pct={(p.clases / max) * 100} valor={p.clases}
              label={<>
                {p.nombre}
                {p.transcriptsTarde > 0 && <span className="dpm-tag is-warn">{p.transcriptsTarde} sin subir</span>}
                {p.cuposLibres > 0 && <span className="dpm-tag is-ok">{p.cuposLibres} libres</span>}
              </>} />
          ))}
        </div>
        <BotonEnlace href="/admin?tab=teachers">Ver los {RESUMEN.profesoresTotales} profesores</BotonEnlace>
      </div>

      <div className="adm-card dpm-card">
        <FilaBarra label="Usan la IA para preparar clases" valor={<>{IA.usan} <span className="dpm-brow-unit">/ {IA.total}</span></>}
          pct={(IA.usan / IA.total) * 100} />
        <p className="dpm-note">
          Sin usarla: {sinIA.join(', ')} y {IA.total - IA.usan - sinIA.length} más.
        </p>
        <BotonEnlace href="/admin?tab=aiusage">Uso de la IA</BotonEnlace>
      </div>
    </Seccion>
  );
}

// ─── 7 · Herramientas de mantenimiento ───────────────────────────────────────

function Herramientas() {
  return (
    <Seccion id="herramientas" titulo="Herramientas de mantenimiento" resumen={`${HERRAMIENTAS.length} paneles · viven en /dashboard`}>
      <div className="adm-card dpm-card dpm-card-list">
        <ul className="dpm-tools">
          {HERRAMIENTAS.map(t => (
            <li key={t}>
              <Link href="/dashboard" className="dpm-tool">
                <span>{t}</span>
                <ChevronRight size={18} strokeWidth={2} aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
        <p className="dpm-note">En la maqueta no hacen nada: los paneles funcionales siguen en /dashboard.</p>
      </div>
    </Seccion>
  );
}

// ─── Cabecera y navegación inferior ──────────────────────────────────────────

/**
 * Las cuatro entradas que el admin usa desde el teléfono. Inicio es esta misma
 * pantalla; Admin concentra seis de las ocho colas de "Requiere acción";
 * Alumnos es donde se busca a alguien cuando escribe o llama; Finanzas es la
 * única entrada de la barra real que lleva contador (solicitudes de revisión).
 * Buscar (setter) y Próximos a cancelar se quedan fuera: son tareas de
 * escritorio, y la segunda ya entra por su cola en "Requiere acción".
 */
const NAV = [
  { href: '/dashboard-preview', label: 'Inicio',   Icon: LayoutDashboard },
  { href: '/admin',             label: 'Admin',    Icon: Settings },
  { href: '/students',          label: 'Alumnos',  Icon: Users },
  { href: '/finanzas',          label: 'Finanzas', Icon: Wallet },
];

function NavInferior() {
  const path = usePathname();
  const revisiones = ACCIONES.find(a => a.href === '/finanzas')?.n ?? 0;
  return (
    <nav className="dpm-nav" aria-label="Navegación principal">
      {NAV.map(({ href, label, Icon }) => {
        const activo = path === href;
        const badge = href === '/finanzas' ? revisiones : 0;
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

export function DashboardMovil() {
  const [simularVacio, setSimularVacio] = useState(false);
  return (
    <div className="dpm">
      <header className="dpm-top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="dpm-logo" src="/drc-logo.png" alt="DRC Academy" />
        <span className="dpm-date">{fechaCorta(HOY)}</span>
        <span className="dpm-pill" title="Ningún número de esta pantalla sale de la base. Los enlaces sí son reales.">
          <span className="adm-dot" style={{ background: '#FFC400' }} /> Datos de ejemplo
        </span>
      </header>

      <main className="dpm-main">
        <RequiereAccion simularVacio={simularVacio} onSimular={() => setSimularVacio(v => !v)} />
        <SaludNegocio />
        <Riesgo />
        <Clases />
        <Finanzas />
        <Profesores />
        <Herramientas />
      </main>

      <NavInferior />
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
.dpm {
  font-family: var(--font-app);
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  background: var(--bg-base);
  min-height: 100dvh;
  font-size: 14px; line-height: 1.45;
}
.dpm a { -webkit-tap-highlight-color: rgba(30,158,58,0.15); }

/* ── Cabecera fija y compacta ── */
.dpm-top {
  position: fixed; top: 0; left: 0; right: 0; z-index: 40;
  height: calc(52px + env(safe-area-inset-top));
  padding: env(safe-area-inset-top) 16px 0;
  display: flex; align-items: center; gap: 10px;
  background: rgba(255,255,255,0.96); backdrop-filter: saturate(180%) blur(8px);
  border-bottom: 1px solid var(--border);
}
.dpm-logo { height: 24px; width: auto; display: block; flex-shrink: 0; }
.dpm-date { font-size: 14px; font-weight: 600; color: var(--text-secondary); white-space: nowrap; }
.dpm-pill {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  font-size: 12px; font-weight: 600; color: #5c4a00;
  background: rgba(255,196,0,0.14); border: 1px solid rgba(255,196,0,0.5);
  border-radius: 999px; padding: 5px 10px;
}

/* ── Cuerpo: deja sitio a la cabecera y a la barra inferior (zona segura incluida) ── */
.dpm-main {
  padding: calc(52px + env(safe-area-inset-top) + 12px) 16px calc(64px + env(safe-area-inset-bottom) + 24px);
  display: flex; flex-direction: column; gap: 10px;
}

/* ── Sección plegable ── */
.dpm-sec {
  background: #fff; border: 1px solid #e6e7e2; border-radius: 14px;
  box-shadow: 0 1px 2px rgba(16,24,16,0.04);
}
.dpm-sum {
  list-style: none; cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 12px;
  min-height: 60px; padding: 10px 14px 10px 16px;
}
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
.dpm-card { padding: 14px 14px 14px; display: flex; flex-direction: column; }
.dpm-card-list { padding-bottom: 12px; }
.dpm-card-head {
  font-size: 14px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
  color: var(--text-muted); margin-bottom: 10px;
}
.dpm-note { margin: 10px 0 0; font-size: 14px; color: var(--text-muted); line-height: 1.45; }

/* ── Requiere acción ── */
.dpm-acts { display: flex; flex-direction: column; gap: 8px; }
.dpm-act {
  display: flex; align-items: center; gap: 12px;
  border: 1px solid; border-radius: 12px; padding: 12px 12px 12px 14px; min-height: 64px;
  text-decoration: none; color: inherit;
}
.dpm-act:active { transform: scale(0.99); }
.dpm-act-n { font-size: 32px; font-weight: 700; line-height: 1; min-width: 44px; text-align: center; }
.dpm-act.is-first { min-height: 76px; }
.dpm-act.is-first .dpm-act-n { font-size: 36px; }
.dpm-act-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dpm-act-label { font-size: 15px; font-weight: 600; line-height: 1.3; color: var(--text-primary); }
.dpm-act-det { font-size: 14px; color: var(--text-secondary); }
.dpm-act-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 2px; flex-shrink: 0;
  min-height: 44px; min-width: 64px; padding: 0 10px 0 14px;
  background: #fff; border: 1px solid; border-radius: 10px;
  font-size: 15px; font-weight: 700;
}
.dpm-vacio { align-items: center; text-align: center; padding: 26px 16px 24px; gap: 6px; }
.dpm-vacio-title { font-size: 22px; font-weight: 700; margin-top: 4px; }
.dpm-vacio-sub { font-size: 14px; color: var(--text-muted); }
.dpm-mock {
  align-self: center; margin-top: 2px; min-height: 44px; padding: 0 12px;
  border: none; background: transparent; font-family: inherit; font-size: 14px;
  color: var(--accent); font-weight: 600; cursor: pointer;
}
.dpm-mock span { color: var(--text-muted); font-weight: 400; }

/* ── Botones ── */
.dpm-btn {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  min-height: 48px; margin-top: 12px; padding: 0 16px; border-radius: 10px;
  border: 1px solid var(--border-light); background: #fff;
  font-family: inherit; font-size: 15px; font-weight: 600; color: var(--accent);
  text-decoration: none; cursor: pointer;
}
.dpm-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.dpm-btn.is-ghost { margin-top: 2px; border-color: transparent; background: transparent; }
.dpm-btn:active { opacity: 0.85; }

/* ── KPI en fila deslizable ── */
.dpm-kpis {
  display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory;
  margin: 0 -12px; padding: 0 12px 4px; scroll-padding-left: 12px;
  -webkit-overflow-scrolling: touch; scrollbar-width: none;
}
.dpm-kpis::-webkit-scrollbar { display: none; }
.dpm-kpi {
  /* Dos tarjetas y un tercio de la siguiente asomando, en cualquier ancho: la
     pista de que la fila se desliza. */
  flex: 0 0 calc(50% - 22px); scroll-snap-align: start;
  background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; padding: 12px 14px 13px;
}
.dpm-kpi-l { font-size: 13px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-muted); line-height: 1.25; }
.dpm-kpi-v { font-size: 28px; font-weight: 700; line-height: 1.15; margin-top: 6px; }
.dpm-kpi-p { font-size: 14px; color: var(--text-muted); margin-top: 4px; }

.dpm-track { height: 8px; border-radius: 4px; background: var(--bg-surface-3); overflow: hidden; margin-top: 8px; }
.dpm-fill { height: 100%; background: #1E9E3A; border-radius: 4px; }

/* ── Listas ── */
.dpm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-row { display: flex; align-items: center; gap: 10px; min-height: 36px; font-size: 14px; }
.dpm-row-label { color: var(--text-secondary); flex: 1; min-width: 0; }
.dpm-row-pct { font-size: 14px; color: var(--text-muted); }
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
.dpm-brow-sub { font-size: 14px; color: var(--text-muted); }
.dpm-drop { font-size: 14px; font-weight: 600; color: #B42318; margin-right: 4px; }
.dpm-tag { font-size: 13px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.dpm-tag.is-ok { background: rgba(22,122,45,0.10); color: #167A2D; }
.dpm-tag.is-warn { background: rgba(255,196,0,0.22); color: #8a6d00; }

/* ── Altas y bajas ── */
.dpm-months { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; align-items: end; }
.dpm-month { text-align: center; }
.dpm-month-bars { display: flex; align-items: flex-end; justify-content: center; gap: 3px; height: 64px; }
.dpm-bar { width: 12px; border-radius: 3px 3px 0 0; min-height: 3px; }
.dpm-month-l { font-size: 14px; color: var(--text-muted); margin-top: 6px; }
.dpm-month-net { font-size: 14px; font-weight: 700; }
.dpm-legend { display: flex; gap: 14px; font-size: 14px; color: var(--text-muted); margin-top: 12px; align-items: center; }
.dpm-legend span { display: inline-flex; align-items: center; gap: 6px; }
.dpm-legend-note { margin-left: auto; }
.dpm-sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }

/* ── Cifras grandes ── */
.dpm-figure { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2px; padding: 4px 0 10px; }
.dpm-figure.is-left { align-items: flex-start; text-align: left; padding: 0 0 4px; }
.dpm-big { font-size: 34px; font-weight: 700; line-height: 1.1; }
.dpm-big-of { font-size: 18px; font-weight: 500; color: var(--text-muted); }
.dpm-big-cap { font-size: 14px; color: var(--text-muted); }
.dpm-delta { font-size: 14px; font-weight: 600; margin-top: 4px; }

/* ── Personas (riesgo) ── */
.dpm-people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-person {
  display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 0;
  border-top: 1px solid var(--border); text-decoration: none; color: inherit;
}
.dpm-people li:first-child .dpm-person { border-top: 0; }
.dpm-person-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dpm-person-name { font-size: 15px; font-weight: 600; }
.dpm-person-sub { font-size: 14px; color: var(--text-muted); }
.dpm-person-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 14px; color: var(--text-secondary); white-space: nowrap; }
.dpm-person-dias { color: var(--text-muted); }

/* ── Herramientas ── */
.dpm-tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-tool {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  min-height: 48px; padding: 6px 0; border-top: 1px solid var(--border);
  font-size: 15px; color: var(--text-primary); text-decoration: none;
}
.dpm-tools li:first-child .dpm-tool { border-top: 0; }
.dpm-tool svg { color: var(--text-muted); flex-shrink: 0; }

/* ── Navegación inferior fija, respetando la zona segura del iPhone ── */
.dpm-nav {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: grid; grid-template-columns: repeat(4, 1fr);
  height: calc(64px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: #fff; border-top: 1px solid var(--border);
}
.dpm-nav-item {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  min-height: 44px; text-decoration: none; color: var(--text-muted);
}
.dpm-nav-item.is-active { color: var(--accent); }
.dpm-nav-icon { position: relative; display: inline-flex; }
.dpm-nav-badge {
  position: absolute; top: -6px; right: -12px;
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: #FFC400; color: #3d3000; font-size: 11px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.dpm-nav-label { font-size: 12px; font-weight: 600; letter-spacing: 0.01em; }
`;
