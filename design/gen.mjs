// Genera los artboards del canvas a partir de los datos REALES de agosto 2026
// (salida de la auditoría). Un solo render para escritorio y móvil, igual que en
// la app: el mismo componente, distinto ancho.
import fs from 'node:fs';

const eur = n => '€' + n.toFixed(2).replace('.', ',');

const CASOS = {
  agustin: {
    nombre: 'Agustin', total: 345.50, clases: 345.50, bonos: 0, penal: 0,
    claim: { n: 46, eur: 208.50 },
    total_clases: 124,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 70,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 70, eur: 323.50 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 0, eur: 0, t: 0, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 46,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 46, eur: 208.50 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 0 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 8,
        hint: 'Recuperaciones, clases añadidas a mano y horarios cambiados: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 5, eur: 22.00 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 3, eur: 13.00, t: 3, l: 0 },
        ] },
    ],
    filtros: { todas: 78, pagables: 75, pendientes: 3 },
  },
  silvia: {
    nombre: 'Silvia', total: 374.50, clases: 374.50, bonos: 0, penal: 0,
    claim: { n: 5, eur: 22.50 },
    total_clases: 93,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 67,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 66, eur: 298.00 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 1, eur: 4.50, t: 1, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 9,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 5, eur: 22.50 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 4 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 17,
        hint: 'Recuperaciones, clases añadidas a mano y horarios cambiados: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 17, eur: 76.50 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 0, eur: 0, t: 0, l: 0 },
        ] },
    ],
    filtros: { todas: 84, pagables: 83, pendientes: 1 },
  },
  solg: {
    nombre: 'Sol.G', total: -1.00, clases: 9.00, bonos: 0, penal: -10.00,
    claim: null,
    total_clases: 82,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 0,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 0, eur: 0 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 0, eur: 0, t: 0, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 80,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        nada: true,
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 0 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 80 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 2,
        hint: 'Recuperaciones, clases añadidas a mano y horarios cambiados: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 2, eur: 9.00 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 0, eur: 0, t: 0, l: 0 },
        ] },
    ],
    filtros: { todas: 2, pagables: 2, pendientes: 0 },
    penalDetalle: [{ txt: 'Falta sin aviso — Camila Ruiz, 12 ago', eur: 5 }, { txt: 'Falta sin aviso — Camila Ruiz, 19 ago', eur: 5 }],
  },
  dana: {
    nombre: 'Dana', total: 305.50, clases: 305.50, bonos: 0, penal: 0,
    claim: { n: 9, eur: 37.00 },
    total_clases: 141,
    ramas: [
      { c: 'con', label: 'Con registro de clase', n: 74,
        hint: 'Pulsaste «Ingresar a clase», o quedó constancia (falta sin aviso, cancelación).',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 56, eur: 238.00 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 18, eur: 78.00, t: 18, l: 0 },
        ] },
      { c: 'sin', label: 'Sin ingreso registrado', n: 36,
        hint: 'El calendario dice que tocaban y no quedó registro de acceso.',
        hijos: [
          { tipo: 'recl', label: 'Reclamables', n: 9, eur: 37.00 },
          { tipo: 'llano', label: 'Sin transcript ni registro', n: 27 },
        ] },
      { c: 'fuera', label: 'Fuera del calendario', n: 31,
        hint: 'Recuperaciones, clases añadidas a mano y horarios cambiados: existen y se cobran, pero no salen de una celda.',
        hijos: [
          { tipo: 'pag', label: 'Pagables', n: 15, eur: 67.50 },
          { tipo: 'pend', label: 'Pendientes de cobro', n: 16, eur: 71.50, t: 14, l: 2 },
        ] },
    ],
    filtros: { todas: 105, pagables: 71, pendientes: 34 },
  },
};

