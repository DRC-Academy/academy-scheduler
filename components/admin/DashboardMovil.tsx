'use client';

// DASHBOARD EN EL TELÉFONO (por debajo de 768 px).
//
// Rediseño de septiembre de 2026 con una sola pregunta en la cabeza: "¿cómo
// viene el mes?". Lo que hay que resolver hoy (las colas de "Requiere acción")
// se quedó en el escritorio a pedido del admin, igual que cupos por franja,
// conflictos de datos, uso de IA, ranking de profesores, emails de
// presentación y las herramientas de mantenimiento.
//
// NO calcula nada. Recibe en `datos` los números que arma DashboardGeneral
// (una sola pasada por las finanzas, una sola carga de los extras) y acá solo
// se decide cómo se ven. Si un número difiere entre el teléfono y el
// escritorio, el fallo está en DashboardGeneral o en lib/dashboardMetrics.
//
// Reglas de la pantalla:
//   · De 320 a 767 px NADA se desliza en horizontal. Solo scroll vertical.
//   · Una sola columna; pares 2×N solo para dos cifras cortas.
//   · Ningún texto se corta ni desborda: las etiquetas parten en dos líneas y
//     los nombres largos se recortan con puntos suspensivos.
//   · Zonas táctiles ≥ 44 px. Cuerpo 14–15 px, cifras principales 32 px.
//   · Rojo solo para urgencias reales.
//   · La barra de la app (logo, campana, menú) se conserva arriba: es la única
//     vía al resto de rutas y a "Salir". Abajo, navegación fija con las cuatro
//     entradas que el admin usa desde el teléfono.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Settings, Users, Wallet, ChevronRight } from 'lucide-react';
import type { DateRange, MovimientoMes, OrigenActivos } from '@/lib/dashboardMetrics';
import type { RiesgoResumen } from '@/lib/dashboardExtras';

// ─── Lo que recibe ───────────────────────────────────────────────────────────

export interface DashboardDatos {
  ahora: Date;
  cargandoExtras: boolean;
  alumnos: { conClase: number; total: number };
  origen: OrigenActivos;
  /** Seis meses, el actual al final. Las bajas llegan con los extras. */
  movimiento: MovimientoMes[];
  finanzas: { total: number; pagable: number; pendiente: number };
  semana: DateRange;
  clasesSemana: number;
  programadas: number;
  faltasSinAvisoMes: number;
  riesgo: RiesgoResumen;
  urgentes: Array<{ alumno: string; profe: string; causa: string; dias: number | null }>;
  /** Contador de la barra inferior (Finanzas). null mientras carga. */
  solicitudesRevision: number | null;
}

// ─── Piezas ──────────────────────────────────────────────────────────────────

/** "8.420 €", con el punto de miles que en el teléfono se lee mejor. */
const num = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const eur = (n: number) => `${num(n)} €`;

