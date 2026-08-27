// La ficha del alumno en el panel de admin — propuesta.
// Datos REALES de agosto 2026 (tres alumnos, sacados de la base tal cual).
import fs from 'node:fs';

const eur = n => '€' + n.toFixed(2).replace('.', ',');

// status: 'pag' | 'rev' | 'exc'   tipo: null | 'Recuperación' | 'Falta sin aviso' | 'Cancelación a la hora'
const ALUMNOS = [
  {
    id: 'alvaro',
    nombre: 'Alvaro Poza', profe: 'Maribel',
    plan: 'Exámenes', inicio: '17 jun 2026',
    contratado: { producto: 'Curso intensivo de ingles - OFERTA - 5h semanales', variante: '5h semanales · B2 · 11:00 - 12:00 · Lunes a viernes' },
    cupo: { used: 11, limit: 25 },
    pagables: 16, subtotal: 80.00,
    sub: { label: 'Activa', fecha: '26 ago', ok: true },
    problemas: [],
    clases: [
      { d: '04 ago', h: '13:00', s: 'pag', tipo: 'Recuperación', eur: 5, nota: '1h de recuperación — salda una clase perdida: no consume ninguna clase del mes.' },
      { d: '05 ago', h: '12:00', s: 'pag', tipo: 'Recuperación', eur: 10, horas: '2h', nota: '1h de recuperación — salda una clase perdida: consume 1 clase del mes en vez de 2.' },
      { d: '06 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '07 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '11 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '12 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '13 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '14 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '18 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '19 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '20 ago', h: '13:00', s: 'pag', eur: 5 },
      { d: '24 ago', h: '13:00', s: 'pag', tipo: 'Recuperación', eur: 5, nota: '1h de recuperación — salda una clase perdida: no consume ninguna clase del mes.' },
      { d: '25 ago', h: '13:00', s: 'pag', eur: 10, horas: '2h', nota: '1h de recuperación — salda una clase perdida: consume 1 clase del mes en vez de 2.' },
      { d: '26 ago', h: '13:00', s: 'pag', tipo: 'Cancelación a la hora', eur: 5 },
    ],
  },
  {
    id: 'ester',
    nombre: 'Ester Domènech Rodríguez', profe: 'Wanda',
    plan: 'Exámenes', inicio: '8 may 2026',
    contratado: { producto: 'Curso intensivo de ingles - OFERTA - 5h semanales', variante: '5h semanales · B2 · 2h diarias · De lunes a viernes' },
    cupo: { used: 5, limit: 5 },
    pagables: 10, subtotal: 50.00,
    sub: { label: 'Cancelada', fecha: '21 ago', ok: false },
    problemas: [
      { n: 3, eur: 15.00, txt: 'clases fuera del cupo del mes', det: 'Superan las 5 que incluye su plan. Cada una se puede incluir igual desde la lista.' },
    ],
    clases: [
      { d: '03 ago', h: '12:00', s: 'pag', eur: 5 },
      { d: '04 ago', h: '12:00', s: 'pag', eur: 5 },
      { d: '05 ago', h: '12:00', s: 'pag', tipo: 'Cancelación a la hora', eur: 5 },
      { d: '07 ago', h: '12:00', s: 'pag', tipo: 'Cancelación a la hora', eur: 5 },
      { d: '10 ago', h: '12:00', s: 'pag', eur: 5 },
      { d: '11 ago', h: '12:00', s: 'pag', eur: 5 },
      { d: '13 ago', h: '12:00', s: 'pag', tipo: 'Recuperación', eur: 5, nota: '1h de recuperación — salda una clase perdida: no consume ninguna clase del mes.' },
      { d: '15 ago', h: '14:00', s: 'pag', tipo: 'Falta sin aviso', eur: 10, horas: '2h', accion: 'Revertir falta',
        nota: 'Falta sin aviso — Ester Domènech Rodríguez, 2026-08-15 — 10.00 € (el alumno no se presentó) · 2h de recuperación — salda una clase perdida: no consume ninguna clase del mes.' },
      { d: '18 ago', h: '12:00', s: 'pag', eur: 5 },
      { d: '19 ago', h: '12:00', s: 'exc', eur: 5, accion: 'Incluir igual' },
      { d: '20 ago', h: '12:00', s: 'exc', eur: 5, accion: 'Incluir igual' },
      { d: '21 ago', h: '12:00', s: 'exc', eur: 5, accion: 'Incluir igual' },
    ],
  },
  {
    id: 'pascale',
    nombre: 'Pascale Arbion', profe: 'Dana',
    plan: 'Inglés general', inicio: null, ex: true,
    cupo: { used: 3, limit: null },
    pagables: 1, subtotal: 4.00,
    sub: { label: 'Pendiente de cancelación', fecha: '10 ago', ok: true },
    problemas: [
      { n: 2, eur: 8.00, txt: 'clases sin transcript', det: 'El profesor las dio y todavía no subió el texto. Se pagan solas en cuanto lo suba.' },
    ],
    clases: [
      { d: '03 ago', h: '12:00', s: 'rev', eur: 4, accion: 'Pagar sin transcript' },
      { d: '05 ago', h: '12:00', s: 'rev', eur: 4, accion: 'Pagar sin transcript' },
      { d: '10 ago', h: '12:00', s: 'pag', eur: 4 },
    ],
  },
];