const CSS = `
:root{
  --bg-base:#F7F7F5; --bg-surface:#FFFFFF; --bg-surface-2:#F0F0ED; --border:#E0E0DA;
  --text-primary:#1A1A1A; --text-secondary:#4A4A4A; --text-muted:#6E6E66;
  --accent:#167A2D; --accent-soft:rgba(22,122,45,0.10);
  --brand-green:#1E9E3A; --brand-yellow:#FFC400;
  --ok-soft:#EAF5EC; --ok-border:rgba(22,122,45,0.30);
  --warn:#B45309; --warn-soft:#FFF6E0; --warn-border:rgba(255,196,0,0.45);
  --danger:#C81E1E; --danger-soft:#FDECEC; --danger-border:rgba(200,30,30,0.30);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-base);color:var(--text-primary);
  font-family:'Radio Canada',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.page{display:flex;flex-direction:column;gap:12px;padding:20px 16px 40px}
.pagetitle{font-size:22px;font-weight:600;letter-spacing:-0.02em;margin:0 0 2px}
.pagesub{font-size:12.5px;color:var(--text-muted);margin:0 0 6px}

/* ── cabecera ── */
.fin-head{background:var(--bg-surface);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.fin-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--border)}
.fin-nav{display:flex;align-items:center;gap:2px}
.fin-nav-btn{width:34px;height:34px;border:1px solid var(--border);background:var(--bg-surface);border-radius:6px;color:var(--text-secondary);font-size:16px;font-family:inherit;line-height:1}
.fin-month{min-width:132px;text-align:center;font-size:14px;font-weight:600}
.fin-ghost-btn{padding:7px 13px;border:1px solid var(--border);background:var(--bg-surface);border-radius:6px;color:var(--text-secondary);font-size:12px;font-weight:500;font-family:inherit}
.fin-primary-btn{padding:9px 16px;border:none;background:var(--accent);color:#fff;border-radius:6px;font-size:13px;font-weight:600;font-family:inherit}
.fin-spacer{flex-grow:1}
.fin-main{display:flex;align-items:flex-end;gap:28px;padding:18px 20px 20px;flex-wrap:wrap}
.fin-eyebrow{font-size:12px;color:var(--text-muted);letter-spacing:0.03em;text-transform:uppercase;font-weight:500;margin-bottom:4px;display:inline-flex;align-items:center;gap:5px}
.fin-help{width:14px;height:14px;border-radius:999px;border:1px solid var(--border);color:var(--text-muted);font-size:9px;display:inline-flex;align-items:center;justify-content:center;text-transform:none}
.fin-amount{font-size:40px;font-weight:600;line-height:1;letter-spacing:-0.02em;color:var(--brand-green)}
.fin-amount.is-zero{color:var(--text-muted)}
.fin-amount.is-neg{color:var(--danger)}
.fin-state{display:flex;flex-direction:column;gap:6px;padding-bottom:4px}
.fin-pill{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border-radius:999px;background:var(--warn-soft);border:1px solid var(--warn-border);color:var(--warn);font-size:12px;font-weight:600;align-self:flex-start}
.fin-pill-dot{width:7px;height:7px;border-radius:999px;background:currentColor}
.fin-settle{font-size:12px;color:var(--text-muted)}
.fin-chips{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary);padding-bottom:6px}
.fin-chip-sep{color:var(--text-muted)}
.fin-chip.is-muted{color:var(--text-muted)}
.fin-chip.is-bad{color:var(--danger);font-weight:500}
.fin-chip-btn{background:none;border:none;padding:0;font-family:inherit;font-size:12px;font-weight:600;color:var(--danger);text-decoration:underline}
.fin-pen{border-top:1px solid var(--border);padding:12px 20px;display:flex;flex-direction:column;gap:5px;background:var(--bg-base)}
.fin-pen-row{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary)}

/* ── banda de reclamables ── */
.fin-claim{display:block;background:var(--warn-soft);border:1px solid var(--warn-border);border-radius:10px;padding:14px 18px;text-decoration:none}
.fin-claim-in{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.fin-claim-body{flex-grow:1;min-width:220px}
.fin-claim-title{font-size:15px;font-weight:600;color:var(--text-primary)}
.fin-claim-sub{font-size:12px;color:var(--text-secondary);margin-top:3px;line-height:1.5}
.fin-claim-eur{color:var(--warn);font-weight:600}
.fin-claim-btn{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 16px;background:var(--accent);color:#fff;border-radius:9px;font-size:13px;font-weight:600}

.fin-notice{display:flex;align-items:flex-start;gap:11px;padding:11px 14px;background:var(--warn-soft);border:1px solid var(--warn-border);border-radius:10px}
.fin-notice-i{flex-shrink:0;width:18px;height:18px;border-radius:999px;background:var(--warn);color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-top:1px}
.fin-notice-body{flex-grow:1;font-size:12px;line-height:1.55;color:var(--text-secondary)}
.fin-notice-x{flex-shrink:0;background:none;border:none;color:var(--text-muted);font-size:16px;line-height:1;padding:0 2px;font-family:inherit}

/* ── embudo ── */
.fnl{background:var(--bg-surface);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.fnl-head{padding:16px 20px 12px}
.fnl-head-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.fnl-eyebrow{font-size:12px;font-weight:600;color:var(--text-secondary);letter-spacing:0.03em;text-transform:uppercase}
.fnl-total{font-size:28px;font-weight:600;line-height:1;letter-spacing:-0.02em}
.fnl-bar{display:flex;gap:3px;height:8px;margin-top:12px}
.fnl-seg{border-radius:3px;min-width:2px}
.fnl-seg.is-con{background:var(--brand-green)}
.fnl-seg.is-sin{background:var(--brand-yellow)}
.fnl-seg.is-fuera{background:#2563eb}
.fnl-seg.is-hold{background:var(--text-muted)}
.fnl-check{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:11px;color:var(--text-muted)}
.fnl-check-ok{color:var(--accent);font-weight:600}
.fnl-branch{width:100%;text-align:left;font-family:inherit;background:none;border:none;border-top:1px solid var(--border);border-left:3px solid var(--border);padding:12px 20px 12px 17px;display:flex;align-items:baseline;gap:12px}
.fnl-branch.is-con{border-left-color:var(--brand-green)}
.fnl-branch.is-sin{border-left-color:var(--brand-yellow)}
.fnl-branch.is-fuera{border-left-color:#2563eb}
.fnl-branch.is-zero{border-left-color:var(--border);opacity:0.55}
.fnl-branch-body{flex:1;min-width:0}
.fnl-branch-name{font-size:14px;font-weight:600}
.fnl-hint{font-size:11px;color:var(--text-muted);margin-top:2px;line-height:1.45;display:block}
.fnl-branch-n{font-size:18px;font-weight:600;min-width:40px;text-align:right}
.fnl-child{width:100%;text-align:left;font-family:inherit;background:none;border:none;border-top:1px solid var(--bg-surface-2);padding:9px 20px 9px 40px;display:flex;align-items:center;gap:12px}
.fnl-child.is-zero{opacity:0.55}
.fnl-child-name{flex:1;min-width:0;font-size:13px;color:var(--text-secondary)}
.fnl-child-eur{font-size:13px;font-weight:600;color:var(--accent);white-space:nowrap}
.fnl-child-eur.is-warn{color:var(--warn)}
.fnl-child-eur.is-zero{color:var(--text-muted);font-weight:400}
.fnl-child-n{font-size:15px;font-weight:600;min-width:40px;text-align:right}
.fnl-act{border-top:1px solid var(--bg-surface-2);padding:12px 20px 12px 40px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.fnl-act.is-claim{background:var(--warn-soft)}
.fnl-act-body{flex:1;min-width:180px}
.fnl-act-top{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.fnl-act-name{font-size:14px;font-weight:600;color:var(--text-primary)}
.fnl-act-eur{font-size:15px;font-weight:600;color:var(--warn)}
.fnl-act-sub{font-size:12px;color:var(--text-secondary);margin-top:3px;line-height:1.45;display:block}
.fnl-act-n{font-size:22px;font-weight:600;color:var(--warn);min-width:40px;text-align:right}
.fnl-act-btn{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 16px;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;font-weight:600;text-decoration:none;border:none;font-family:inherit}
.fnl-act-btn.is-ghost{background:var(--bg-surface);border:1px solid var(--border);color:var(--text-secondary);min-height:36px;font-size:12px}
.fnl-nothing{border-top:1px solid var(--bg-surface-2);background:var(--bg-base);padding:12px 20px 12px 40px;font-size:11px;color:var(--text-muted);line-height:1.55}

/* ── lista ── */
.fin-list-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.fin-list-title{flex-grow:1;font-size:14px;font-weight:600}
.fin-filters{display:flex;gap:4px;flex-wrap:wrap}
.fin-filter{padding:5px 11px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);border-radius:999px;font-size:12px;font-family:inherit}
.fin-filter.is-on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:600}
.card{background:var(--bg-surface);border:1px solid var(--border);border-radius:12px}
.stu{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:14px;align-items:start;padding:16px 18px}
.avatar{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:600;background:#eef4ef;color:#2f6b3f}
.stu-name{font-size:15.5px;font-weight:600;letter-spacing:-0.01em}
.stu-meta{font-size:12.5px;color:var(--text-muted);margin-top:8px}
.stu-cols{grid-column:2 / -1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:12px}
.stu-col-label{font-size:11.5px;color:var(--text-muted);margin-bottom:2px}
.stu-col-value{font-size:13.5px;color:var(--text-secondary)}
.stu-col-value.is-amount{font-size:15px;font-weight:600;color:var(--accent)}
.stu-link{grid-column:2 / -1;justify-self:start;margin-top:12px;color:var(--accent);font-size:13px;font-weight:600}
.pill-warn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;font-weight:600;padding:4px 11px;border-radius:999px;background:#fdf3e7;color:#9a6516}
.cls{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 18px;border-top:1px solid var(--bg-surface-2);font-size:12.5px}
.cls.is-review{background:#FFFDF5}
.cls-when{display:flex;align-items:center;gap:9px;color:var(--text-secondary);flex-wrap:wrap}
.cls-time{color:var(--text-muted)}
.tag-ok{display:inline-flex;align-items:center;gap:6px;color:var(--accent);font-weight:500}
.tag-warn{display:inline-flex;align-items:center;gap:6px;color:var(--warn);font-weight:500}
.dot{width:6px;height:6px;border-radius:999px}
.cls-eur{font-weight:600;text-align:right}
.nota{font-size:11.5px;color:var(--text-muted);line-height:1.5;padding:2px 4px 0}
.caso-h{font-size:13px;font-weight:600;color:var(--text-primary);margin:0 0 2px}
.caso-p{font-size:11.5px;color:var(--text-muted);line-height:1.5;margin:0 0 10px}
`;