function fechaLarga(d: Date): string {
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 'YYYY-MM' → 'Sep'. */
function mesCorto(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const s = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('es-ES', { month: 'short', timeZone: 'UTC' }).replace('.', '');
  return s.charAt(0).toUpperCase() + s.slice(1, 3);
}

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
function Segmentada({ partes }: { partes: Array<{ n: number; color: string }> }) {
  const total = partes.reduce((s, p) => s + p.n, 0);
  return (
    <div className="dpm-seg" aria-hidden>
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

// ─── 1 · Alumnos activos ─────────────────────────────────────────────────────

function AlumnosActivos({ d }: { d: DashboardDatos }) {
  const partes = [
    { label: 'Suscripción', n: d.origen.suscripcion, color: '#1E9E3A' },
    { label: 'Manual',      n: d.origen.manual,      color: '#2563eb' },
    { label: 'Oritalk',     n: d.origen.oritalk,     color: '#FFC400' },
  ];
  const total = partes.reduce((s, p) => s + p.n, 0);
  return (
    <Bloque titulo="Alumnos con clase" href="/students">
      <div className="adm-card dpm-card">
        <div className="dpm-cifra">
          <span className="dpm-cifra-n">{num(d.alumnos.conClase)}</span>
          <span className="dpm-cifra-l">con clase de {num(d.alumnos.total)} en la base</span>
        </div>
        <Segmentada partes={partes} />
        <ul className="dpm-filas">
          {partes.map(p => (
            <Fila key={p.label} color={p.color} label={p.label} n={p.n}
              sub={total > 0 ? `${Math.round((p.n / total) * 100)} %` : undefined} />
          ))}
        </ul>
        <p className="dpm-nota">Por origen del acceso: Oritalk o activación manual vigentes; el resto, suscripción.</p>
      </div>
    </Bloque>
  );
}

// ─── 2 · Este mes ────────────────────────────────────────────────────────────

function EsteMes({ d }: { d: DashboardDatos }) {
  const actual = d.movimiento[d.movimiento.length - 1];
  const bajasListas = !d.cargandoExtras;
  const neto = actual.altas - actual.bajas;
  const max = Math.max(1, ...d.movimiento.flatMap(m => [m.altas, m.bajas]));
  return (
    <Bloque titulo="Este mes">
      <div className="adm-card dpm-card">
        <div className="dpm-par">
          <div className="dpm-par-item">
            <span className="dpm-par-n" style={{ color: '#167A2D' }}>+{actual.altas}</span>
            <span className="dpm-par-l">altas</span>
          </div>
          <div className="dpm-par-item">
            <span className="dpm-par-n" style={{ color: 'var(--text-secondary)' }}>{bajasListas ? `−${actual.bajas}` : '·'}</span>
            <span className="dpm-par-l">bajas</span>
          </div>
        </div>
        {bajasListas && (
          <div className="dpm-neto" style={{ color: neto < 0 ? '#B42318' : '#167A2D' }}>
            {neto >= 0 ? '+' : ''}{neto} alumnos netos en {mesCorto(actual.mes).toLowerCase()}
          </div>
        )}

        {/* Seis meses a lo ancho de la tarjeta: seis columnas iguales, nunca más anchas que ella. */}
        <div className="dpm-meses" aria-label="Altas y bajas de los últimos seis meses">
          {d.movimiento.map(m => {
            const n = m.altas - m.bajas;
            return (
              <div key={m.mes} className="dpm-mes">
                <div className="dpm-mes-barras">
                  <div className="dpm-mes-barra" style={{ height: `${(m.altas / max) * 100}%`, background: '#1E9E3A' }} />
                  <div className="dpm-mes-barra" style={{ height: `${(m.bajas / max) * 100}%`, background: '#C8C8C0' }} />
                </div>
                <div className="dpm-mes-l">{mesCorto(m.mes)}</div>
                <div className="dpm-mes-neto" style={{ color: n < 0 ? '#B42318' : '#167A2D' }}>{bajasListas ? `${n >= 0 ? '+' : ''}${n}` : '·'}</div>
              </div>
            );
          })}
        </div>
        <div className="dpm-leyenda">
          <span><i style={{ background: '#1E9E3A' }} /> Altas</span>
          <span><i style={{ background: '#C8C8C0' }} /> Bajas</span>
          <span className="dpm-leyenda-nota">{mesCorto(actual.mes)} en curso</span>
        </div>
        <p className="dpm-nota">Alta = primera asignación del alumno en el mes. Baja = registrada en el mes.</p>
      </div>
    </Bloque>
  );
}

// ─── 3 · Finanzas del mes ────────────────────────────────────────────────────

function Finanzas({ d }: { d: DashboardDatos }) {
  const f = d.finanzas;
  return (
    <Bloque titulo="Finanzas del mes" href="/finanzas">
      <div className="adm-card dpm-card">
        <div className="dpm-cifra">
          <span className="dpm-cifra-n">{eur(f.total)}</span>
          <span className="dpm-cifra-l">a pagar a profesores, con bonus y penalizaciones</span>
        </div>
        <Segmentada partes={[{ n: f.pagable, color: '#1E9E3A' }, { n: f.pendiente, color: '#FFC400' }]} />
        <div className="dpm-par">
          <div className="dpm-par-item">
            <span className="dpm-par-n">{eur(f.pagable)}</span>
            <span className="dpm-par-l"><i className="dpm-punto" style={{ background: '#1E9E3A' }} />pagable</span>
          </div>
          <div className="dpm-par-item">
            <span className="dpm-par-n">{eur(f.pendiente)}</span>
            <span className="dpm-par-l"><i className="dpm-punto" style={{ background: '#FFC400' }} />pendiente</span>
          </div>
        </div>
        <p className="dpm-nota">Pendiente = a revisar más retenido. Hasta que se resuelva, el profesor no lo cobra.</p>
      </div>
    </Bloque>
  );
}

// ─── 4 · Clases de la semana ─────────────────────────────────────────────────

function Clases({ d }: { d: DashboardDatos }) {
  const pct = d.programadas > 0 ? Math.round((d.clasesSemana / d.programadas) * 100) : 0;
  return (
    <Bloque titulo="Clases de la semana" href="/admin?tab=classlog">
      <div className="adm-card dpm-card">
        <div className="dpm-cifra">
          <span className="dpm-cifra-n">{d.clasesSemana}<span className="dpm-cifra-de"> de {d.programadas}</span></span>
          <span className="dpm-cifra-l">dadas sobre las programadas · {pct}&nbsp;% · del {d.semana.from.slice(8)} al {d.semana.to.slice(8)}</span>
        </div>
        <div className="dpm-track" aria-hidden><div className="dpm-fill" style={{ width: `${pct}%` }} /></div>
        <ul className="dpm-filas" style={{ marginTop: 6 }}>
          <Fila color="#dc4a38" label="Faltas sin aviso este mes" n={d.faltasSinAvisoMes} />
        </ul>
      </div>
    </Bloque>
  );
}

// ─── 5 · Riesgo de baja ──────────────────────────────────────────────────────

function Riesgo({ d }: { d: DashboardDatos }) {
  const { rojo, verde } = d.riesgo;
  const total = rojo + verde;
  const pct = total > 0 ? Math.round((rojo / total) * 100) : 0;
  return (
    <Bloque titulo="Riesgo de baja" href="/admin?tab=ai" cta="Ver todos">
      <div className="adm-card dpm-card">
        {d.cargandoExtras ? <div className="dpm-nota" style={{ margin: 0 }}>Cargando…</div> : total === 0 ? (
          <div className="dpm-nota" style={{ margin: 0 }}>Todavía no hay clases analizadas.</div>
        ) : (
          <>
            <div className="dpm-cifra">
              <span className="dpm-cifra-n" style={{ color: '#B42318' }}>{rojo}</span>
              <span className="dpm-cifra-l">en rojo · {pct}&nbsp;% de los analizados</span>
            </div>
            {/* Dos niveles, no tres: desde julio de 2026 la IA clasifica en verde o rojo. */}
            <Segmentada partes={[{ n: verde, color: '#1E9E3A' }, { n: rojo, color: '#dc4a38' }]} />
            <ul className="dpm-filas">
              <Fila color="#1E9E3A" label="Sin señales" n={verde} />
              <Fila color="#dc4a38" label="Con alerta abierta" n={rojo} />
            </ul>
          </>
        )}
      </div>

      {!d.cargandoExtras && d.urgentes.length > 0 && (
        <div className="adm-card dpm-card dpm-card-lista">
          <div className="dpm-card-head">Los más urgentes</div>
          <ul className="dpm-urgentes">
            {d.urgentes.slice(0, 3).map((u, i) => (
              <li key={`${u.alumno}-${i}`}>
                <Link href="/admin?tab=ai" className="dpm-urgente">
                  <span className="dpm-urgente-body">
                    <span className="dpm-urgente-nombre">{u.alumno}</span>
                    <span className="dpm-urgente-causa">{u.causa}</span>
                  </span>
                  <span className="dpm-urgente-meta">
                    <span className="dpm-urgente-profe">{u.profe}</span>
                    {u.dias != null && <span className="dpm-urgente-dias">hace {u.dias} d</span>}
                  </span>
                  <ChevronRight size={18} strokeWidth={2} aria-hidden className="dpm-urgente-chev" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Bloque>
  );
}

// ─── Navegación inferior ─────────────────────────────────────────────────────

/**
 * Las cuatro entradas que el admin usa desde el teléfono. Inicio es esta misma
 * pantalla; Admin es donde aterrizan las validaciones y el riesgo; Alumnos es
 * donde se busca a alguien cuando escribe o llama; Finanzas es la única entrada
 * de la barra de arriba que lleva contador (solicitudes de revisión). Buscar
 * (setter) y Próximos a cancelar siguen en el menú de arriba.
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
        <AlumnosActivos d={datos} />
        <EsteMes d={datos} />
        <Finanzas d={datos} />
        <Clases d={datos} />
        <Riesgo d={datos} />
      </div>
      <NavInferior revisiones={datos.solicitudesRevision} />
      <style>{ESTILOS}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Estilos de la vista móvil, con prefijo `dpm-`. Mismos colores y tokens que la
// app; nada de esto toca otra pantalla. Nada tiene ancho mínimo ni fijo mayor
// que la pantalla: a 320 px todo sigue en una columna.
// ─────────────────────────────────────────────────────────────────────────────

const ESTILOS = `
.dpm { font-size: 14px; line-height: 1.45; color: var(--text-primary); overflow-wrap: anywhere; }
.dpm a { -webkit-tap-highlight-color: rgba(30,158,58,0.15); }
.dpm * { box-sizing: border-box; min-width: 0; }
.dpm-fecha { margin: 0 0 12px 2px; font-size: 14px; font-weight: 600; color: var(--text-secondary); }
.dpm-main { display: flex; flex-direction: column; gap: 18px; padding-bottom: calc(64px + env(safe-area-inset-bottom)); }

/* ── Bloques ── */
.dpm-bloque { display: flex; flex-direction: column; gap: 8px; }
.dpm-bloque-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; padding: 0 2px; }
.dpm-h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
.dpm-link { display: inline-flex; align-items: center; gap: 2px; min-height: 44px; padding: 0 4px 0 8px; font-size: 14px; font-weight: 600; color: var(--accent); text-decoration: none; white-space: nowrap; }

.dpm-card { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dpm-card-lista { gap: 0; padding-bottom: 6px; }
.dpm-card-head { font-size: 14px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px; }
.dpm-nota { margin: 2px 0 0; font-size: 14px; color: var(--text-muted); line-height: 1.45; }

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
.dpm-seg { display: flex; width: 100%; height: 12px; border-radius: 6px; overflow: hidden; gap: 2px; background: var(--bg-surface-3); }
.dpm-seg > div { height: 100%; }
.dpm-track { height: 10px; border-radius: 5px; background: var(--bg-surface-3); overflow: hidden; }
.dpm-fill { height: 100%; background: #1E9E3A; border-radius: 5px; }

/* ── Filas etiqueta · número ── */
.dpm-filas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpm-fila { display: flex; align-items: center; gap: 10px; min-height: 34px; font-size: 14px; }
.dpm-fila-l { color: var(--text-secondary); flex: 1; }
.dpm-fila-sub { color: var(--text-muted); }
.dpm-fila-n { font-size: 16px; font-weight: 700; white-space: nowrap; }

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
.dpm-urgente-causa { font-size: 14px; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dpm-urgente-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 14px; color: var(--text-secondary); max-width: 40%; }
.dpm-urgente-profe { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.dpm-urgente-dias { color: var(--text-muted); white-space: nowrap; }
.dpm-urgente-chev { color: var(--text-muted); flex-shrink: 0; }

/* ── Navegación inferior fija, respetando la zona segura del iPhone ── */
.dpm-nav { position: fixed; bottom: 0; left: 0; right: 0; z-index: 39; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); height: calc(64px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); background: #fff; border-top: 1px solid var(--border); }
.dpm-nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 44px; text-decoration: none; color: var(--text-muted); }
.dpm-nav-item.is-active { color: var(--accent); }
.dpm-nav-icon { position: relative; display: inline-flex; }
.dpm-nav-badge { position: absolute; top: -6px; right: -12px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #FFC400; color: #3d3000; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.dpm-nav-label { font-size: 12px; font-weight: 600; letter-spacing: 0.01em; }
`;