const ESTADO = {
  pag: { label: 'Pagable', color: 'var(--accent)', dot: 'var(--brand-green)' },
  rev: { label: 'Sin transcript', color: 'var(--warn)', dot: 'var(--brand-yellow)' },
  exc: { label: 'Fuera del cupo', color: '#C2410C', dot: '#EA580C' },
};

/** La pill de la fila plegada. Cuenta TODO lo retenido, no solo los transcripts. */
function resumen(a) {
  const rev = a.clases.filter(c => c.s === 'rev').length;
  const exc = a.clases.filter(c => c.s === 'exc').length;
  const out = [];
  if (rev) out.push(`<span class="fch-flag is-rev">${rev} sin transcript</span>`);
  if (exc) out.push(`<span class="fch-flag is-exc">${exc} fuera del cupo</span>`);
  if (!out.length) out.push('<span class="fch-flag is-ok">Al día</span>');
  return out.join('');
}

function claseHTML(c, movil) {
  const e = ESTADO[c.s];
  return `<div class="fch-cls${c.s !== 'pag' ? ' is-flag' : ''}">
  <span class="fch-cls-when">${c.d}<span class="fch-cls-h">${c.h}</span></span>
  <span class="fch-cls-state" style="color:${e.color}"><span class="fch-dot" style="background:${e.dot}"></span>${e.label}</span>
  <span class="fch-cls-type">${[c.tipo, c.horas].filter(Boolean).join(' · ')}</span>
  <span class="fch-cls-eur">${eur(c.eur)}</span>
  ${c.accion ? `<button class="fch-cls-btn">${c.accion}</button>` : '<span></span>'}
  ${c.nota ? `<span class="fch-cls-note">${c.nota}</span>` : ''}
</div>`;
}

function fichaHTML(a, movil) {
  const pct = a.cupo.limit ? Math.min(100, Math.round((a.cupo.used / a.cupo.limit) * 100)) : 0;
  const lleno = a.cupo.limit != null && a.cupo.used >= a.cupo.limit;
  return `<div class="fch is-open">
  <div class="fch-head">
    <span class="fch-name"><span class="fch-caret">▾</span>${a.nombre}</span>
    <span class="fch-head-right">
      ${resumen(a)}
      <span class="fch-count">${a.pagables} clases</span>
      <span class="fch-total">${eur(a.subtotal)}</span>
    </span>
  </div>

  <div class="fch-body">
    <!-- Una línea de contexto: lo que hace falta para situar al alumno, y nada más. -->
    <div class="fch-ctx">
      <span>${a.plan}</span>
      <span class="fch-sep">·</span>
      <span>${a.inicio ? `desde el ${a.inicio}` : 'sin asignación activa'}</span>
      ${a.ex ? '<span class="fch-ex">ex-alumno</span>' : ''}
      <span class="fch-spacer"></span>
      <span class="fch-sub${a.sub.ok ? '' : ' is-bad'}" title="Estado de WooCommerce registrado en su última clase. No es una comprobación de hoy.">
        Suscripción: ${a.sub.label} <span class="fch-sub-when">· visto el ${a.sub.fecha}</span>
      </span>
    </div>

    <!-- El plan contratado: el producto de WooCommerce tal cual. Solo cuando dice
         más que la categoría de tarifa de la línea de arriba. -->
    ${a.contratado ? `<div class="fch-plan">
      <span class="fch-plan-label">Plan</span>
      <span class="fch-plan-value">${a.contratado.producto}<span class="fch-plan-var">${a.contratado.variante}</span></span>
    </div>` : ''}

    <!-- El cupo del mes: el número que antes había que deducir contando filas. -->
    <div class="fch-quota">
      <span class="fch-quota-label">Clases del mes</span>
      ${a.cupo.limit == null
        ? '<span class="fch-quota-none">Sin cupo — ya no tiene plan con este profesor</span>'
        : `<span class="fch-quota-bar"><span class="fch-quota-fill${lleno ? ' is-full' : ''}" style="width:${pct}%"></span></span>
           <span class="fch-quota-n${lleno ? ' is-full' : ''}">${a.cupo.used} de ${a.cupo.limit}</span>`}
    </div>

    ${a.problemas.length ? `<div class="fch-act">
      ${a.problemas.map(p => `<div class="fch-act-row">
        <span class="fch-act-n">${p.n}</span>
        <span class="fch-act-body">
          <span class="fch-act-top">${p.txt}<b class="fch-act-eur">${eur(p.eur)} sin pagar</b></span>
          <span class="fch-act-sub">${p.det}</span>
        </span>
      </div>`).join('')}
    </div>` : ''}

    <div class="fch-list">
      ${a.clases.map(c => claseHTML(c, movil)).join('')}
    </div>
  </div>
</div>`;
}