function ramaHTML(r, claim, movil) {
  const zero = r.n === 0;
  const pad = movil ? 30 : 40;
  let h = `<div class="fnl-branch ${zero ? 'is-zero' : 'is-' + r.c}">
  <span class="fnl-branch-body"><span class="fnl-branch-name">${r.label}</span><span class="fnl-hint">${r.hint}</span></span>
  <span class="fnl-branch-n">${r.n}</span>
</div>`;
  for (const c of r.hijos) {
    if (c.tipo === 'recl' && c.n > 0) {
      h += `<div class="fnl-act is-claim" style="padding-left:${pad}px">
  <span class="fnl-act-body">
    <span class="fnl-act-top"><span class="fnl-act-name">Reclamables</span><span class="fnl-act-eur">≈ ${eur(c.eur)}</span></span>
    <span class="fnl-act-sub">Tienen el transcript subido: es dinero que podés cobrar por clases que ya diste.</span>
  </span>
  <span class="fnl-act-n">${c.n}</span>
  <a class="fnl-act-btn" href="#">Reclamar en Revisiones →</a>
</div>`;
      continue;
    }
    if (c.tipo === 'pend' && c.n > 0) {
      const sub = [c.t > 0 ? `${c.t} esperan tu transcript` : '', c.l > 0 ? `${c.l} retenidas por el límite del plan (lo resuelve el equipo)` : '']
        .filter(Boolean).join(' · ');
      h += `<div class="fnl-act" style="padding-left:${pad}px">
  <span class="fnl-act-body">
    <span class="fnl-act-top"><span class="fnl-act-name">${c.label}</span><span class="fnl-act-eur">${eur(c.eur)}</span></span>
    <span class="fnl-act-sub">${sub}</span>
  </span>
  <span class="fnl-act-n">${c.n}</span>
  ${c.t > 0 ? '<button class="fnl-act-btn is-ghost">Ver y subir</button>' : ''}
</div>`;
      continue;
    }
    const z = c.n === 0;
    const warn = c.tipo === 'pend';
    h += `<div class="fnl-child${z ? ' is-zero' : ''}" style="padding-left:${pad}px">
  <span class="fnl-child-name">${c.label}</span>
  ${c.eur != null && c.tipo !== 'recl' ? `<span class="fnl-child-eur${z ? ' is-zero' : warn ? ' is-warn' : ''}">${eur(c.eur)}</span>` : ''}
  <span class="fnl-child-n">${c.n}</span>
</div>`;
  }
  if (r.nada) {
    h += `<div class="fnl-nothing" style="padding-left:${pad}px">No hay nada que reclamar: de estas clases no quedó transcript ni registro. Usá «Ingresar a clase» para que cuenten.</div>`;
  }
  return h;
}

