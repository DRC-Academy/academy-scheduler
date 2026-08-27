// Genera los artboards del canvas a partir de los datos REALES de agosto 2026
// (design/data.mjs, salida de la verificación contra producción). Un solo render
// para escritorio y móvil, igual que en la app: el mismo componente, distinto ancho.
import fs from 'node:fs';
import { CASOS, AYUDAS, ADMIN, DRIFT } from './data.mjs';
import { ALUMNOS, fichaHTML, ANTES } from './ficha.mjs';

const eur = n => '€' + n.toFixed(2).replace('.', ',');
const CSS = fs.readFileSync('design/_css.txt', 'utf8')
  .replace(/^const CSS = `/, '').replace(/`;\s*$/, '');

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

function ramaHTML(r, movil) {
  const zero = r.n === 0;
  const pad = movil ? 30 : 40;
  let h = `<div class="fnl-branch ${zero ? 'is-zero' : 'is-' + r.c}">
  <span class="fnl-branch-body"><span class="fnl-branch-name">${r.label}</span><span class="fnl-hint">${r.hint}</span></span>
  <span class="fnl-branch-n">${r.n}</span>
</div>`;

  for (const c of r.hijos) {
    // Reclamables: lo más accionable de la pantalla.
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
    // Pendientes de cobro de la rama que SÍ se divide por estado.
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
    // Línea de ORIGEN: qué es, cuánto vale, y su estado de pago debajo.
    const z = c.n === 0;
    const mixta = c.tipo === 'origen' && c.pag > 0 && c.pend > 0;
    const todoPend = c.tipo === 'origen' && c.pag === 0 && c.pend === c.n && c.n > 0;
    const warn = mixta || todoPend;
    const ayuda = AYUDAS[c.label];
    h += `<div class="fnl-child${z ? ' is-zero' : ''}${mixta ? ' has-sub' : ''}" style="padding-left:${pad}px"${ayuda ? ` title="${ayuda.replace(/"/g, '&quot;')}"` : ''}>
  <span class="fnl-child-body">
    <span class="fnl-child-name">${c.label}</span>
    ${mixta ? `<span class="fnl-child-sub">${c.pag} ${c.pag === 1 ? 'pagable' : 'pagables'} · ${c.pend} pendiente${c.pend === 1 ? '' : 's'} de cobro</span>` : ''}
  </span>
  ${c.eur != null && c.tipo !== 'recl' ? `<span class="fnl-child-eur${z ? ' is-zero' : warn ? ' is-warn' : ''}">${eur(c.eur)}</span>` : ''}
  <span class="fnl-child-n">${c.n}</span>
</div>`;
  }

  if (r.nada) {
    h += `<div class="fnl-nothing" style="padding-left:${pad}px">No hay nada que reclamar: de estas clases no quedó transcript ni registro. Usá «Ingresar a clase» para que cuenten.</div>`;
  }
  return h;
}

function pantalla(k, { movil = false, conLista = true, filtroOrigen = null } = {}) {
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

<div class="fnl">
  <div class="fnl-head"${movil ? ' style="padding:12px 16px"' : ''}>
    <div class="fnl-head-row"><span class="fnl-eyebrow">Clases de agosto</span><span class="fnl-total">${d.total_clases}</span></div>
    <div class="fnl-bar">${d.ramas.filter(r => r.n > 0).map(r => `<div class="fnl-seg is-${r.c}" style="flex-grow:${r.n}"></div>`).join('')}</div>
    <div class="fnl-check"><span class="fnl-check-ok">✓</span><span>${sumaTxt} · cada clase está en un solo lugar</span></div>
  </div>
  ${d.ramas.map(r => ramaHTML(r, movil)).join('\n')}
</div>

${conLista ? `<div>
  <div class="fin-list-head">
    <span class="fin-list-title">Clases por alumno</span>
    <div class="fin-filters">
      <button class="fin-filter${filtroOrigen ? '' : ' is-on'}">Todas ${d.filtros.todas}</button>
      <button class="fin-filter">Pagables ${d.filtros.pagables}</button>
      <button class="fin-filter">Pendientes ${d.filtros.pendientes}</button>
      ${filtroOrigen ? `<button class="fin-filter is-on is-pick">${filtroOrigen.label} ${filtroOrigen.n}<span class="fin-filter-x">✕</span></button>` : ''}
    </div>
  </div>
  ${LISTA(movil, filtroOrigen)}
