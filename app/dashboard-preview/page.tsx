'use client';

// MAQUETA del dashboard nuevo. TODO lo que se ve son DATOS DE EJEMPLO.
//
// No lee nada de Supabase ni del contexto: los números están escritos a mano más
// abajo, en un solo bloque, para que se vea la forma de la pantalla antes de
// decidir qué se conecta. La propuesta bloque por bloque —de dónde saldría cada
// dato de verdad y qué cuesta— está en docs/dashboard-propuesta.md.
//
// NO toca ninguna pantalla existente. Cuando el diseño se apruebe, esto se
// reemplaza por la versión conectada y la página se borra.
//
// Los enlaces "Ver detalle" SÍ son reales: llevan a la pestaña o pantalla que
// hoy tiene ese dato, para poder comprobar de un clic que cada bloque tiene un
// sitio al que ir.

import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';

// ─────────────────────────────────────────────────────────────────────────────
// DATOS DE EJEMPLO. Nada de acá sale de la base.
// Los valores están elegidos para parecerse a la academia real (≈30 profesores,
// ≈170 alumnos) y para que se vean los tres estados de cada semáforo.
// ─────────────────────────────────────────────────────────────────────────────

const HOY = new Date();

const RESUMEN = {
  alumnosActivos: 168,
  alumnosTotales: 191,
  profesoresActivos: 27,
  profesoresTotales: 30,
  clasesSemana: 214,
  clasesSemanaProgramadas: 231,
  costeProfesoresMes: 8420,
  costeProfesoresMesAnterior: 7960,
  ocupacion: 78,          // clases confirmadas / cupos totales
};

/** Lo que hay que resolver hoy. `tono` decide el semáforo. */
const ACCIONES = [
  { n: 14, label: 'Validaciones pendientes',        detalle: 'la más antigua, 6 días',      href: '/admin?tab=validacion',            tono: 'rojo' },
  { n: 3,  label: 'Emails de presentación tarde',   detalle: 'más de 24 h sin enviar',      href: '/admin?tab=emails&filter=overdue', tono: 'rojo' },
  { n: 9,  label: 'Alumnos en riesgo',              detalle: 'sin intervención registrada', href: '/admin?tab=ai',                    tono: 'rojo' },
  { n: 22, label: 'Transcripts sin subir',          detalle: 'clases con acceso registrado', href: '/admin?tab=tracking',             tono: 'amarillo' },
  { n: 6,  label: 'Próximos a cancelar sin contactar', detalle: 'les quedan menos de 7 días', href: '/proximos-cancelar',             tono: 'amarillo' },
  { n: 4,  label: 'Solicitudes de revisión',        detalle: 'clases que el profe no cobra', href: '/finanzas',                       tono: 'amarillo' },
  { n: 2,  label: 'Alumnos sin profesor',           detalle: 'alta sin asignar',            href: '/dashboard',                       tono: 'amarillo' },
  { n: 0,  label: 'Análisis de IA fallidos',        detalle: 'sin reintentar',              href: '/admin?tab=tracking',              tono: 'ok' },
];

const SUSCRIPCIONES = {
  porEstado: [
    { estado: 'active',         label: 'Activas',            n: 141, acceso: true },
    { estado: 'pending-cancel', label: 'Cancelan al final',  n: 12,  acceso: true },
    { estado: 'on-hold',        label: 'En pausa',           n: 7,   acceso: false },
    { estado: 'pending',        label: 'Pendientes de pago', n: 4,   acceso: false },
    { estado: 'cancelled',      label: 'Canceladas',         n: 38,  acceso: false },
  ],
  porOrigen: [
    { origen: 'WooCommerce', n: 129, color: '#1E9E3A' },
    { origen: 'Manual',      n: 24,  color: '#2563eb' },
    { origen: 'Oritalk',     n: 15,  color: '#FFC400' },
  ],
};

/** Últimos 6 meses. `altas` y `bajas` del mes cerrado. */
const MOVIMIENTO = [
  { mes: 'Abr', altas: 18, bajas: 11 },
  { mes: 'May', altas: 15, bajas: 14 },
  { mes: 'Jun', altas: 21, bajas: 9  },
  { mes: 'Jul', altas: 12, bajas: 16 },
  { mes: 'Ago', altas: 17, bajas: 12 },
  { mes: 'Sep', altas: 9,  bajas: 5  },
];

/** Embudo de captación: cada paso es un subconjunto del anterior. */
const EMBUDO_NIVEL = [
  { paso: 'Formulario enviado',  n: 96 },
  { paso: 'Formulario completo', n: 71 },
  { paso: 'Test de nivel hecho', n: 45 },
  { paso: 'Primera clase dada',  n: 38 },
];