function pantalla(k, { movil = false, conLista = true, conAviso = true } = {}) {
  const d = CASOS[k];
  const sumaTxt = d.ramas.map(r => r.n).join(' + ') + ' = ' + d.total_clases;
  const neg = d.total < 0;
  return `
<div class="fin-head">
  <div class="fin-bar">
    <div class="fin-nav">
      <button class="fin-nav-btn">‹</button><span class="fin-month">agosto 2026</span><button class="fin-nav-btn">›</button>
    </div>
    <button class="fin-ghost-btn">Hoy</button>
    ${movil ? '' : '<span class="fin-spacer"></span>'}
    <button class="fin-primary-btn"${movil ? ' style="width:100%;min-height:44px"' : ''}>Añadir clase</button>
  </div>
  <div class="fin-main"${movil ? ' style="padding:16px;gap:16px"' : ''}>
    <div>
      <div class="fin-eyebrow">Total a cobrar <span class="fin-help">?</span></div>
      <div class="fin-amount${neg ? ' is-neg' : d.total === 0 ? ' is-zero' : ''}"${movil ? ' style="font-size:34px"' : ''}>${neg ? '−' : ''}€${Math.abs(d.total).toFixed(2).replace('.', ',')}</div>
    </div>
    <div class="fin-state">
      <span class="fin-pill"><span class="fin-pill-dot"></span>Pendiente de pago</span>
      <span class="fin-settle">Se liquida el 31 de agosto</span>
    </div>
    ${movil ? '' : '<span class="fin-spacer"></span>'}
    <div class="fin-chips">
      <span class="fin-chip">Clases ${eur(d.clases)}</span><span class="fin-chip-sep">·</span>
      <span class="fin-chip is-muted">Bonos ${eur(d.bonos)}</span><span class="fin-chip-sep">·</span>
      <span class="fin-chip${d.penal < 0 ? ' is-bad' : ' is-muted'}">Penalizaciones −€${Math.abs(d.penal).toFixed(2).replace('.', ',')}</span>
      ${d.penal < 0 ? '<button class="fin-chip-btn">ver detalle</button>' : ''}
    </div>
  </div>
  ${d.penalDetalle ? `<div class="fin-pen">${d.penalDetalle.map(p => `<div class="fin-pen-row"><span>${p.txt}</span><span>−€${p.eur.toFixed(2).replace('.', ',')}</span></div>`).join('')}</div>` : ''}
</div>

${d.claim ? `<a class="fin-claim" href="#">
  <div class="fin-claim-in">
    <div class="fin-claim-body">
      <div class="fin-claim-title">Tenés ${d.claim.n} clases reclamables</div>
      <div class="fin-claim-sub">Ya tienen el transcript subido: son <b class="fin-claim-eur">≈ ${eur(d.claim.eur)}</b> que podés cobrar si las reclamás antes del cierre del mes.</div>
    </div>
    <span class="fin-claim-btn"${movil ? ' style="width:100%;min-height:44px"' : ''}>Reclamar en Revisiones →</span>
  </div>
</a>` : ''}

${conAviso ? `<div class="fin-notice">
  <span class="fin-notice-i">i</span>
  <div class="fin-notice-body"><b style="color:var(--text-primary)">Novedad.</b> Ahora ves <b>todas</b> las clases de tu calendario sin registro de acceso, no solo las que declaraste a mano. Las que tienen el transcript subido <b>las podés reclamar</b> y se te pagan cuando el equipo las valide.</div>
  <button class="fin-notice-x">✕</button>
</div>` : ''}

<div class="fnl">
  <div class="fnl-head"${movil ? ' style="padding:12px 16px"' : ''}>
    <div class="fnl-head-row"><span class="fnl-eyebrow">Clases de agosto</span><span class="fnl-total">${d.total_clases}</span></div>
    <div class="fnl-bar">${d.ramas.filter(r => r.n > 0).map(r => `<div class="fnl-seg is-${r.c}" style="flex-grow:${r.n}"></div>`).join('')}</div>
    <div class="fnl-check"><span class="fnl-check-ok">✓</span><span>${sumaTxt} · cada clase está en un solo lugar</span></div>
  </div>
  ${d.ramas.map(r => ramaHTML(r, d.claim, movil)).join('\n')}
</div>

${conLista ? `<div>
  <div class="fin-list-head">
    <span class="fin-list-title">Clases por alumno</span>
    <div class="fin-filters">
      <button class="fin-filter is-on">Todas ${d.filtros.todas}</button>
      <button class="fin-filter">Pagables ${d.filtros.pagables}</button>
      <button class="fin-filter">Pendientes ${d.filtros.pendientes}</button>
    </div>
  </div>
  ${LISTA(movil)}
</div>` : ''}`;
}