</div>` : ''}`;
}

const LISTA = (movil, filtroOrigen) => filtroOrigen ? `<div class="card">
  <div class="stu"${movil ? ' style="padding:14px"' : ''}>
    <div class="avatar">NV</div>
    <div>
      <div class="stu-name">Noemi Viñas Sánchez</div>
      <div class="stu-meta">Desde 12 feb · 195 días · Nivel B2</div>
    </div>
    <span></span>
    <div class="stu-cols">
      <div><div class="stu-col-label">Plan</div><div class="stu-col-value">Inglés general</div></div>
      <div><div class="stu-col-label">Tarifa · clases</div><div class="stu-col-value">€4,50 · 9 clases</div></div>
      <div><div class="stu-col-label">Subtotal del mes</div><div class="stu-col-value is-amount">€40,50</div></div>
    </div>
    <span class="stu-link">Ocultar detalle de clases</span>
  </div>
  <div class="cls"><span class="cls-when">14 ago <span class="cls-time">13:00</span> <span class="tag-ok"><span class="dot" style="background:#1E9E3A"></span>Pagable</span></span><span class="cls-eur">€4,50</span></div>
  <div class="nota" style="padding:10px 18px">La lista solo muestra las clases de la línea pulsada: el resto del mes de este alumno sigue ahí, detrás del filtro «Todas».</div>
</div>` : `<div class="card" style="margin-bottom:10px">
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

const enc = (t, extra = '') => `<div style="flex:1;min-width:0">${extra}<div class="page" style="padding:0;gap:12px">${t}</div></div>`;

// ── Profesor ─────────────────────────────────────────────────────────────────

fs.writeFileSync('design/Main.dc.html',
  doc('Agustin · escritorio',
    `<h1 class="pagetitle">Finanzas</h1><p class="pagesub">Registro de clases y resumen de pago</p>`
    + pantalla('agustin', { filtroOrigen: { label: 'Dadas fuera de tu horario', n: 8 } }),
    '1180px'));

fs.writeFileSync('design/Movil.dc.html',
  doc('Agustin · móvil', pantalla('agustin', { movil: true }), '100%'));

fs.writeFileSync('design/Casos.dc.html', shell('Los tres casos límite', `<div style="display:flex;gap:20px;padding:20px 16px 40px;align-items:flex-start">
${enc(pantalla('silvia', { conLista: false }),
  '<p class="caso-h">Silvia — el caso sano</p><p class="caso-p">83 de 84 pagables. Sus 17 de fuera del calendario son casi todas recuperaciones: la línea lo dice, y el importe va en verde porque ya cuentan. Solo 1 clase se dio fuera de su horario.</p>')}
${enc(pantalla('solg', { conLista: false }),
  '<p class="caso-h">Sol.G — saldo negativo y nada que reclamar</p><p class="caso-p">Las penalizaciones se comieron el mes: −€1,00 va en rojo, no en el verde de «vas a cobrar». Cero en la primera rama y 80 clases sin rastro. Sus 2 de fuera del calendario son faltas, no un problema de calendario.</p>')}
${enc(pantalla('dana', { conLista: false }),
  '<p class="caso-h">Dana — el caso que justifica el desglose</p><p class="caso-p">31 clases fuera del calendario que antes solo decían «15 pagables, 16 pendientes». Ahora se ve que son 17 recuperaciones, 3 faltas y 11 dadas fuera de su horario — y que de esas 11, 10 están sin cobrar.</p>')}
