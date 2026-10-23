// ── PDF del "Registro para disputas" ──────────────────────────────────────────
//
// Se genera en el SERVIDOR con pdfkit: sin navegador, con las fuentes estándar
// del PDF (Helvetica, no se incrusta ninguna), así que el archivo pesa KB y no
// MB. Garantías:
//   · Exactamente las filas que recibe (las del filtro, ya sin "sin registro" ni
//     "posible ausencia": lib/classRegister.pdfRows).
//   · NINGÚN enlace: pdfkit solo crea anotaciones de enlace si se le piden, y
//     aquí no se pide ninguna. Ni el Meet, ni la app, ni un email clicable.
//   · Una fila nunca se parte entre páginas: se mide antes de dibujarla y, si
//     no cabe, va entera a la página siguiente, con la cabecera de la tabla
//     repetida.
//   · Tope de 4,5 MB (el de una respuesta de Vercel): si se pasara, lanza.
//
// Helvetica estándar solo cubre el juego Latin-1 (tildes, ñ, ü, ç, «», —…).
// Lo que quede fuera (p. ej. una "ł") se escribe sin el diacrítico.

import PDFDocument from 'pdfkit';
import {
  REGISTER_STATUS_LABEL, dmy, joinedLabel, studentSummary,
  type RegisterRow,
} from '@/lib/classRegister';
import type { RegisterStudentInfo } from '@/lib/classRegisterStore';

export const MAX_PDF_BYTES = 4.5 * 1024 * 1024;

export class PdfTooLargeError extends Error {}