const LISTA = movil => `<div class="card" style="margin-bottom:10px">
  <div class="stu"${movil ? ' style="padding:14px"' : ''}>
    <div class="avatar">AG</div>
    <div>
      <div class="stu-name">Alma Garcia</div>
      <div class="stu-meta">Desde 04 mar · 175 días · Nivel B1</div>
    </div>
    <span class="pill-warn"><span class="dot" style="background:#FFC400"></span>Pendiente de transcript</span>
    <div class="stu-cols">
      <div><div class="stu-col-label">Plan</div><div class="stu-col-value">Inglés general</div></div>
      <div><div class="stu-col-label">Tarifa · clases</div><div class="stu-col-value">€4,50 · 11 clases</div></div>
      <div><div class="stu-col-label">Subtotal del mes</div><div class="stu-col-value is-amount">€49,50</div></div>
    </div>
    <span class="stu-link">Ocultar detalle de clases</span>
  </div>
  <div class="cls"><span class="cls-when">24 ago <span class="cls-time">15:00</span> <span class="tag-ok"><span class="dot" style="background:#1E9E3A"></span>Pagable</span></span><span class="cls-eur">€4,50</span></div>
  <div class="cls"><span class="cls-when">21 ago <span class="cls-time">15:00</span> <span class="tag-ok"><span class="dot" style="background:#1E9E3A"></span>Pagable</span></span><span class="cls-eur">€4,50</span></div>
  <div class="cls is-review"><span class="cls-when">20 ago <span class="cls-time">15:00</span> <span class="tag-warn"><span class="dot" style="background:#FFC400"></span>Falta transcript</span></span><span class="cls-eur" style="color:var(--warn)">€4,50</span></div>
</div>
<div class="card">
  <div class="stu"${movil ? ' style="padding:14px"' : ''}>
    <div class="avatar">CG</div>
    <div>
      <div class="stu-name">Claudia González</div>
      <div class="stu-meta">Desde 12 ene · 226 días · Nivel A2</div>
    </div>
    <span></span>
    <div class="stu-cols">
      <div><div class="stu-col-label">Plan</div><div class="stu-col-value">Inglés general</div></div>
      <div><div class="stu-col-label">Tarifa · clases</div><div class="stu-col-value">€4,50 · 12 clases</div></div>
      <div><div class="stu-col-label">Subtotal del mes</div><div class="stu-col-value is-amount">€54,00</div></div>
    </div>
    <span class="stu-link">Ver detalle de clases</span>
  </div>
</div>`;