const RIESGO = {
  verde: 152,
  rojo: 16,
  urgentes: [
    { alumno: 'Laura Villegas',   profe: 'Johny',     causa: 'Dos faltas seguidas sin aviso',       dias: 12 },
    { alumno: 'Mohamed Al Hakeue', profe: 'Silvia',   causa: 'Pidió bajar la frecuencia',           dias: 9  },
    { alumno: 'Alba Rodríguez',   profe: 'Milagros',  causa: 'Desmotivación detectada en clase',    dias: 7  },
    { alumno: 'Carles Aliaga',    profe: 'Cristian',  causa: 'Plan termina y no renovó',            dias: 5  },
    { alumno: 'Elena Tapia',      profe: 'Wanda',     causa: 'Tres clases seguidas canceladas',     dias: 3  },
  ],
};

const OPERACION = {
  dadas: 198,
  programadas: 231,
  faltasSinAviso: 7,
  recuperacionesPendientes: 11,
  clases2h: 34,
  franjas: [
    { franja: '08–11', ocupados: 22, libres: 6  },
    { franja: '11–14', ocupados: 31, libres: 3  },
    { franja: '14–17', ocupados: 28, libres: 9  },
    { franja: '17–20', ocupados: 44, libres: 2  },
    { franja: '20–23', ocupados: 19, libres: 14 },
  ],
};

const PROFESORES = [
  { nombre: 'Johny',     clases: 46, cuposLibres: 0, transcriptsTarde: 0, usaIA: true  },
  { nombre: 'Silvia',    clases: 41, cuposLibres: 2, transcriptsTarde: 3, usaIA: true  },
  { nombre: 'Milagros',  clases: 38, cuposLibres: 1, transcriptsTarde: 0, usaIA: false },
  { nombre: 'Cristian',  clases: 35, cuposLibres: 4, transcriptsTarde: 7, usaIA: false },
  { nombre: 'Wanda',     clases: 33, cuposLibres: 3, transcriptsTarde: 1, usaIA: true  },
  { nombre: 'Victoria',  clases: 29, cuposLibres: 6, transcriptsTarde: 0, usaIA: false },
];

const IA = { usan: 11, total: 30 };

const FINANZAS = {
  totalAPagar: 8420,
  montoPagable: 7310,
  montoARevisar: 890,
  montoRetenido: 220,
  bonus: 340,
  penalizaciones: -120,
  mesAnterior: 7960,
  profesoresPagados: 6,
  profesoresTotales: 30,
};

// ─────────────────────────────────────────────────────────────────────────────

const TONO: Record<string, { fg: string; bg: string; bd: string; dot: string }> = {
  rojo:     { fg: '#B42318', bg: 'rgba(220,74,56,0.08)',  bd: 'rgba(220,74,56,0.30)',  dot: '#dc4a38' },
  amarillo: { fg: '#8a6d00', bg: 'rgba(255,196,0,0.12)',  bd: 'rgba(255,196,0,0.45)',  dot: '#FFC400' },
  ok:       { fg: '#167A2D', bg: 'rgba(22,122,45,0.07)',  bd: 'rgba(22,122,45,0.22)',  dot: '#1E9E3A' },
};

const eur = (n: number) => `${n.toLocaleString('es-ES')} €`;