</div>`));

fs.writeFileSync('design/MovilCasos.dc.html', shell('Los tres casos en móvil', `<div style="display:flex;gap:18px;padding:16px;align-items:flex-start">
${['silvia', 'solg', 'dana'].map(k => `<div style="width:390px;flex-shrink:0">
  <p class="caso-h" style="padding:0 4px">${CASOS[k].nombre}</p>
  <div class="page" style="padding:0;gap:12px">${pantalla(k, { movil: true, conLista: false })}</div>
</div>`).join('')}
</div>`));

// ── Admin ────────────────────────────────────────────────────────────────────

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
    ${[['Pagables', `${t.pag} · €${t.eurPag.toFixed(2)}`, false],
       ['Pendiente de transcript', `${t.rev} · €${t.eurRev.toFixed(2)}`, t.rev > 0],
       ['Excede límite', `${t.ret} · €${t.eurRet.toFixed(2)}`, t.ret > 0],
       ['Bonos', `€${t.bon.toFixed(2)}`, false]].map(([l, v, w]) =>
      `<div><div class="stu-col-label" style="text-transform:uppercase;letter-spacing:0.04em;font-size:11px">${l}</div><div style="font-size:13px;font-weight:600;margin-top:2px${w ? ';color:#B45309' : ''}">${v}</div></div>`).join('')}
  </div>
  <div style="display:flex;gap:8px;padding:0 16px 16px">
    <button style="padding:8px 14px;border-radius:6px;border:1px solid #E0E0DA;background:transparent;color:#4A4A4A;font-family:inherit;font-size:12px;font-weight:600">Ver detalle</button>
    <button style="padding:8px 14px;border-radius:6px;border:none;background:#167A2D;color:#fff;font-family:inherit;font-size:12px;font-weight:600">Marcar pagado</button>
  </div>
</div>`;
};

const TONO = {
  sin_celda_activo: ['rgba(200,30,30,0.06)', 'rgba(200,30,30,0.30)', '#C81E1E'],
  dia_ajeno:        ['#FFF6E0', 'rgba(255,196,0,0.45)', '#B45309'],
  baja:             ['#F0F0ED', '#E0E0DA', '#6E6E66'],
};

const grupoDrift = g => {
  const [bg, bd, tx] = TONO[g.key];
  return `<div style="margin-bottom:18px">
  <div style="background:${bg};border:1px solid ${bd};border-radius:10px;padding:11px 14px;margin-bottom:8px">
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
      <span style="font-size:13.5px;font-weight:700;color:${tx}">${g.label}</span>
      <span style="font-size:12.5px;color:#4A4A4A">${g.alumnos} alumnos · ${g.clases} clases · €${g.eur.toFixed(2)}</span>
    </div>
    <div style="font-size:12px;color:#4A4A4A;line-height:1.55;margin-top:4px">${g.hint}</div>
  </div>
  <div style="display:flex;flex-direction:column;gap:6px">
    ${g.items.map(i => `<div style="background:#FFFFFF;border:1px solid #E0E0DA;border-radius:10px;padding:11px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-size:13.5px;font-weight:600">${i.alu}</span>
      <span style="font-size:12.5px;color:#6E6E66">${i.prof}</span>
      <span style="flex-grow:1"></span>
      <span style="font-size:12px;color:#6E6E66">${i.dias ? `en grilla: ${i.dias}` : 'sin ninguna celda'}</span>
      <span style="font-size:13px;font-weight:600;min-width:78px;text-align:right">${i.n} clase${i.n === 1 ? '' : 's'}</span>
      ${i.eur != null ? `<span style="font-size:13px;font-weight:600;color:#167A2D;min-width:64px;text-align:right">€${i.eur.toFixed(2)}</span>` : '<span style="min-width:64px"></span>'}
      <span style="font-size:11px;color:#6E6E66">▸</span>
    </div>`).join('')}
    ${g.mas ? `<div class="nota">y ${g.mas} alumno${g.mas === 1 ? '' : 's'} más en este grupo</div>` : ''}
  </div>
</div>`;
};

