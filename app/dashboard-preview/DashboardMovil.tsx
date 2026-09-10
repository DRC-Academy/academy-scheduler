'use client';

// VISTA MÓVIL de la maqueta del dashboard (por debajo de 768 px).
//
// Rediseño de septiembre de 2026, desde cero y con una sola pregunta en la
// cabeza: "¿tengo que resolver algo ahora?" y, si no, "¿cómo viene el mes?".
// Todo lo que no contesta una de las dos se quedó en el escritorio.
//
// Reglas que gobiernan esta pantalla (no negociables):
//   · De 320 a 767 px NADA se desliza en horizontal: ni carruseles, ni tablas,
//     ni gráficos más anchos que la pantalla. Solo scroll vertical.
//   · Una sola columna. Como máximo, pares de tarjetas 2×N cuando son dos
//     cifras cortas.
//   · Ningún texto se corta ni desborda: las etiquetas parten en dos líneas y
//     los nombres largos se recortan con puntos suspensivos.
//   · Cabecera compacta (logo, fecha, aviso de datos de ejemplo) y navegación
//     inferior fija, las dos respetando la zona segura del iPhone.
//   · Zonas táctiles ≥ 44 px. Cuerpo 14–15 px, cifras principales 28–32 px.
//   · Rojo solo para urgencias reales.
//
// Seis bloques, en este orden: Requiere acción · Alumnos activos · Este mes ·
// Finanzas del mes · Clases de la semana · Riesgo de baja. Fuera quedan cupos
// por franja, conflictos, uso de IA, ranking de profesores, emails de
// presentación, embudo del test y las herramientas de mantenimiento.
//
// Los datos son los MISMOS de ./datos-ejemplo.ts que usa la vista de
// escritorio. Nada sale de la base. Los enlaces sí son reales.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Settings, Users, Wallet, ChevronRight, CircleCheck } from 'lucide-react';
import {
  HOY, RESUMEN, ACCIONES, SUSCRIPCIONES, MOVIMIENTO, RIESGO, OPERACION, FINANZAS,
  TONO, fechaCorta, type Accion,
} from './datos-ejemplo';

// ─── Qué colas entran en el teléfono ─────────────────────────────────────────
// Solo las cuatro que el admin resuelve desde el celular. El resto (emails,
// solicitudes, alumnos sin profesor, análisis fallidos) se queda en escritorio.
const COLAS_MOVIL = ['validaciones', 'transcripts', 'riesgo', 'proximos-cancelar'];

