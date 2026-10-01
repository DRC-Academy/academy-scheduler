// Testimoniales — aviso al profesor para que suba la grabación al sheet.
//
// Módulo PURO (sin red): qué grabación le toca a cada profesor de una pareja y
// el texto del aviso. Lo usan el envío (app/api/admin/testimonial-notify), el
// email (lib/emailNotifications) y la tarjeta del profesor, para que los tres
// digan exactamente lo mismo. Lo prueba lib/testimonialRequests.test.ts.
//
// Si el alumno cambió de profe entre la clase "antes" y la "después", cada uno
// recibe el aviso de SU grabación: la tiene en su cuenta de Fathom.

/** Sheet de grabaciones; las de testimonios van en la pestaña "Testimoniales". */
export const RECORDINGS_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1xmG0lKM9ebAnUoHuFKR0pNBP1XtpaG0jZR9-DfbRlYk/edit';
export const RECORDINGS_SHEET_TAB = 'Testimoniales';

export type RecordingSide = 'antes' | 'despues';

/** Lo mínimo de una pareja que hace falta para avisar. */
export interface PairForRequest {
  studentName: string | null;
  before: { teacherId: string | null; classNumber: number | null; classDate: string | null; excerptAt: string | null; fathomUrl: string | null };
  after:  { teacherId: string | null; classNumber: number | null; classDate: string | null; excerptAt: string | null; fathomUrl: string | null };
}

export interface RecordingItem {
  side: RecordingSide;
  classNumber: number | null;
  classDate: string | null;
  /** Minuto donde está el momento clave ("3:15"). */
  minute: string | null;
  fathomUrl: string | null;
}

/** Un aviso por profesor con las grabaciones que le tocan. Sin profe asignado, esa grabación no se puede pedir. */
export function requestsForPair(p: PairForRequest): Array<{ teacherId: string; sides: RecordingSide[] }> {
  const out: Array<{ teacherId: string; sides: RecordingSide[] }> = [];
  const add = (teacherId: string | null, side: RecordingSide) => {
    if (!teacherId) return;
    const r = out.find(x => x.teacherId === teacherId);
    if (r) r.sides.push(side); else out.push({ teacherId, sides: [side] });
  };
  add(p.before.teacherId, 'antes');
  add(p.after.teacherId, 'despues');
  return out;
}

export function recordingItems(p: PairForRequest, sides: readonly RecordingSide[]): RecordingItem[] {
  const pick = (side: RecordingSide): RecordingItem => {
    const s = side === 'antes' ? p.before : p.after;
    return { side, classNumber: s.classNumber, classDate: s.classDate, minute: s.excerptAt, fathomUrl: s.fathomUrl };
  };
  return (['antes', 'despues'] as const).filter(s => sides.includes(s)).map(pick);
}

/** "14/07" */
export function shortDate(iso: string | null): string {
  if (!iso) return 'fecha sin registrar';
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "16 de abril". La fecha de la clase ya es de España: se lee tal cual, sin zonas horarias. */
export function longDate(iso: string | null): string {
  if (!iso) return 'fecha sin registrar';
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} de ${MESES[Number(m) - 1]}`;
}

/** "Ignacio Lauridia Polo" → "Ignacio" */
export const firstName = (name: string | null | undefined): string => (name ?? '').trim().split(/\s+/)[0] ?? '';

/** "Clase 4 · 14 de julio · momento clave en el minuto 3:15" (detalle de cada grabación). */
export function describeItem(it: RecordingItem): string {
  const num = it.classNumber != null ? `Clase ${it.classNumber}` : 'Clase';
  const min = it.minute ? ` · momento clave en el minuto ${it.minute}` : '';
  return `${num} · ${longDate(it.classDate)}${min}`;
}

/**
 * La frase que abre el aviso, directa y con las fechas exactas:
 *   "Ignacio, sube la clase del 16 de abril y la del 16 de junio de Sonia Becerra"
 */
export function uploadSentence(teacherName: string | null | undefined, studentName: string, items: RecordingItem[]): string {
  const fechas = items.map(it => longDate(it.classDate));
  const clases = fechas.length === 1
    ? `la clase del ${fechas[0]}`
    : `la clase del ${fechas[0]} y la del ${fechas[1]}`;
  const nombre = firstName(teacherName);
  return `${nombre ? `${nombre}, sube` : 'Sube'} ${clases} de ${studentName}`;
}

/** Título y cuerpo del aviso de la campanita (el email y la tarjeta dicen lo mismo). */
export function requestCopy(
  studentName: string, items: RecordingItem[], teacherName?: string | null,
): { title: string; body: string } {
  const una = items.length === 1;
  return {
    // Sin emoji: la campanita ya pone el 🎬 delante por el tipo del aviso.
    title: `Grabación para testimonio: ${studentName}`,
    body:
      `${uploadSentence(teacherName, studentName, items)} a la pestaña «${RECORDINGS_SHEET_TAB}» del sheet de grabaciones. ` +
      `${firstName(studentName) || studentName} ha mejorado mucho su fluidez y queremos usarlo como testimonio. ` +
      `Cuando ${una ? 'la' : 'las'} subas, pulsa «Grabación subida» en tus avisos.`,
  };
}