fs.writeFileSync('design/Admin.dc.html', shell('Admin · comparar profesores', `<div class="page" style="max-width:940px;margin:0 auto">
  <div>
    <h1 class="pagetitle">Finanzas</h1>
    <p class="pagesub">Gestión de pagos a profesores · agosto 2026</p>
  </div>
  <p class="caso-p" style="margin:0 0 4px">
    Cada fila plegada lleva una barra con el reparto del mes: <b style="color:#167A2D">pagables</b>,
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

fs.writeFileSync('design/AdminCalendarios.dc.html', shell('Admin · calendarios desincronizados', `<div class="page" style="max-width:940px;margin:0 auto">
  <div>
    <h1 class="pagetitle" style="font-size:16px">Clases dadas fuera del horario del alumno</h1>
    <p class="pagesub" style="max-width:780px">
      Clases que ocurrieron un día que el calendario no tiene marcado para ese alumno, sin ser recuperación
      ni falta. Al profesor se le cobran igual y no se le pide nada: las que están mal son las de aquí.
    </p>
  </div>
  <div style="font-size:13px;color:#4A4A4A;margin-bottom:6px">
    <b style="color:#1A1A1A">79</b> clases · 37 alumnos · agosto 2026
  </div>
  ${DRIFT.map(grupoDrift).join('')}
  <p class="nota" style="padding:0">
    Se carga al pulsar «Revisar», no al abrir Finanzas: son dos consultas
    (<code>dbGetAllTeacherAssignments</code> trae los calendarios de los 22 de una vez) y el resto se calcula
    con lo que el contexto ya tiene.
  </p>
</div>`));

console.log('ok: Main, Movil, Casos, MovilCasos, Admin, AdminCalendarios');

// ── Ficha del alumno (panel de admin) ────────────────────────────────────────
const FICHA_CSS = fs.readFileSync('design/ficha-css.txt', 'utf8');
const shellF = (title, body) => shell(title, body).replace('</style>', FICHA_CSS + '</style>');

const CAPS = {
  alvaro:  ['Activo y al día', 'Todo pagable, cupo con margen (11 de 25) y suscripción activa. La fila plegada dice «Al día» en gris: no hay nada que mirar, y por eso no grita.'],
  ester:   ['Con problemas', 'Cupo lleno (5 de 5) y 3 clases retenidas — €15,00 sin pagar. Hoy esta ficha le dice «OK» en verde: la pill vieja solo mira los transcripts. Y su suscripción figura cancelada desde su última clase.'],
  pascale: ['Ex-alumna', 'Sin asignación con la profesora, así que no tiene cupo: sus clases nunca exceden. Quedan 2 sin transcript, que es lo único accionable.'],
};

fs.writeFileSync('design/Ficha.dc.html', shellF('Ficha del alumno · escritorio', `<div class="page" style="max-width:1000px;margin:0 auto">
  <div>
    <h1 class="pagetitle" style="font-size:17px">Alumnos (3)</h1>
    <p class="pagesub" style="max-width:760px">
      Propuesta. Tres alumnos reales de agosto, desplegados. El orden responde las tres preguntas:
      arriba quién es y si está al día, en medio lo que pide acción, abajo el detalle.
    </p>
  </div>
  ${ALUMNOS.map(a => `<div>
    <p class="caso-h">${CAPS[a.id][0]} — ${a.profe}</p>
    <p class="caso-p">${CAPS[a.id][1]}</p>
    ${fichaHTML(a, false)}
  </div>`).join('')}
</div>`));

fs.writeFileSync('design/FichaMovil.dc.html', shellF('Ficha del alumno · móvil', `<div style="display:flex;gap:18px;padding:16px;align-items:flex-start">
  ${ALUMNOS.map(a => `<div style="width:390px;flex-shrink:0">
    <p class="caso-h" style="padding:0 4px">${CAPS[a.id][0]}</p>
    <div class="page" style="padding:0;gap:10px">${fichaHTML(a, true)}</div>
  </div>`).join('')}
</div>`));

fs.writeFileSync('design/FichaAntes.dc.html', shellF('Ficha del alumno · lo que hay hoy', `<div class="page" style="max-width:760px;margin:0 auto">
  <div>
    <h1 class="pagetitle" style="font-size:17px">Lo que hay hoy</h1>
    <p class="pagesub" style="max-width:700px">
      La misma alumna, Ester Domènech, con el diseño actual (4 de sus 12 clases).
      La grilla de seis campos repite tres de la cabecera; cada clase pinta hasta seis pills;
      y la pill verde dice «OK» con 3 clases retenidas por el cupo.
    </p>
  </div>
  ${ANTES}
</div>`));

console.log('ok: Ficha, FichaMovil, FichaAntes');
