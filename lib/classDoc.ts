// Exportación de una clase generada a PDF, sin dependencias: se arma un documento
// HTML branded y se dispara el diálogo de impresión del navegador ("Guardar como
// PDF"). Cubre los dos modos (metodología aplicada y conversación guiada).
//
// Diseño: hoja de clase que el profesor usa en vivo. Fases NUMERADAS en metodología
// aplicada (la secuencia input→práctica→producción es un orden real); etiquetadas
// sin número en conversación guiada (no es una secuencia). El material del alumno
// y las notas para el profesor quedan visualmente separados.

import { isConversacionGuiada, type GeneratedClassIA } from '@/lib/aiTypes';

export interface ClassDocMeta {
  studentName: string;
  teacherName?: string | null;
  level?: string | null;
  classTypeLabel?: string | null;   // "Metodología aplicada" | "Conversación guiada"
}

function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Card de fase numerada (metodología aplicada: la secuencia es información).
function phaseCard(n: number, label: string, duration: string, content: string): string {
  const dur = duration ? `<span class="dur">${esc(duration)}</span>` : '';
  return `<section class="card">
    <div class="card-head"><span class="num">${n}</span><h2>${esc(label)}</h2>${dur}</div>
    <div class="body">${esc(content)}</div>
  </section>`;
}

// Card etiquetada sin número (conversación guiada: no hay secuencia fija).
function labelCard(label: string, content: string, extra = ''): string {
  return `<section class="card">
    <div class="card-head plain"><h2>${esc(label)}</h2></div>
    <div class="body">${esc(content)}</div>${extra}
  </section>`;
}

function listCard(label: string, items: string[]): string {
  if (!items?.length) return '';
  return `<section class="card">
    <div class="card-head plain"><h2>${esc(label)}</h2></div>
    <ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
  </section>`;
}

function bodyBlocks(nc: GeneratedClassIA): string {
  if (isConversacionGuiada(nc)) {
    const priority = nc.priorityAddressed
      ? `<div class="meta-note">Prioridad del diagnóstico · ${esc(nc.priorityAddressed)}</div>` : '';
    return [
      `<div class="mode-note">Conversación guiada — charla continua. El tópico lo elige el alumno; sostené la habilidad preparada y corregí en vivo sin cortar el flujo.</div>`,
      labelCard('Habilidad a trabajar', nc.skillObjective, priority),
      listCard('Aperturas de tópico', nc.suggestedOpeners),
      listCard('Preguntas dirigidas', nc.guidingQuestions),
      nc.correctionFocus ? labelCard('Foco de corrección', nc.correctionFocus) : '',
    ].filter(Boolean).join('');
  }
  const objectives = nc.objectives?.length
    ? `<section class="card lead"><div class="card-head plain"><h2>Objetivos de la clase</h2></div><ul>${nc.objectives.map(o => `<li>${esc(o)}</li>`).join('')}</ul></section>`
    : '';
  const phases = [
    nc.warmUp && ['Warm-up', nc.warmUp] as const,
    nc.mainContent && ['Contenido principal', nc.mainContent] as const,
    nc.practiceActivity && ['Práctica', nc.practiceActivity] as const,
    nc.closing && ['Cierre', nc.closing] as const,
  ].filter(Boolean) as ReadonlyArray<readonly [string, { title: string; duration: string; content: string }]>;

  return objectives + phases
    .map(([fallback, b], i) => phaseCard(i + 1, b.title || fallback, b.duration, b.content))
    .join('');
}