/** "8.420 €", con el punto de miles que en el teléfono se lee mejor. */
const eur = (n: number) => `${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;
const num = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// ─── Piezas ──────────────────────────────────────────────────────────────────

/** Título de bloque con su enlace a la pantalla real, si la tiene. */
function Bloque({ titulo, href, cta = 'Ver', children }: {
  titulo: string; href?: string; cta?: string; children: React.ReactNode;
}) {
  return (
    <section className="dpm-bloque">
      <div className="dpm-bloque-head">
        <h2 className="dpm-h2">{titulo}</h2>
        {href && <Link href={href} className="dpm-link">{cta} <ChevronRight size={16} strokeWidth={2.25} aria-hidden /></Link>}
      </div>
      {children}
    </section>
  );
}

/** Barra segmentada de ancho completo. Sin tooltip: los números van debajo. */
function Segmentada({ partes, alto = 12 }: { partes: Array<{ n: number; color: string }>; alto?: number }) {
  const total = partes.reduce((s, p) => s + p.n, 0);
  return (
    <div className="dpm-seg" style={{ height: alto }} aria-hidden>
      {partes.map((p, i) => (
        <div key={i} style={{ width: `${total > 0 ? (p.n / total) * 100 : 0}%`, background: p.color }} />
      ))}
    </div>
  );
}

function Fila({ color, label, n, sub }: { color: string; label: string; n: React.ReactNode; sub?: string }) {
  return (
    <li className="dpm-fila">
      <span className="adm-dot" style={{ background: color }} />
      <span className="dpm-fila-l">{label}{sub && <span className="dpm-fila-sub"> · {sub}</span>}</span>
      <span className="dpm-fila-n">{n}</span>
    </li>
  );
}

// ─── 1 · Requiere acción hoy ─────────────────────────────────────────────────

function RequiereAccion({ simularVacio, onSimular }: { simularVacio: boolean; onSimular: () => void }) {
  // En el orden en que están en los datos (que ya va de rojo a amarillo).
  const colas: Accion[] = simularVacio ? [] : ACCIONES.filter(a => COLAS_MOVIL.includes(a.clave) && a.n > 0);

  return (
    <Bloque titulo="Requiere acción hoy">
      {colas.length === 0 ? (
        <div className="adm-card dpm-card dpm-vacio">
          <CircleCheck size={36} strokeWidth={1.75} color="#1E9E3A" aria-hidden />
          <div className="dpm-vacio-t">Todo al día</div>
          <div className="dpm-vacio-s">No hay nada que resolver ahora mismo.</div>
        </div>
      ) : (
        <div className="dpm-alertas">
          {colas.map(a => {
            const t = TONO[a.tono];
            return (
              <Link key={a.clave} href={a.href} className="dpm-alerta" style={{ background: t.bg, borderColor: t.bd }}>
                <span className="dpm-alerta-n" style={{ color: t.fg }}>{a.n}</span>
                <span className="dpm-alerta-body">
                  <span className="dpm-alerta-l">{a.label}</span>
                  <span className="dpm-alerta-d">{a.detalle}</span>
                </span>
                <span className="dpm-alerta-btn" style={{ color: t.fg, borderColor: t.bd }}>Ver</span>
              </Link>
            );
          })}
        </div>
      )}
      {/* Control SOLO de la maqueta: para ver los dos estados sin tocar datos. */}
      <button type="button" className="dpm-mock" onClick={onSimular}>
        {simularVacio ? 'Volver a los datos de ejemplo' : 'Ver cómo queda sin pendientes'}<span> · solo maqueta</span>
      </button>
    </Bloque>
  );
}

// ─── 2 · Alumnos activos ─────────────────────────────────────────────────────

function AlumnosActivos() {
  const total = SUSCRIPCIONES.porOrigen.reduce((s, o) => s + o.n, 0);
  return (
    <Bloque titulo="Alumnos activos" href="/students">
      <div className="adm-card dpm-card">
        <div className="dpm-cifra">
          <span className="dpm-cifra-n">{num(RESUMEN.alumnosActivos)}</span>
          <span className="dpm-cifra-l">activos de {num(RESUMEN.alumnosTotales)} en la base</span>
        </div>
        <Segmentada partes={SUSCRIPCIONES.porOrigen} />
        <ul className="dpm-filas">
          {SUSCRIPCIONES.porOrigen.map(o => (
            <Fila key={o.origen} color={o.color} label={o.origen} sub={`${Math.round((o.n / total) * 100)} %`} n={o.n} />
          ))}
        </ul>
      </div>
    </Bloque>
  );
}

// ─── 3 · Este mes ────────────────────────────────────────────────────────────

function EsteMes() {
  const actual = MOVIMIENTO[MOVIMIENTO.length - 1];
  const neto = actual.altas - actual.bajas;
  const max = Math.max(...MOVIMIENTO.flatMap(m => [m.altas, m.bajas]));
  return (
    <Bloque titulo="Este mes" href="/students">
      <div className="adm-card dpm-card">
        <div className="dpm-par">
          <div className="dpm-par-item">
            <span className="dpm-par-n" style={{ color: '#167A2D' }}>+{actual.altas}</span>
            <span className="dpm-par-l">altas</span>
          </div>
          <div className="dpm-par-item">
            <span className="dpm-par-n" style={{ color: 'var(--text-secondary)' }}>−{actual.bajas}</span>
            <span className="dpm-par-l">bajas</span>
          </div>
        </div>
        <div className="dpm-neto" style={{ color: neto < 0 ? '#B42318' : '#167A2D' }}>
          {neto >= 0 ? '+' : ''}{neto} alumnos netos en {actual.mes.toLowerCase()}
        </div>

        {/* Seis meses a lo ancho de la tarjeta: seis columnas iguales, nunca más anchas que ella. */}
        <div className="dpm-meses" aria-label="Altas y bajas de los últimos seis meses">
          {MOVIMIENTO.map(m => {
            const n = m.altas - m.bajas;
            return (
              <div key={m.mes} className="dpm-mes">
                <div className="dpm-mes-barras">
                  <div className="dpm-mes-barra" style={{ height: `${(m.altas / max) * 100}%`, background: '#1E9E3A' }} />
                  <div className="dpm-mes-barra" style={{ height: `${(m.bajas / max) * 100}%`, background: '#C8C8C0' }} />
                </div>
                <div className="dpm-mes-l">{m.mes}</div>
                <div className="dpm-mes-neto" style={{ color: n < 0 ? '#B42318' : '#167A2D' }}>{n >= 0 ? '+' : ''}{n}</div>
              </div>
            );
          })}
        </div>
        <div className="dpm-leyenda">
          <span><i style={{ background: '#1E9E3A' }} /> Altas</span>
          <span><i style={{ background: '#C8C8C0' }} /> Bajas</span>
          <span className="dpm-leyenda-nota">{actual.mes} en curso</span>
        </div>
      </div>
    </Bloque>
  );
}

// ─── 4 · Finanzas del mes ────────────────────────────────────────────────────

function Finanzas() {
  // "Pendiente" junta lo que todavía no se paga: a revisar y retenido.
  const pendiente = FINANZAS.montoARevisar + FINANZAS.montoRetenido;
  return (
    <Bloque titulo="Finanzas del mes" href="/finanzas">
      <div className="adm-card dpm-card">
        <div className="dpm-cifra">
          <span className="dpm-cifra-n">{eur(FINANZAS.totalAPagar)}</span>
          <span className="dpm-cifra-l">a pagar a profesores</span>
        </div>
        <Segmentada partes={[{ n: FINANZAS.montoPagable, color: '#1E9E3A' }, { n: pendiente, color: '#FFC400' }]} />
        <div className="dpm-par">
          <div className="dpm-par-item">
            <span className="dpm-par-n">{eur(FINANZAS.montoPagable)}</span>
            <span className="dpm-par-l"><i className="dpm-punto" style={{ background: '#1E9E3A' }} />pagable</span>
          </div>
          <div className="dpm-par-item">
            <span className="dpm-par-n">{eur(pendiente)}</span>
            <span className="dpm-par-l"><i className="dpm-punto" style={{ background: '#FFC400' }} />pendiente</span>
          </div>
        </div>
      </div>
    </Bloque>
  );
}

// ─── 5 · Clases de la semana ─────────────────────────────────────────────────

function Clases() {
  const pct = Math.round((OPERACION.dadas / OPERACION.programadas) * 100);
  return (
    <Bloque titulo="Clases de la semana" href="/admin?tab=classlog">
      <div className="adm-card dpm-card">
        <div className="dpm-cifra">
          <span className="dpm-cifra-n">{OPERACION.dadas}<span className="dpm-cifra-de"> de {OPERACION.programadas}</span></span>
          <span className="dpm-cifra-l">dadas sobre las programadas · {pct} %</span>
        </div>
        <div className="dpm-track" aria-hidden><div className="dpm-fill" style={{ width: `${pct}%` }} /></div>
        <ul className="dpm-filas" style={{ marginTop: 6 }}>
          <Fila color="#dc4a38" label="Faltas sin aviso" n={OPERACION.faltasSinAviso} />
        </ul>
      </div>
    </Bloque>
  );
}

// ─── 6 · Riesgo de baja ──────────────────────────────────────────────────────

function Riesgo() {
  const total = RIESGO.verde + RIESGO.rojo;
  const pct = Math.round((RIESGO.rojo / total) * 100);
  return (
    <Bloque titulo="Riesgo de baja" href="/admin?tab=ai" cta="Ver todos">
      <div className="adm-card dpm-card">
        <div className="dpm-cifra">
          <span className="dpm-cifra-n" style={{ color: '#B42318' }}>{RIESGO.rojo}</span>
          <span className="dpm-cifra-l">en rojo · {pct} % del alumnado</span>
        </div>
        {/* Dos niveles, no tres: desde julio de 2026 la IA clasifica en verde o rojo. */}
        <Segmentada partes={[{ n: RIESGO.verde, color: '#1E9E3A' }, { n: RIESGO.rojo, color: '#dc4a38' }]} />
        <ul className="dpm-filas">
          <Fila color="#1E9E3A" label="Sin señales" n={RIESGO.verde} />
          <Fila color="#dc4a38" label="Con alerta abierta" n={RIESGO.rojo} />
        </ul>
      </div>

      <div className="adm-card dpm-card dpm-card-lista">
        <div className="dpm-card-head">Los tres más urgentes</div>
        <ul className="dpm-urgentes">
          {RIESGO.urgentes.slice(0, 3).map(u => (
            <li key={u.alumno}>
              <Link href="/admin?tab=ai" className="dpm-urgente">
                <span className="dpm-urgente-body">
                  <span className="dpm-urgente-nombre">{u.alumno}</span>
                  <span className="dpm-urgente-causa">{u.causa}</span>
                </span>
                <span className="dpm-urgente-meta">
                  <span className="dpm-urgente-profe">{u.profe}</span>
                  <span className="dpm-urgente-dias">hace {u.dias} d</span>
                </span>
                <ChevronRight size={18} strokeWidth={2} aria-hidden className="dpm-urgente-chev" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Bloque>
  );
}

// ─── Cabecera y navegación inferior ──────────────────────────────────────────

/**
 * Las cuatro entradas que el admin usa desde el teléfono. Inicio es esta misma
 * pantalla; Admin es donde aterrizan tres de las cuatro colas de "Requiere
 * acción"; Alumnos es donde se busca a alguien cuando escribe o llama;
 * Finanzas es la única entrada de la barra real que lleva contador. Buscar
 * (setter) y Próximos a cancelar quedan fuera: la primera es tarea de
 * escritorio y la segunda ya entra por su alerta.
 */
const NAV = [
  { href: '/dashboard-preview', label: 'Inicio',   Icon: LayoutDashboard },
  { href: '/admin',             label: 'Admin',    Icon: Settings },
  { href: '/students',          label: 'Alumnos',  Icon: Users },
  { href: '/finanzas',          label: 'Finanzas', Icon: Wallet },
];

function NavInferior() {
  const path = usePathname();
  const revisiones = ACCIONES.find(a => a.clave === 'solicitudes')?.n ?? 0;
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
        <div className="dpm-top-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="dpm-logo" src="/drc-logo.png" alt="DRC Academy" />
          <span className="dpm-fecha">{fechaCorta(HOY)}</span>
        </div>
        <div className="dpm-aviso"><span className="adm-dot" style={{ background: '#FFC400' }} /> Vista previa con datos de ejemplo</div>
      </header>

      <main className="dpm-main">
        <RequiereAccion simularVacio={simularVacio} onSimular={() => setSimularVacio(v => !v)} />
        <AlumnosActivos />
        <EsteMes />
        <Finanzas />
        <Clases />
        <Riesgo />
      </main>

      <NavInferior />
      <style>{ESTILOS}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Estilos de la vista móvil, con prefijo `dpm-`. Mismos colores y tokens que la
// app; nada de esto toca otra pantalla. Cuerpo 14–15 px, cifras principales
// 30–32 px, zonas táctiles ≥ 44 px. Nada tiene ancho mínimo ni fijo mayor que
// la pantalla: a 320 px todo sigue en una columna.
// ─────────────────────────────────────────────────────────────────────────────

const ESTILOS = `
.dpm {
  font-family: var(--font-app);
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  background: var(--bg-base);
  min-height: 100dvh;
  font-size: 14px; line-height: 1.45;
  overflow-wrap: anywhere;
}
.dpm a { -webkit-tap-highlight-color: rgba(30,158,58,0.15); }
.dpm * { box-sizing: border-box; min-width: 0; }