// ── Lo que hay hoy, para comparar ────────────────────────────────────────────
const ANTES = `<div class="old-student">
  <div class="old-head">
    <span class="old-name">▾ Ester Domènech Rodríguez</span>
    <span class="old-right">
      <span class="old-count">10 clases</span>
      <span class="old-pill" style="background:rgba(30,158,58,0.12);color:#1E9E3A">OK</span>
      <span class="old-amount">€50.00</span>
    </span>
  </div>
  <div class="old-meta">
    ${[['Plan', 'Exámenes'], ['Inicio', '08 may'], ['Antigüedad', '87d'], ['Tarifa', '€5.00'],
       ['Clases pagables', '10'], ['Subtotal', '€50.00']]
      .map(([l, v]) => `<div><div class="old-meta-label">${l}</div><div class="old-meta-value">${v}</div></div>`).join('')}
  </div>
  <div class="old-classes">
    ${[['03 ago', '€5.00', ['Pagable|#1E9E3A|rgba(30,158,58,0.12)', '✅ A tiempo|#1E9E3A|rgba(30,158,58,0.1)', 'Transcript subido|#1f7a3d|#eaf5ec', '❓ Sin verificar|#6E6E66|#F0F0ED']],
      ['05 ago', '€5.00', ['Pagable|#1E9E3A|rgba(30,158,58,0.12)', '⏰ Cancelación (cobrable)|#dc2626|rgba(239,68,68,0.1)', '✅ A tiempo|#1E9E3A|rgba(30,158,58,0.1)', 'Transcript subido|#1f7a3d|#eaf5ec', '⏳ Pendiente de cancelación|#b45309|rgba(255,196,0,0.18)']],
      ['15 ago', '€10.00', ['Pagable|#1E9E3A|rgba(30,158,58,0.12)', '🚫 Falta sin aviso|#b45309|rgba(255,196,0,0.20)', '🔁 Normal + recuperación|#8a6d00|rgba(255,196,0,0.20)', '❌ No utilizó|#6E6E66|#F0F0ED', 'Sin transcript (no aplica)|#6E6E66|#E8E8E4', '❓ Sin verificar|#6E6E66|#F0F0ED']],
      ['19 ago', '€5.00', ['Excede el límite del plan|#ea580c|rgba(249,115,22,0.12)', '✅ A tiempo|#1E9E3A|rgba(30,158,58,0.1)', 'Transcript subido|#1f7a3d|#eaf5ec', '❌ Cancelada|#dc2626|rgba(239,68,68,0.1)']]]
      .map(([d, e, pills]) => `<div class="old-class">
        <div class="old-class-date">${d}</div>
        <div class="old-class-amount">${e}</div>
        <div class="old-badges">${pills.map(p => { const [l, c, b] = p.split('|'); return `<span class="old-pill" style="background:${b};color:${c}">${l}</span>`; }).join('')}</div>
      </div>`).join('')}
  </div>
</div>`;

export { ALUMNOS, fichaHTML, ANTES };