export function classToHtmlDoc(nc: GeneratedClassIA, meta: ClassDocMeta): string {
  const badges = [
    meta.level ? `Nivel ${esc(meta.level)}` : '',
    meta.classTypeLabel ? esc(meta.classTypeLabel) : '',
  ].filter(Boolean).map(b => `<span class="badge">${b}</span>`).join('');

  const subParts = [
    esc(meta.studentName),
    nc.duration ? esc(nc.duration) : '',
    meta.teacherName ? `Profesor/a ${esc(meta.teacherName)}` : '',
  ].filter(Boolean).join('  ·  ');

  const challenge = nc.challenge ? `
    <section class="challenge">
      <div class="ch-label">Tu desafío</div>
      <div class="body">${esc(nc.challenge)}</div>
    </section>` : '';

  const teacherSection = (nc.teacherNotes || nc.connectionToPrevious) ? `
    <div class="teacher">
      <div class="teacher-label">Para el profesor</div>
      ${nc.connectionToPrevious ? `<div class="t-block"><h3>Conexión con la clase anterior</h3><div class="body">${esc(nc.connectionToPrevious)}</div></div>` : ''}
      ${nc.teacherNotes ? `<div class="t-block"><h3>Notas</h3><div class="body">${esc(nc.teacherNotes)}</div></div>` : ''}
    </div>` : '';

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Clase ${nc.classNumber} - ${esc(meta.studentName)}</title>
<style>
  :root{
    --paper:#FCFCFA; --ink:#17231C; --muted:#667A6C; --line:#E4E8E3;
    --green:#1E9E3A; --green-d:#14722B; --green-soft:#EEF6EF;
    --amber-bg:#FFF6D6; --amber-ink:#7A5B00; --amber-line:#EBD48A;
  }
  @page { size:A4; margin:15mm 14mm; }
  *{ box-sizing:border-box; }
  body{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    color:var(--ink); background:var(--paper); margin:0; font-size:11pt; line-height:1.55;
    -webkit-print-color-adjust:exact; print-color-adjust:exact; }

  .head{ background:var(--green-soft); border:1px solid var(--line); border-left:4px solid var(--green);
    border-radius:10px; padding:16px 18px; margin-bottom:20px; }
  .eyebrow{ font-size:8.5pt; font-weight:700; color:var(--green-d); text-transform:uppercase;
    letter-spacing:.16em; }
  .title{ font-family:Georgia,'Times New Roman',serif; font-size:22pt; font-weight:700;
    color:var(--ink); margin:5px 0 8px; line-height:1.15; }
  .sub{ font-size:10pt; color:var(--muted); }
  .badges{ margin-top:11px; display:flex; flex-wrap:wrap; gap:6px; }
  .badge{ font-size:8.5pt; font-weight:700; color:var(--green-d); background:#fff;
    border:1px solid var(--green); border-radius:20px; padding:2px 11px; }

  .mode-note{ font-size:10pt; color:var(--muted); font-style:italic; margin-bottom:14px; }

  .card{ border:1px solid var(--line); border-radius:9px; padding:13px 15px; margin-bottom:13px;
    background:#fff; page-break-inside:avoid; }
  .card.lead{ background:var(--green-soft); border-color:var(--line); }
  .card-head{ display:flex; align-items:center; gap:9px; margin-bottom:7px; }
  .card-head h2{ font-size:12pt; font-weight:800; color:var(--ink); margin:0; letter-spacing:-.01em; }
  .card-head .dur{ margin-left:auto; font-size:9pt; font-weight:600; color:var(--muted); }
  .num{ flex:0 0 auto; width:22px; height:22px; border-radius:50%; background:var(--green);
    color:#fff; font-size:10.5pt; font-weight:800; display:flex; align-items:center; justify-content:center; }
  .card-head.plain h2{ border-left:3px solid var(--green); padding-left:9px; }

  .body{ white-space:pre-wrap; }
  .meta-note{ font-style:italic; color:var(--muted); margin-top:8px; font-size:10pt; }
  ul{ margin:2px 0; padding-left:20px; }
  li{ margin-bottom:4px; }

  .challenge{ background:var(--green); color:#fff; border-radius:10px; padding:14px 16px; margin:16px 0 4px; page-break-inside:avoid; }
  .challenge .ch-label{ font-size:8.5pt; font-weight:700; text-transform:uppercase; letter-spacing:.14em; opacity:.9; margin-bottom:5px; }
  .challenge .body{ font-size:11.5pt; }

  .teacher{ margin-top:20px; padding-top:14px; border-top:2px dashed var(--amber-line); page-break-inside:avoid; }
  .teacher-label{ display:inline-block; font-size:8.5pt; font-weight:700; text-transform:uppercase;
    letter-spacing:.12em; color:var(--amber-ink); background:var(--amber-bg); border:1px solid var(--amber-line);
    border-radius:5px; padding:2px 9px; margin-bottom:10px; }
  .t-block{ margin-bottom:10px; }
  .t-block h3{ font-size:10.5pt; font-weight:800; color:var(--ink); margin:0 0 3px; }

  .foot{ margin-top:22px; padding-top:9px; border-top:1px solid var(--line);
    font-size:8.5pt; color:var(--muted); text-align:center; }
</style></head>
<body>
  <div class="head">
    <div class="eyebrow">Clase ${nc.classNumber}</div>
    <div class="title">${esc(nc.classTitle)}</div>
    <div class="sub">${subParts}</div>
    <div class="badges">${badges}</div>
  </div>
  ${bodyBlocks(nc)}
  ${challenge}
  ${teacherSection}
  <div class="foot">Material para uso en clase</div>
</body></html>`;
}

/**
 * Abre el diálogo de impresión con la clase renderizada, para guardar como PDF.
 * Usa un iframe oculto para no perder el estado de la app. Best-effort.
 */
export function printClassPdf(nc: GeneratedClassIA, meta: ClassDocMeta): void {
  if (typeof document === 'undefined') return;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, {
    position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', visibility: 'hidden',
  } as CSSStyleDeclaration);
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) { document.body.removeChild(iframe); return; }
  doc.open();
  doc.write(classToHtmlDoc(nc, meta));
  doc.close();

  const cw = iframe.contentWindow!;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* ya removido */ } }, 500);
  };
  cw.onafterprint = cleanup;

  // Pequeño delay para que el iframe termine de renderizar antes de imprimir.
  setTimeout(() => {
    try { cw.focus(); cw.print(); } catch { cleanup(); }
    // Fallback por si onafterprint no dispara (algunos navegadores).
    setTimeout(cleanup, 60_000);
  }, 350);
}