/* ── Cabecera fija: una fila (logo · fecha) y la franja del aviso ── */
.dpm-top {
  position: fixed; top: 0; left: 0; right: 0; z-index: 40;
  padding-top: env(safe-area-inset-top);
  background: rgba(255,255,255,0.96); backdrop-filter: saturate(180%) blur(8px);
  border-bottom: 1px solid var(--border);
}
.dpm-top-row { height: 50px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dpm-logo { height: 24px; width: auto; display: block; flex-shrink: 0; }
.dpm-fecha { font-size: 14px; font-weight: 600; color: var(--text-secondary); white-space: nowrap; }
.dpm-aviso {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  height: 26px; padding: 0 12px;
  background: rgba(255,196,0,0.14); border-top: 1px solid rgba(255,196,0,0.35);
  font-size: 13px; font-weight: 600; color: #5c4a00; white-space: nowrap;
}

/* ── Cuerpo: deja sitio a la cabecera (50 + 26) y a la barra inferior ── */
.dpm-main {
  padding: calc(76px + env(safe-area-inset-top) + 14px) 16px calc(64px + env(safe-area-inset-bottom) + 20px);
  display: flex; flex-direction: column; gap: 18px;
}

/* ── Bloques ── */
.dpm-bloque { display: flex; flex-direction: column; gap: 8px; }
.dpm-bloque-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; padding: 0 2px; }
.dpm-h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.dpm-link { display: inline-flex; align-items: center; gap: 2px; min-height: 44px; padding: 0 4px 0 8px; font-size: 14px; font-weight: 600; color: var(--accent); text-decoration: none; white-space: nowrap; }