// El editor del canvas necesita este esqueleto EXACTO: support.js en el head y
// el contenido dentro de <x-dc>, con los estilos en <helmet>.
const shell = (title, body) => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
  <title>${title}</title>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Radio+Canada:wght@400;500;600&display=swap">
  <style>${CSS}</style>
</helmet>
${body}
</x-dc>
</body>
</html>
`;

const doc = (title, body, ancho) =>
  shell(title, `<div class="page" style="max-width:${ancho}">${body}</div>`);

const enc = (t, extra = '') => `<div style="flex:1;min-width:0">${extra}<div class="page" style="padding:0;gap:12px">${t}</div></div>`;

fs.writeFileSync('design/Main.dc.html',
  doc('Agustin · escritorio',
    `<h1 class="pagetitle">Finanzas</h1><p class="pagesub">Registro de clases y resumen de pago</p>` + pantalla('agustin'),
    '1180px'));

fs.writeFileSync('design/Movil.dc.html',
  doc('Agustin · móvil', pantalla('agustin', { movil: true }), '100%'));

fs.writeFileSync('design/Casos.dc.html', shell('Los tres casos límite', `<div style="display:flex;gap:20px;padding:20px 16px 40px;align-items:flex-start">
${enc(pantalla('silvia', { conLista: false, conAviso: false }),
  '<p class="caso-h">Silvia — el caso sano</p><p class="caso-p">83 de 84 clases pagables. La banda de reclamables aparece igual: 5 clases, €22,50 que se le escapan si no las pide. Sin ella tendría que deducirlo del embudo.</p>')}
