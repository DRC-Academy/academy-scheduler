// ── El plazo del diploma: cuánto le queda al alumno para la fecha de su diploma ─
//
// REGLA DE NEGOCIO: el curso dura seis meses desde `assignments.start_date`, el
// día en que el alumno empezó las clases con su profesor. La fecha del diploma
// es ese día más seis meses de calendario, y el banner de la ficha de progreso
// (components/DiplomaBanner) lo enseña como una cuenta atrás en vez de como una
// barra de lecciones. El plazo NO se reinicia con las renovaciones: quien empezó
// hace más de seis meses y no ha terminado ve el estado "vencido", que es una
// invitación a retomar y no un reproche.
//
// ÚNICA FUENTE DEL CÁLCULO. Todo lo que aquí se decide es puro: entra la fecha
// de inicio y el día de hoy, salen la fecha del diploma, los días que faltan, su
// descomposición en meses y días de calendario, la fase en la que cae y el
// titular ya redactado. El componente no calcula ni redondea nada: pinta.
//
// LOS DÍAS SE CUENTAN ENTRE MEDIANOCHES DE MADRID. Las clases y los plazos de
// la academia van en hora de España (ver lib/subscriptionAccess.madridToday);
// contarlos en la hora del servidor o del navegador haría que el mismo alumno
// viera "te quedan 3 días" o "te quedan 2" según desde dónde abriera la ficha.
// La aritmética va en UTC sobre etiquetas `YYYY-MM-DD`: son días de calendario,
// no instantes, y así el cambio de hora no resta ni suma una hora que acabe
// moviendo un día.
//
// NULL NO ES CERO: sin fecha de inicio (o con una que no es una fecha) no hay
// plazo, `calcularPlazo` devuelve null y el banner vuelve al dibujo de lecciones
// de siempre. Preferimos no prometer nada a prometer una fecha inventada.

/** Meses de calendario que dura el curso desde la fecha de inicio. */
export const MESES_DE_CURSO = 6;

/** A partir de cuántos días el titular habla en meses y días. */
export const DIAS_PARA_HABLAR_EN_MESES = 30;
/** Hasta cuántos días es "última semana". */
export const DIAS_ULTIMA_SEMANA = 7;

export type FasePlazo =
  /** Más de 30 días: "Te quedan 4 meses y 12 días". */
  | 'meses'
  /** De 8 a 30 días: "Te quedan 23 días". */
  | 'dias'
  /** De 1 a 7 días: "¡Última semana! Te quedan 3 días". */
  | 'ultima-semana'
  /** El día del diploma. */
  | 'hoy'
  /** La fecha ya pasó. */
  | 'vencido';

export interface Plazo {
  /** `YYYY-MM-DD` del inicio, tal cual se validó. */
  inicio: string;
  /** `YYYY-MM-DD` del diploma: inicio + MESES_DE_CURSO, acotado al último día del mes. */
  fechaDiploma: string;
  /** Días naturales desde hoy hasta el diploma. Negativo cuando ya pasó. */
  dias: number;
  /** Meses de calendario enteros que caben entre hoy y el diploma (0 cuando vencido). */
  meses: number;
  /** Los días que sobran después de esos meses (0 cuando vencido). */
  diasSueltos: number;
  fase: FasePlazo;
}

const RE_DIA = /^\d{4}-\d{2}-\d{2}/;

/**
 * `YYYY-MM-DD` de un valor que puede venir como fecha corta, como ISO completo
 * o como cualquier cosa (la columna fue `text` un tiempo). Null si no es una
 * fecha de verdad: "2026-02-30" también es null.
 */
export function comoDia(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null;
  const s = valor.trim();
  if (!RE_DIA.test(s)) return null;
  const dia = s.slice(0, 10);
  const [y, m, d] = dia.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return dia;
}

function aIso(f: Date): string {
  return f.toISOString().slice(0, 10);
}

/**
 * `dia` más `n` meses de calendario, conservando el día del mes y acotándolo al
 * último día cuando ese mes es más corto: 31 de agosto + 6 meses = 28 (o 29) de
 * febrero, no el 3 de marzo que daría dejar desbordar a Date.
 */