function fechaLarga(d: Date): string {
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Cabecera de sección con su enlace al detalle real. */
function SecHead({ title, sub, href, cta = 'Ver detalle' }: {
  title: string; sub?: string; href?: string; cta?: string;
}) {
  return (
    <div className="dpv-sechead">
      <div>
        <h2 className="dpv-h2">{title}</h2>
        {sub && <p className="dpv-sub">{sub}</p>}
      </div>
      {href && <Link href={href} className="dpv-link">{cta} <span aria-hidden>›</span></Link>}
    </div>
  );
}

// ─── 1 · Barra superior ──────────────────────────────────────────────────────

function Cabecera() {
  const deltaCoste = RESUMEN.costeProfesoresMes - RESUMEN.costeProfesoresMesAnterior;
  const kpis = [
    { label: 'Alumnos activos',   valor: String(RESUMEN.alumnosActivos),   pie: `de ${RESUMEN.alumnosTotales} en la base` },
    { label: 'Profesores activos', valor: String(RESUMEN.profesoresActivos), pie: `de ${RESUMEN.profesoresTotales}` },
    { label: 'Clases esta semana', valor: String(RESUMEN.clasesSemana),    pie: `${RESUMEN.clasesSemanaProgramadas} programadas` },
    { label: 'Coste profesores',  valor: eur(RESUMEN.costeProfesoresMes),  pie: `${deltaCoste >= 0 ? '+' : ''}${eur(deltaCoste)} vs. mes anterior` },
    { label: 'Ocupación',         valor: `${RESUMEN.ocupacion} %`,         pie: 'clases sobre cupos', barra: RESUMEN.ocupacion },
  ];

  return (
    <header className="dpv-top">
      <div className="dpv-greet">
        <h1 className="dpv-h1">Buenos días, Facundo</h1>
        <p className="dpv-date">{fechaLarga(HOY)}</p>
      </div>
      <div className="dpv-kpis">
        {kpis.map(k => (
          <div key={k.label} className="dpv-kpi">
            <div className="dpv-kpi-label">{k.label}</div>
            <div className="dpv-kpi-value">{k.valor}</div>
            {k.barra != null && (
              <div className="dpv-track" aria-hidden>
                <div className="dpv-fill" style={{ width: `${k.barra}%` }} />
              </div>
            )}
            <div className="dpv-kpi-pie">{k.pie}</div>
          </div>
        ))}
      </div>
    </header>
  );
}

// ─── 2 · Requiere acción ─────────────────────────────────────────────────────

function RequiereAccion() {
  const pendientes = ACCIONES.filter(a => a.n > 0).length;
  return (
    <section className="dpv-sec">
      <SecHead
        title="Requiere acción hoy"
        sub={pendientes === 0 ? 'Nada pendiente.' : `${pendientes} cosas esperando a alguien.`}
      />
      <div className="dpv-actions">
        {ACCIONES.map(a => {
          const t = TONO[a.tono];
          const vacio = a.n === 0;
          return (
            <Link key={a.label} href={a.href} className="dpv-action"
              style={{ background: vacio ? 'var(--bg-surface)' : t.bg, borderColor: vacio ? 'var(--border)' : t.bd }}>
              <div className="dpv-action-n" style={{ color: vacio ? 'var(--text-muted)' : t.fg }}>
                {vacio ? '—' : a.n}
              </div>
              <div className="dpv-action-body">
                <div className="dpv-action-label">{a.label}</div>
                <div className="dpv-action-detalle">{vacio ? 'Nada pendiente' : a.detalle}</div>
              </div>
              <span aria-hidden className="dpv-action-arrow">›</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// ─── 3 · Salud del negocio ───────────────────────────────────────────────────

function BarrasMovimiento() {
  const max = Math.max(...MOVIMIENTO.flatMap(m => [m.altas, m.bajas]));
  return (
    <div className="dpv-months">
      {MOVIMIENTO.map(m => (
        <div key={m.mes} className="dpv-month">
          <div className="dpv-month-bars">
            <div className="dpv-bar dpv-bar-up"   style={{ height: `${(m.altas / max) * 100}%` }} title={`${m.altas} altas`} />
            <div className="dpv-bar dpv-bar-down" style={{ height: `${(m.bajas / max) * 100}%` }} title={`${m.bajas} bajas`} />
          </div>
          <div className="dpv-month-label">{m.mes}</div>
          <div className="dpv-month-net" style={{ color: m.altas >= m.bajas ? '#167A2D' : '#B42318' }}>
            {m.altas - m.bajas >= 0 ? '+' : ''}{m.altas - m.bajas}
          </div>
        </div>
      ))}
    </div>
  );
}

function SaludNegocio() {
  const totalOrigen = SUSCRIPCIONES.porOrigen.reduce((s, o) => s + o.n, 0);
  const maxEmbudo = EMBUDO_NIVEL[0].n;

  return (
    <section className="dpv-sec">
      <SecHead title="Salud del negocio" sub="Suscripciones, movimiento de alumnos y captación." href="/students" />
      <div className="dpv-grid3">

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Suscripciones por estado</div>
          <ul className="dpv-list">
            {SUSCRIPCIONES.porEstado.map(s => (
              <li key={s.estado} className="dpv-list-row">
                <span className="adm-dot" style={{ background: s.acceso ? '#1E9E3A' : '#C8C8C0' }} />
                <span className="dpv-list-label">{s.label}</span>
                <span className="dpv-list-n">{s.n}</span>
              </li>
            ))}
          </ul>
          <p className="dpv-note">El punto verde marca los estados que dan acceso a clase.</p>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Alumnos activos por origen</div>
          <div className="dpv-stack" aria-hidden>
            {SUSCRIPCIONES.porOrigen.map(o => (
              <div key={o.origen} className="dpv-stack-seg"
                style={{ width: `${(o.n / totalOrigen) * 100}%`, background: o.color }} title={`${o.origen}: ${o.n}`} />
            ))}
          </div>
          <ul className="dpv-list">
            {SUSCRIPCIONES.porOrigen.map(o => (
              <li key={o.origen} className="dpv-list-row">
                <span className="adm-dot" style={{ background: o.color }} />
                <span className="dpv-list-label">{o.origen}</span>
                <span className="dpv-list-n">{o.n}</span>
              </li>
            ))}
          </ul>
          <p className="dpv-note">Un alumno cuenta en un solo origen: Oritalk, luego manual, luego suscripción.</p>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Altas y bajas · 6 meses</div>
          <BarrasMovimiento />
          <div className="dpv-legend">
            <span><i className="dpv-swatch" style={{ background: '#1E9E3A' }} /> Altas</span>
            <span><i className="dpv-swatch" style={{ background: '#dc4a38' }} /> Bajas</span>
          </div>
        </div>
      </div>

      <div className="adm-card dpv-card" style={{ marginTop: 14 }}>
        <div className="dpv-card-head">
          Captación
          <Link href="/admin?tab=leveltests" className="dpv-link dpv-link-sm">Tests de nivel ›</Link>
        </div>
        <div className="dpv-funnel">
          {EMBUDO_NIVEL.map((p, i) => {
            const previo = i === 0 ? p.n : EMBUDO_NIVEL[i - 1].n;
            const caida = previo - p.n;
            return (
              <div key={p.paso} className="dpv-funnel-row">
                <div className="dpv-funnel-label">{p.paso}</div>
                <div className="dpv-funnel-track">
                  <div className="dpv-funnel-fill" style={{ width: `${(p.n / maxEmbudo) * 100}%` }}>
                    <span className="dpv-funnel-n">{p.n}</span>
                  </div>
                </div>
                <div className="dpv-funnel-drop">{i === 0 ? '' : `−${caida}`}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ─── 4 · Riesgo de baja ──────────────────────────────────────────────────────

function Riesgo() {
  const total = RIESGO.verde + RIESGO.rojo;
  const pctRojo = Math.round((RIESGO.rojo / total) * 100);

  return (
    <section className="dpv-sec">
      <SecHead title="Riesgo de baja" sub="La IA clasifica cada clase en verde o rojo. No hay nivel intermedio." href="/admin?tab=ai" />
      <div className="dpv-grid-risk">

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Reparto</div>
          <div className="dpv-risk-figure">
            <div className="dpv-risk-big" style={{ color: '#B42318' }}>{RIESGO.rojo}</div>
            <div className="dpv-risk-cap">en rojo · {pctRojo}% del alumnado</div>
          </div>
          <div className="dpv-stack" aria-hidden style={{ marginTop: 14 }}>
            <div className="dpv-stack-seg" style={{ width: `${100 - pctRojo}%`, background: '#1E9E3A' }} />
            <div className="dpv-stack-seg" style={{ width: `${pctRojo}%`, background: '#dc4a38' }} />
          </div>
          <ul className="dpv-list" style={{ marginTop: 10 }}>
            <li className="dpv-list-row">
              <span className="adm-dot" style={{ background: '#1E9E3A' }} />
              <span className="dpv-list-label">Sin señales</span><span className="dpv-list-n">{RIESGO.verde}</span>
            </li>
            <li className="dpv-list-row">
              <span className="adm-dot" style={{ background: '#dc4a38' }} />
              <span className="dpv-list-label">Con alerta abierta</span><span className="dpv-list-n">{RIESGO.rojo}</span>
            </li>
          </ul>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Los cinco más urgentes</div>
          <ul className="dpv-urgent">
            {RIESGO.urgentes.map(u => (
              <li key={u.alumno} className="dpv-urgent-row">
                <span className="adm-dot" style={{ background: '#dc4a38', marginTop: 6 }} />
                <div className="dpv-urgent-body">
                  <div className="dpv-urgent-name">{u.alumno}</div>
                  <div className="dpv-urgent-causa">{u.causa}</div>
                </div>
                <div className="dpv-urgent-meta">
                  <div>{u.profe}</div>
                  <div className="dpv-urgent-dias">hace {u.dias} d</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── 5 · Operación de clases ─────────────────────────────────────────────────

function Operacion() {
  const pct = Math.round((OPERACION.dadas / OPERACION.programadas) * 100);
  const maxFranja = Math.max(...OPERACION.franjas.map(f => f.ocupados + f.libres));

  return (
    <section className="dpv-sec">
      <SecHead title="Operación de clases" sub="Esta semana y lo que arrastra el mes." href="/admin?tab=classlog" />
      <div className="dpv-grid-op">

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Dadas sobre programadas</div>
          <div className="dpv-op-big">
            {OPERACION.dadas}<span className="dpv-op-of"> / {OPERACION.programadas}</span>
          </div>
          <div className="dpv-track" aria-hidden><div className="dpv-fill" style={{ width: `${pct}%` }} /></div>
          <p className="dpv-note">{pct}% de lo programado se dio. Las {OPERACION.programadas - OPERACION.dadas} restantes están sin registrar o se cancelaron.</p>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Del mes</div>
          <ul className="dpv-list">
            <li className="dpv-list-row">
              <span className="adm-dot" style={{ background: '#dc4a38' }} />
              <span className="dpv-list-label">Faltas sin aviso</span><span className="dpv-list-n">{OPERACION.faltasSinAviso}</span>
            </li>
            <li className="dpv-list-row">
              <span className="adm-dot" style={{ background: '#FFC400' }} />
              <span className="dpv-list-label">Recuperaciones pendientes</span><span className="dpv-list-n">{OPERACION.recuperacionesPendientes}</span>
            </li>
            <li className="dpv-list-row">
              <span className="adm-dot" style={{ background: '#2563eb' }} />
              <span className="dpv-list-label">Sesiones de 2 h</span><span className="dpv-list-n">{OPERACION.clases2h}</span>
            </li>
          </ul>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Cupos libres por franja</div>
          <div className="dpv-franjas">
            {OPERACION.franjas.map(f => {
              const total = f.ocupados + f.libres;
              return (
                <div key={f.franja} className="dpv-franja">
                  <div className="dpv-franja-label">{f.franja}</div>
                  <div className="dpv-franja-track" style={{ width: `${(total / maxFranja) * 100}%` }}>
                    <div className="dpv-franja-oc" style={{ width: `${(f.ocupados / total) * 100}%` }} />
                  </div>
                  <div className="dpv-franja-n">{f.libres}</div>
                </div>
              );
            })}
          </div>
          <p className="dpv-note">La parte clara es lo que queda libre. La franja de tarde está al tope.</p>
        </div>
      </div>
    </section>
  );
}

// ─── 6 · Profesores ──────────────────────────────────────────────────────────

function Profesores() {
  const max = Math.max(...PROFESORES.map(p => p.clases));
  return (
    <section className="dpv-sec">
      <SecHead title="Profesores" sub="Carga del mes, cupos y quién arrastra transcripts." href="/admin?tab=teachers" />
      <div className="dpv-grid-prof">

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Clases del mes</div>
          <ul className="dpv-rank">
            {PROFESORES.map(p => (
              <li key={p.nombre} className="dpv-rank-row">
                <span className="dpv-rank-name">{p.nombre}</span>
                <span className="dpv-rank-track">
                  <span className="dpv-rank-fill" style={{ width: `${(p.clases / max) * 100}%` }} />
                </span>
                <span className="dpv-rank-n">{p.clases}</span>
                <span className="dpv-rank-tags">
                  {p.cuposLibres > 0 && <span className="dpv-tag dpv-tag-ok">{p.cuposLibres} libres</span>}
                  {p.transcriptsTarde > 0 && <span className="dpv-tag dpv-tag-warn">{p.transcriptsTarde} sin subir</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">
            Uso de la IA
            <Link href="/admin?tab=aiusage" className="dpv-link dpv-link-sm">Ver detalle ›</Link>
          </div>
          <div className="dpv-op-big">{IA.usan}<span className="dpv-op-of"> / {IA.total}</span></div>
          <div className="dpv-track" aria-hidden>
            <div className="dpv-fill" style={{ width: `${(IA.usan / IA.total) * 100}%` }} />
          </div>
          <p className="dpv-note">
            Profesores que han generado alguna clase con IA. Los {IA.total - IA.usan} restantes no han usado la herramienta.
          </p>
          <ul className="dpv-chips">
            {PROFESORES.filter(p => !p.usaIA).map(p => <li key={p.nombre} className="dpv-chip">{p.nombre}</li>)}
            <li className="dpv-chip dpv-chip-more">y {IA.total - IA.usan - PROFESORES.filter(p => !p.usaIA).length} más</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── 7 · Finanzas ────────────────────────────────────────────────────────────

function Finanzas() {
  const delta = FINANZAS.totalAPagar - FINANZAS.mesAnterior;
  const pctDelta = Math.round((delta / FINANZAS.mesAnterior) * 100);
  const partes = [
    { label: 'Pagable',   n: FINANZAS.montoPagable,  color: '#1E9E3A' },
    { label: 'A revisar', n: FINANZAS.montoARevisar, color: '#FFC400' },
    { label: 'Retenido',  n: FINANZAS.montoRetenido, color: '#C8C8C0' },
  ];
  const totalPartes = partes.reduce((s, p) => s + p.n, 0);

  return (
    <section className="dpv-sec">
      <SecHead title="Finanzas del mes" sub="Lo que se le debe a los profesores." href="/finanzas" />
      <div className="dpv-grid-fin">

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Total a pagar</div>
          <div className="dpv-fin-big">{eur(FINANZAS.totalAPagar)}</div>
          <div className="dpv-fin-delta" style={{ color: delta >= 0 ? '#8a6d00' : '#167A2D' }}>
            {delta >= 0 ? '↑' : '↓'} {eur(Math.abs(delta))} ({pctDelta >= 0 ? '+' : ''}{pctDelta}%) vs. mes anterior
          </div>
          <p className="dpv-note">Incluye {eur(FINANZAS.bonus)} de bonus y {eur(FINANZAS.penalizaciones)} de penalizaciones.</p>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">En qué estado está</div>
          <div className="dpv-stack" aria-hidden>
            {partes.map(p => (
              <div key={p.label} className="dpv-stack-seg"
                style={{ width: `${(p.n / totalPartes) * 100}%`, background: p.color }} title={`${p.label}: ${eur(p.n)}`} />
            ))}
          </div>
          <ul className="dpv-list">
            {partes.map(p => (
              <li key={p.label} className="dpv-list-row">
                <span className="adm-dot" style={{ background: p.color }} />
                <span className="dpv-list-label">{p.label}</span>
                <span className="dpv-list-n">{eur(p.n)}</span>
              </li>
            ))}
          </ul>
          <p className="dpv-note">&quot;A revisar&quot; son clases que esperan validación: hasta que se resuelvan, el profesor no cobra.</p>
        </div>

        <div className="adm-card dpv-card">
          <div className="dpv-card-head">Pagos hechos</div>
          <div className="dpv-op-big">{FINANZAS.profesoresPagados}<span className="dpv-op-of"> / {FINANZAS.profesoresTotales}</span></div>
          <div className="dpv-track" aria-hidden>
            <div className="dpv-fill" style={{ width: `${(FINANZAS.profesoresPagados / FINANZAS.profesoresTotales) * 100}%` }} />
          </div>
          <p className="dpv-note">Profesores marcados como pagados este mes.</p>
        </div>
      </div>
    </section>
  );
}

// ─── 8 · Herramientas ────────────────────────────────────────────────────────

function Herramientas() {
  const tools = [
    'Auditoría de vínculos',
    'Sincronización calendario ↔ asignaciones',
    'Sincronización con WooCommerce',
    'Estilo de los textos de IA',
  ];
  return (
    <section className="dpv-sec">
      <SecHead title="Herramientas de mantenimiento" sub="Se quedan como están, plegadas al final." href="/dashboard" cta="Abrir las reales" />
      <div className="adm-card dpv-card">
        <ul className="dpv-tools">
          {tools.map(t => (
            <li key={t} className="dpv-tool">
              <span className="dpv-tool-name">{t}</span>
              <span aria-hidden className="dpv-tool-arrow">▾</span>
            </li>
          ))}
        </ul>
        <p className="dpv-note">En la maqueta no hacen nada: los paneles funcionales viven en /dashboard.</p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function PreviewContent() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div className="adm dpv">
        <div className="dpv-banner">
          <span className="adm-dot" style={{ background: '#FFC400' }} />
          <strong>Vista previa con datos de ejemplo.</strong>
          <span>Ningún número de esta pantalla sale de la base. Los enlaces sí son reales.</span>
        </div>

        <Cabecera />
        <RequiereAccion />
        <SaludNegocio />
        <Riesgo />
        <Operacion />
        <Profesores />
        <Finanzas />
        <Herramientas />
      </div>

      <style>{ESTILOS}</style>
    </div>
  );
}

export default function DashboardPreviewPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <PreviewContent />
    </AuthGuard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Estilos de la maqueta. Van en un bloque propio con prefijo `dpv-` para no
// tocar nada de lo que ya existe: se borra la página y no queda rastro.
// Colores de marca: verde #1E9E3A, amarillo #FFC400, azul #2563eb, fondo
// #F7F7F5. Para TEXTO y acciones se usan los tokens de la app (--accent es
// #167A2D, no el verde de marca, que no llega al contraste mínimo en tamaño
// pequeño).
// ─────────────────────────────────────────────────────────────────────────────

const ESTILOS = `
.dpv { max-width: 1240px; }

.dpv-banner {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  background: rgba(255,196,0,0.10); border: 1px solid rgba(255,196,0,0.45);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 22px;
  font-size: 13px; color: #5c4a00;
}

/* ── Cabecera ── */
.dpv-top { margin-bottom: 30px; }
.dpv-greet { margin-bottom: 18px; }
.dpv-h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin: 0; color: var(--text-primary); }
.dpv-date { margin: 3px 0 0; font-size: 13.5px; color: var(--text-muted); }

.dpv-kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.dpv-kpi {
  background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; padding: 14px 16px 15px;
}
.dpv-kpi-label { font-size: 11.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); }
.dpv-kpi-value { font-size: 27px; font-weight: 700; line-height: 1.15; margin-top: 5px; color: var(--text-primary); }
.dpv-kpi-pie { font-size: 11.5px; color: var(--text-muted); margin-top: 4px; }

.dpv-track { height: 6px; border-radius: 3px; background: var(--bg-surface-3); overflow: hidden; margin-top: 8px; }
.dpv-fill { height: 100%; background: #1E9E3A; border-radius: 3px; }

/* ── Secciones ── */
.dpv-sec { margin-bottom: 34px; }
.dpv-sechead { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.dpv-h2 { font-size: 17px; font-weight: 700; margin: 0; letter-spacing: -0.01em; color: var(--text-primary); }
.dpv-sub { margin: 2px 0 0; font-size: 13px; color: var(--text-muted); }
.dpv-link { font-size: 13px; font-weight: 600; color: var(--accent); text-decoration: none; white-space: nowrap; }
.dpv-link:hover { color: var(--accent-hover); text-decoration: underline; }
.dpv-link-sm { margin-left: auto; font-size: 12px; font-weight: 600; }

.dpv-card { padding: 16px 18px 18px; display: flex; flex-direction: column; }
.dpv-card-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 700; letter-spacing: 0.045em; text-transform: uppercase;
  color: var(--text-muted); margin-bottom: 12px;
}
.dpv-note { margin: 10px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }

/* ── Requiere acción ── */
.dpv-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.dpv-action {
  display: flex; align-items: center; gap: 12px;
  border: 1px solid; border-radius: 12px; padding: 13px 14px;
  text-decoration: none; color: inherit; transition: transform 0.12s ease;
}
.dpv-action:hover { transform: translateY(-1px); }
.dpv-action-n { font-size: 26px; font-weight: 700; line-height: 1; min-width: 34px; }
.dpv-action-body { min-width: 0; flex: 1; }
.dpv-action-label { font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.3; }
.dpv-action-detalle { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
.dpv-action-arrow { color: var(--text-muted); font-size: 17px; }

/* ── Rejillas ── */
.dpv-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.dpv-grid-risk { display: grid; grid-template-columns: 1fr 1.6fr; gap: 14px; }
.dpv-grid-op { display: grid; grid-template-columns: 1fr 1fr 1.3fr; gap: 14px; }
.dpv-grid-prof { display: grid; grid-template-columns: 1.7fr 1fr; gap: 14px; }
.dpv-grid-fin { display: grid; grid-template-columns: 1fr 1.3fr 1fr; gap: 14px; }

/* ── Listas ── */
.dpv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.dpv-list-row { display: flex; align-items: center; gap: 9px; font-size: 13px; }
.dpv-list-label { color: var(--text-secondary); }
.dpv-list-n { margin-left: auto; font-weight: 700; color: var(--text-primary); }

/* ── Barra apilada ── */
.dpv-stack { display: flex; height: 10px; border-radius: 5px; overflow: hidden; gap: 2px; margin-bottom: 12px; }
.dpv-stack-seg { height: 100%; }
.dpv-legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); margin-top: 12px; }
.dpv-legend span { display: inline-flex; align-items: center; gap: 6px; }
.dpv-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }

/* ── Altas y bajas ── */
.dpv-months { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; align-items: end; }
.dpv-month { text-align: center; }
.dpv-month-bars { display: flex; align-items: flex-end; justify-content: center; gap: 3px; height: 88px; }
.dpv-bar { width: 13px; border-radius: 3px 3px 0 0; min-height: 3px; }
.dpv-bar-up { background: #1E9E3A; }
.dpv-bar-down { background: #dc4a38; }
.dpv-month-label { font-size: 11px; color: var(--text-muted); margin-top: 6px; }
.dpv-month-net { font-size: 11.5px; font-weight: 700; }

/* ── Embudo ── */
.dpv-funnel { display: flex; flex-direction: column; gap: 9px; }
.dpv-funnel-row { display: grid; grid-template-columns: 165px 1fr 46px; align-items: center; gap: 12px; }
.dpv-funnel-label { font-size: 13px; color: var(--text-secondary); }
.dpv-funnel-track { background: var(--bg-surface-2); border-radius: 6px; height: 28px; overflow: hidden; }
.dpv-funnel-fill {
  height: 100%; background: linear-gradient(90deg, #1E9E3A, #46b85c);
  border-radius: 6px; display: flex; align-items: center; justify-content: flex-end; padding-right: 10px;
}
.dpv-funnel-n { font-size: 12.5px; font-weight: 700; color: #fff; }
.dpv-funnel-drop { font-size: 12px; color: #B42318; text-align: right; font-weight: 600; }

/* ── Riesgo ── */
.dpv-risk-figure { text-align: center; padding: 6px 0 2px; }
.dpv-risk-big { font-size: 42px; font-weight: 700; line-height: 1; }
.dpv-risk-cap { font-size: 12.5px; color: var(--text-muted); margin-top: 4px; }
.dpv-urgent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpv-urgent-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--border); }
.dpv-urgent-row:first-child { border-top: 0; padding-top: 0; }
.dpv-urgent-body { flex: 1; min-width: 0; }
.dpv-urgent-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.dpv-urgent-causa { font-size: 12px; color: var(--text-muted); margin-top: 1px; }
.dpv-urgent-meta { text-align: right; font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.dpv-urgent-dias { font-size: 11px; color: var(--text-muted); }

/* ── Operación ── */
.dpv-op-big { font-size: 32px; font-weight: 700; line-height: 1.1; color: var(--text-primary); }
.dpv-op-of { font-size: 17px; font-weight: 500; color: var(--text-muted); }
.dpv-franjas { display: flex; flex-direction: column; gap: 8px; }
.dpv-franja { display: grid; grid-template-columns: 48px 1fr 26px; align-items: center; gap: 10px; }
.dpv-franja-label { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.dpv-franja-track { height: 16px; border-radius: 4px; background: #CFE6D5; overflow: hidden; }
.dpv-franja-oc { height: 100%; background: #1E9E3A; }
.dpv-franja-n { font-size: 12px; font-weight: 700; text-align: right; color: var(--text-secondary); }

/* ── Profesores ── */
.dpv-rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.dpv-rank-row { display: grid; grid-template-columns: 74px 1fr 30px auto; align-items: center; gap: 10px; }
.dpv-rank-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.dpv-rank-track { height: 8px; border-radius: 4px; background: var(--bg-surface-2); overflow: hidden; }
.dpv-rank-fill { display: block; height: 100%; background: #1E9E3A; border-radius: 4px; }
.dpv-rank-n { font-size: 12.5px; font-weight: 700; text-align: right; color: var(--text-secondary); }
.dpv-rank-tags { display: flex; gap: 5px; }
.dpv-tag { font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
.dpv-tag-ok { background: rgba(22,122,45,0.10); color: #167A2D; }
.dpv-tag-warn { background: rgba(255,196,0,0.20); color: #8a6d00; }
.dpv-chips { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.dpv-chip { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; background: var(--bg-surface-2); color: var(--text-secondary); }
.dpv-chip-more { color: var(--text-muted); background: transparent; }

/* ── Finanzas ── */
.dpv-fin-big { font-size: 30px; font-weight: 700; line-height: 1.1; color: var(--text-primary); }
.dpv-fin-delta { font-size: 12.5px; font-weight: 600; margin-top: 5px; }

/* ── Herramientas ── */
.dpv-tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dpv-tool { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-top: 1px solid var(--border); font-size: 13.5px; color: var(--text-secondary); }
.dpv-tool:first-child { border-top: 0; padding-top: 0; }
.dpv-tool-arrow { color: var(--text-muted); }

/* ── Tablet y notebook chica ── */
@media (max-width: 1100px) {
  .dpv-kpis { grid-template-columns: repeat(3, 1fr); }
  .dpv-actions { grid-template-columns: repeat(2, 1fr); }
  .dpv-grid3, .dpv-grid-op, .dpv-grid-fin { grid-template-columns: 1fr 1fr; }
  .dpv-grid-risk, .dpv-grid-prof { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .dpv-kpis { grid-template-columns: repeat(2, 1fr); }
  .dpv-actions, .dpv-grid3, .dpv-grid-op, .dpv-grid-fin { grid-template-columns: 1fr; }
  .dpv-funnel-row { grid-template-columns: 120px 1fr 40px; }
}
`;