/** Caracteres que Helvetica estándar (WinAnsi) sí tiene por encima de 255. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Letras que NFD no descompone (no son "letra + tilde"). */
const SIN_DESCOMPONER: Record<string, string> = { 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h', 'ı': 'i' };

export function pdfSafe(s: string): string {
  let out = '';
  for (const ch of s ?? '') {
    const code = ch.codePointAt(0)!;
    if (code <= 255 || WIN_ANSI_EXTRA.has(ch)) { out += ch; continue; }
    const base = SIN_DESCOMPONER[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += base && base.codePointAt(0)! <= 255 ? base : '?';
  }
  return out;
}

// ── Medidas (A4 apaisado, en puntos) ──────────────────────────────────────────

const MARGIN = 36;
const FOOTER = 22;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const SIZE = 8.5;
const PAD = 4;

const COLS: Array<{ key: string; title: string; width: number }> = [
  { key: 'fecha',   title: 'Fecha',                       width: 58 },
  { key: 'hora',    title: 'Hora programada',             width: 66 },
  { key: 'alumno',  title: 'Alumno',                      width: 130 },
  { key: 'profe',   title: 'Profe',                       width: 100 },
  { key: 'estado',  title: 'Estado',                      width: 190 },
  { key: 'ingreso', title: 'Ingreso del profe',           width: 64 },
  { key: 'ip',      title: 'IP del ingreso',              width: 92 },
  { key: 'tx',      title: 'Transcripción',               width: 70 },
];

function cells(r: RegisterRow): Record<string, string> {
  const estado = REGISTER_STATUS_LABEL[r.status] + (r.rescheduledTo ? ` al ${dmy(r.rescheduledTo)}` : '');
  return {
    fecha: dmy(r.date),
    hora: r.hoursLabel,
    alumno: r.studentName,
    profe: r.teacherName,
    estado,
    ingreso: joinedLabel(r.joinedAt, r.date) || '—',
    ip: r.ip || '—',
    tx: r.hasTranscript ? 'Sí' : 'No',
  };
}

export function buildRegisterPdf(args: {
  rows: RegisterRow[];
  desde: string;
  hasta: string;
  alumno: RegisterStudentInfo | null;
  nowMs?: number;
}): Promise<Buffer> {
  const { rows, desde, hasta, alumno } = args;
  const generado = new Date(args.nowMs ?? Date.now());

  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape',
    margins: { top: MARGIN, bottom: MARGIN + FOOTER, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: pdfSafe(`DRC Academy — Registro de clases${alumno ? ` — ${alumno.name}` : ''}`),
      Author: 'DRC Academy', Creator: 'DRC Gestión', Producer: 'DRC Gestión',
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - FOOTER;
  const text = (s: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) =>
    doc.text(pdfSafe(s), x, y, { lineBreak: true, ...opts });

  // ── Cabecera del documento ──
  doc.font(BOLD).fontSize(16).fillColor('#111111');
  text('DRC Academy — Registro de clases', left, MARGIN);
  doc.font(FONT).fontSize(10).fillColor('#333333');
  text(`Del ${dmy(desde)} al ${dmy(hasta)}`, left, doc.y + 4);
  const p = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(generado);
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '';
  text(`Generado el ${g('day')}/${g('month')}/${g('year')} a las ${g('hour')}:${g('minute')} (hora de España)`, left, doc.y + 2);
  doc.fontSize(8.5).fillColor('#555555');
  text('Todas las horas, en hora de España (Europe/Madrid). «Ingreso del profe»: momento en que el profesor pulsó «Ingresar a clase» en la plataforma. '
    + '«Transcripción»: transcripción de la clase subida por el profesor.', left, doc.y + 6, { width });
  let y = doc.y + 12;

  // ── Ficha y resumen del alumno ──
  if (alumno) {
    const s = studentSummary(rows);
    doc.font(BOLD).fontSize(11).fillColor('#111111');
    text('Alumno', left, y);
    doc.font(FONT).fontSize(9.5).fillColor('#222222');
    text(`Nombre: ${alumno.name}`, left, doc.y + 3);
    text(`Email: ${alumno.email ?? '—'}`, left, doc.y + 1);
    text(`Profesor${alumno.teachers.length === 1 ? '' : 'es'}: ${alumno.teachers.join(', ') || '—'}`, left, doc.y + 1);
    y = doc.y + 8;
    doc.font(BOLD).fontSize(11).fillColor('#111111');
    text('Resumen', left, y);
    doc.font(FONT).fontSize(9.5).fillColor('#222222');
    const lineas: Array<[string, number]> = [
      ['Total de clases', s.total],
      ['Realizadas', s.realizadas],
      ['Dadas por realizadas (cancelación con menos de 24 h o el alumno no se conectó)', s.dadasPorRealizadas],
      ['Canceladas por el alumno (avisó)', s.canceladasAlumno],
      ['Canceladas por el profe', s.canceladasProfe],
      ['El profe no se conectó', s.profeNoConecto],
      ['Recuperadas', s.recuperadas],
      ['Reprogramadas', s.reprogramadas],
    ];
    let ly = doc.y + 3;
    for (const [k, v] of lineas) {
      text(k, left, ly, { width: 420, lineBreak: false });
      text(String(v), left + 430, ly, { width: 40, align: 'right', lineBreak: false });
      ly += 13;
    }
    y = ly + 10;
  }

  // ── Tabla ──
  const header = (atY: number): number => {
    doc.font(BOLD).fontSize(SIZE);
    const h = Math.max(...COLS.map(c => doc.heightOfString(pdfSafe(c.title), { width: c.width - PAD * 2 }))) + PAD * 2;
    doc.rect(left, atY, width, h).fill('#E8EFE9');
    doc.fillColor('#111111');
    let x = left;
    for (const c of COLS) { text(c.title, x + PAD, atY + PAD, { width: c.width - PAD * 2 }); x += c.width; }
    return atY + h;
  };

  if (rows.length === 0) {
    doc.font(FONT).fontSize(10).fillColor('#333333');
    text('No hay clases registradas en este rango con los filtros aplicados.', left, y);
  } else {
    if (y + 40 > bottom()) { doc.addPage(); y = MARGIN; }
    y = header(y);
    rows.forEach((r, i) => {
      const v = cells(r);
      doc.font(FONT).fontSize(SIZE);
      const h = Math.max(...COLS.map(c => doc.heightOfString(pdfSafe(v[c.key]), { width: c.width - PAD * 2 }))) + PAD * 2;
      if (y + h > bottom()) { doc.addPage(); y = header(MARGIN); doc.font(FONT).fontSize(SIZE); }
      if (i % 2 === 1) doc.rect(left, y, width, h).fill('#F6F7F5');
      doc.fillColor('#1a1a1a');
      let x = left;
      for (const c of COLS) { text(v[c.key], x + PAD, y + PAD, { width: c.width - PAD * 2 }); x += c.width; }
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.4).strokeColor('#DDDDDD').stroke();
      y += h;
    });
  }

  // ── Pie: página X de Y ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;   // escribir en el margen sin que salte de página
    doc.font(FONT).fontSize(7.5).fillColor('#777777');
    text(`DRC Academy — Registro de clases · ${dmy(desde)} – ${dmy(hasta)} · Página ${i - range.start + 1} de ${range.count}`,
      left, doc.page.height - MARGIN - 10, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = keep;
  }

  doc.end();
  return done.then(buf => {
    if (buf.length > MAX_PDF_BYTES) throw new PdfTooLargeError('El PDF supera 4,5 MB: acota el rango o filtra por alumno o profe.');
    return buf;
  });
}