${enc(pantalla('solg', { conLista: false, conAviso: false }),
  '<p class="caso-h">Sol.G — saldo negativo y nada que reclamar</p><p class="caso-p">Las penalizaciones se comieron el mes: −€1,00 va en rojo, no en el verde de «vas a cobrar». Cero en la primera rama, 80 clases sin rastro: no hay banda de reclamar, y se dice por qué en vez de ofrecer una acción que no existe.</p>')}
${enc(pantalla('dana', { conLista: false, conAviso: false }),
  '<p class="caso-h">Dana — la rama que mezcla dos cosas</p><p class="caso-p">34 pendientes repartidas en dos ramas. En «Fuera del calendario», 14 esperan su transcript y 2 están retenidas por el límite del plan: se dice cuáles dependen de ella y cuáles no, para no mandarla a hacer un trabajo que no cambia nada.</p>')}
</div>`));

fs.writeFileSync('design/MovilCasos.dc.html', shell('Los tres casos en móvil', `<div style="display:flex;gap:18px;padding:16px;align-items:flex-start">
${['silvia', 'solg', 'dana'].map(k => `<div style="width:390px;flex-shrink:0">
  <p class="caso-h" style="padding:0 4px">${CASOS[k].nombre}</p>
  <div class="page" style="padding:0;gap:12px">${pantalla(k, { movil: true, conLista: false, conAviso: false })}</div>
</div>`).join('')}
</div>`));

console.log('ok: Main, Movil, Casos, MovilCasos');

// ── Admin: la fila plegada de cada profesor con su barra ─────────────────────
// Datos reales de agosto (pagables / pendientes de transcript / retenidas por
// límite), que es lo que `finance` ya trae calculado para los 22 sin una sola
// consulta extra.
const ADMIN = [
  { n: 'Agustin',   pag: 75, rev: 3,  ret: 0,  bon: 0, eurPag: 345.50, eurRev: 13.00, eurRet: 0,     tot: 345.50 },
  { n: 'Silvia',    pag: 83, rev: 1,  ret: 0,  bon: 0, eurPag: 374.50, eurRev: 4.50,  eurRet: 0,     tot: 374.50 },
  { n: 'Dana',      pag: 71, rev: 32, ret: 2,  bon: 0, eurPag: 305.50, eurRev: 141.00, eurRet: 9.00, tot: 305.50 },
  { n: 'Wanda',     pag: 75, rev: 5,  ret: 0,  bon: 0, eurPag: 353.50, eurRev: 22.50, eurRet: 0,     tot: 353.50 },
  { n: 'DanielaN',  pag: 50, rev: 14, ret: 0,  bon: 0, eurPag: 211.50, eurRev: 62.00, eurRet: 0,     tot: 211.50 },
  { n: 'Sol.G',     pag: 2,  rev: 0,  ret: 0,  bon: 0, eurPag: 9.00,   eurRev: 0,     eurRet: 0,     tot: -1.00 },
];

const filaAdmin = t => {
  const total = t.pag + t.rev + t.ret;
  const neg = t.tot < 0;
  return `<div style="background:#FFFFFF;border:1px solid #E0E0DA;border-radius:10px">
  <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:16px 16px 12px">
    <div style="font-size:18px;font-weight:600">${t.n}</div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:4px 11px;border-radius:999px;background:#FFF6E0;color:#B45309">⏳ Pendiente</span>
      <span style="font-size:18px;font-weight:600;color:${neg ? '#C81E1E' : '#167A2D'};white-space:nowrap">${neg ? '−' : ''}€${Math.abs(t.tot).toFixed(2)}</span>
    </div>
  </div>
  <div class="fnl-bar" style="height:6px;margin:0 16px 12px">
    ${total === 0 ? '' : [
      t.pag > 0 ? `<div class="fnl-seg is-con" style="flex-grow:${t.pag}"></div>` : '',
      t.rev > 0 ? `<div class="fnl-seg is-sin" style="flex-grow:${t.rev}"></div>` : '',
      t.ret > 0 ? `<div class="fnl-seg is-hold" style="flex-grow:${t.ret}"></div>` : '',
    ].join('')}
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:12px;padding:0 16px 12px">
    <div><div class="stu-col-label" style="text-transform:uppercase;letter-spacing:0.04em;font-size:11px">Pagables</div><div style="font-size:13px;font-weight:600;margin-top:2px">${t.pag} · €${t.eurPag.toFixed(2)}</div></div>
    <div><div class="stu-col-label" style="text-transform:uppercase;letter-spacing:0.04em;font-size:11px">Pendiente de transcript</div><div style="font-size:13px;font-weight:600;margin-top:2px;color:${t.rev > 0 ? '#B45309' : 'inherit'}">${t.rev} · €${t.eurRev.toFixed(2)}</div></div>
    <div><div class="stu-col-label" style="text-transform:uppercase;letter-spacing:0.04em;font-size:11px">Excede límite</div><div style="font-size:13px;font-weight:600;margin-top:2px;color:${t.ret > 0 ? '#B45309' : 'inherit'}">${t.ret} · €${t.eurRet.toFixed(2)}</div></div>
    <div><div class="stu-col-label" style="text-transform:uppercase;letter-spacing:0.04em;font-size:11px">Bonos</div><div style="font-size:13px;font-weight:600;margin-top:2px">€${t.bon.toFixed(2)}</div></div>
  </div>
  <div style="display:flex;gap:8px;padding:0 16px 16px">
    <button style="padding:8px 14px;border-radius:6px;border:1px solid #E0E0DA;background:transparent;color:#4A4A4A;font-family:inherit;font-size:12px;font-weight:600">Ver detalle</button>
    <button style="padding:8px 14px;border-radius:6px;border:none;background:#167A2D;color:#fff;font-family:inherit;font-size:12px;font-weight:600">Marcar pagado</button>
  </div>
</div>`;
};

fs.writeFileSync('design/Admin.dc.html', shell('Admin · comparar profesores', `<div class="page" style="max-width:940px;margin:0 auto">
  <div>
    <h1 class="pagetitle">Finanzas</h1>
    <p class="pagesub">Gestión de pagos a profesores · agosto 2026</p>
  </div>
  <p class="caso-p" style="margin:0 0 4px">
    Cada fila plegada lleva ahora una barra con el reparto del mes: <b style="color:#167A2D">pagables</b>,
    <b style="color:#B45309">pendientes de transcript</b> y <b>retenidas por el límite del plan</b>.
    Con 22 profesores, comparar cuatro cifras por fila es justo lo que nadie hace.
  </p>
  <p class="caso-p" style="margin:0 0 8px">
    <b>Lo que NO está:</b> una columna «Reclamable» en las 22 filas. Ese número sale del embudo, y el embudo
    necesita las asignaciones, las solicitudes y las bajas de cada profesor: 66 consultas al abrir la pantalla.
    El importe reclamable aparece al desplegar un profesor, dentro de su embudo.
  </p>
  <div style="display:flex;flex-direction:column;gap:12px">${ADMIN.map(filaAdmin).join('')}</div>
</div>`));

console.log('ok: Admin');