.dpm-card { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dpm-card-lista { gap: 0; padding-bottom: 6px; }
.dpm-card-head { font-size: 14px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px; }

/* ── Cifra principal ── */
.dpm-cifra { display: flex; flex-direction: column; gap: 2px; }
.dpm-cifra-n { font-size: 32px; font-weight: 700; line-height: 1.1; letter-spacing: -0.01em; }
.dpm-cifra-de { font-size: 18px; font-weight: 500; color: var(--text-muted); letter-spacing: 0; }
.dpm-cifra-l { font-size: 14px; color: var(--text-muted); }

/* ── Par de cifras (2×N) ── */
.dpm-par { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dpm-par-item { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; background: var(--bg-base); border-radius: 10px; }
.dpm-par-n { font-size: 24px; font-weight: 700; line-height: 1.15; }
.dpm-par-l { font-size: 14px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.dpm-punto { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.dpm-neto { font-size: 15px; font-weight: 600; }

/* ── Barras ── */
.dpm-seg { display: flex; width: 100%; border-radius: 6px; overflow: hidden; gap: 2px; }
.dpm-seg > div { height: 100%; }
.dpm-track { height: 10px; border-radius: 5px; background: var(--bg-surface-3); overflow: hidden; }
.dpm-fill { height: 100%; background: #1E9E3A; border-radius: 5px; }

/* ── Filas etiqueta · número ── */
.dpm-filas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-fila { display: flex; align-items: center; gap: 10px; min-height: 34px; font-size: 14px; }
.dpm-fila-l { color: var(--text-secondary); flex: 1; }
.dpm-fila-sub { color: var(--text-muted); }
.dpm-fila-n { font-size: 16px; font-weight: 700; white-space: nowrap; }

/* ── Alertas ── */
.dpm-alertas { display: flex; flex-direction: column; gap: 8px; }
.dpm-alerta {
  display: flex; align-items: center; gap: 12px;
  border: 1px solid; border-radius: 12px; padding: 12px 12px 12px 14px; min-height: 68px;
  text-decoration: none; color: inherit;
}
.dpm-alerta:active { transform: scale(0.99); }
.dpm-alerta-n { font-size: 32px; font-weight: 700; line-height: 1; min-width: 40px; text-align: center; flex-shrink: 0; }
.dpm-alerta-body { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dpm-alerta-l { font-size: 15px; font-weight: 600; line-height: 1.3; }
.dpm-alerta-d { font-size: 14px; color: var(--text-secondary); }
.dpm-alerta-btn { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; min-height: 44px; min-width: 56px; padding: 0 12px; background: #fff; border: 1px solid; border-radius: 10px; font-size: 15px; font-weight: 700; }
.dpm-vacio { align-items: center; text-align: center; padding: 22px 16px 20px; gap: 4px; }
.dpm-vacio-t { font-size: 22px; font-weight: 700; margin-top: 4px; }
.dpm-vacio-s { font-size: 14px; color: var(--text-muted); }
.dpm-mock { align-self: center; min-height: 44px; padding: 0 12px; border: none; background: transparent; font-family: inherit; font-size: 14px; color: var(--accent); font-weight: 600; cursor: pointer; }
.dpm-mock span { color: var(--text-muted); font-weight: 400; }

/* ── Seis meses, a lo ancho ── */
.dpm-meses { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; align-items: end; margin-top: 4px; }
.dpm-mes { text-align: center; }
.dpm-mes-barras { display: flex; align-items: flex-end; justify-content: center; gap: 3px; height: 56px; }
.dpm-mes-barra { width: 10px; border-radius: 3px 3px 0 0; min-height: 3px; }
.dpm-mes-l { font-size: 14px; color: var(--text-muted); margin-top: 6px; }
.dpm-mes-neto { font-size: 14px; font-weight: 700; }
.dpm-leyenda { display: flex; gap: 14px; font-size: 14px; color: var(--text-muted); align-items: center; }
.dpm-leyenda span { display: inline-flex; align-items: center; gap: 6px; }
.dpm-leyenda i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.dpm-leyenda-nota { margin-left: auto; }

/* ── Urgentes ── */
.dpm-urgentes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-urgente { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 0; border-top: 1px solid var(--border); text-decoration: none; color: inherit; }
.dpm-urgentes li:first-child .dpm-urgente { border-top: 0; }
.dpm-urgente-body { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dpm-urgente-nombre { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dpm-urgente-causa { font-size: 14px; color: var(--text-muted); }
.dpm-urgente-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 14px; color: var(--text-secondary); max-width: 40%; }
.dpm-urgente-profe { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.dpm-urgente-dias { color: var(--text-muted); white-space: nowrap; }
.dpm-urgente-chev { color: var(--text-muted); flex-shrink: 0; }

/* ── Navegación inferior fija, respetando la zona segura del iPhone ── */
.dpm-nav {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  height: calc(64px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: #fff; border-top: 1px solid var(--border);
}
.dpm-nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 44px; text-decoration: none; color: var(--text-muted); }
.dpm-nav-item.is-active { color: var(--accent); }
.dpm-nav-icon { position: relative; display: inline-flex; }
.dpm-nav-badge { position: absolute; top: -6px; right: -12px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #FFC400; color: #3d3000; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.dpm-nav-label { font-size: 12px; font-weight: 600; letter-spacing: 0.01em; }
`;