export function sumarMeses(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number);
  const primero = new Date(Date.UTC(y, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(primero.getUTCFullYear(), primero.getUTCMonth() + 1, 0)).getUTCDate();
  primero.setUTCDate(Math.min(d, ultimo));
  return aIso(primero);
}

/** Días naturales de `desde` a `hasta`; negativo si `hasta` es anterior. */
export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** La fecha del diploma de quien empezó en `inicio`, o null si no es una fecha. */
export function fechaDelDiploma(inicio: string | null | undefined): string | null {
  const dia = comoDia(inicio);
  return dia ? sumarMeses(dia, MESES_DE_CURSO) : null;
}

/**
 * Meses enteros de calendario entre `hoy` y `hasta`, y los días que sobran.
 * "Enteros de calendario" y no "de 30 días": del 17 de septiembre al 29 de
 * enero van 4 meses (hasta el 17 de enero) y 12 días.
 */
export function mesesYDias(hoy: string, hasta: string): { meses: number; diasSueltos: number } {
  if (hasta <= hoy) return { meses: 0, diasSueltos: 0 };
  let meses = 0;
  while (sumarMeses(hoy, meses + 1) <= hasta) meses++;
  return { meses, diasSueltos: diasEntre(sumarMeses(hoy, meses), hasta) };
}

export function faseDe(dias: number): FasePlazo {
  if (dias < 0) return 'vencido';
  if (dias === 0) return 'hoy';
  if (dias <= DIAS_ULTIMA_SEMANA) return 'ultima-semana';
  if (dias <= DIAS_PARA_HABLAR_EN_MESES) return 'dias';
  return 'meses';
}

/**
 * El plazo de un alumno a día `hoy` (`YYYY-MM-DD`, el de Madrid). Null si
 * `inicio` no es una fecha: entonces no hay cuenta atrás que pintar.
 */
export function calcularPlazo(inicio: string | null | undefined, hoy: string): Plazo | null {
  const dia = comoDia(inicio);
  const hoyDia = comoDia(hoy);
  if (!dia || !hoyDia) return null;
  const fechaDiploma = sumarMeses(dia, MESES_DE_CURSO);
  const dias = diasEntre(hoyDia, fechaDiploma);
  const { meses, diasSueltos } = mesesYDias(hoyDia, fechaDiploma);
  return { inicio: dia, fechaDiploma, dias, meses, diasSueltos, fase: faseDe(dias) };
}

// ── El titular ───────────────────────────────────────────────────────────────

const unidad = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;

/**
 * "Te quedan 4 meses y 12 días" · "Te quedan 23 días" · "¡Última semana! Te
 * quedan 3 días" · "Tu diploma es hoy". El verbo concuerda con el sujeto: "Te
 * queda 1 mes", "Te queda 1 día", pero "Te quedan 1 mes y 1 día" (dos cosas).
 * Null cuando el plazo está vencido: ese estado no lleva cuenta atrás.
 */
export function titularPlazo(plazo: Plazo): string | null {
  switch (plazo.fase) {
    case 'vencido':
      return null;
    case 'hoy':
      return 'Tu diploma es hoy';
    case 'ultima-semana':
      return `¡Última semana! Te ${plazo.dias === 1 ? 'queda' : 'quedan'} ${unidad(plazo.dias, 'día', 'días')}`;
    case 'dias':
      return `Te quedan ${unidad(plazo.dias, 'día', 'días')}`;
    case 'meses': {
      // Con más de 30 días siempre cabe al menos un mes (el más corto tiene 28
      // días); el respaldo en días es por si algún día cambia el umbral.
      if (plazo.meses === 0) return `Te quedan ${unidad(plazo.dias, 'día', 'días')}`;
      const meses = unidad(plazo.meses, 'mes', 'meses');
      if (plazo.diasSueltos === 0) return `Te ${plazo.meses === 1 ? 'queda' : 'quedan'} ${meses}`;
      return `Te quedan ${meses} y ${unidad(plazo.diasSueltos, 'día', 'días')}`;
    }
  }
}
