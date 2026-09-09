// ── Reprogramar una clase de 2 h en DOS días distintos ────────────────────────
//
// POR QUÉ EXISTE. Reprogramar mueve el bloque entero a un solo horario: una clase
// de 16:00 a 18:00 se va completa al martes a las 11:00. Pero el hueco de 2 horas
// seguidas es justo el que no aparece cuando hay que recolocar a alguien, y el
// profesor terminaba haciéndolo a mano: reprogramaba una hora y marcaba la otra
// como recuperación desde el calendario, con dos vueltas por dos modales
// distintos y sin nada que garantizara que las dos sumaran las 2 horas.
//
// Esto lo hace en un acto: la clase original se tacha entera y se crean DOS
// recuperaciones de 1 hora, cada una con su fecha. El profesor cobra lo mismo que
// en bloque (dos filas de 1 unidad en vez de una de 2) y el alumno salda su clase
// igual — eso sale solo de lo que ya hay (lib/finance, lib/recoveryLedger), acá no
// se toca ningún importe.
//
// ES PURO A PROPÓSITO. No lee la base, no mira el reloj y no conoce el formato de
// las keys del grid: la ocupación entra por `cellAt` y las celdas salen como
// (día, hora). Así el modal del profesor y los tests dan el mismo veredicto sobre
// el mismo caso, que es lo que faltaba cuando esto se hacía a mano.
//
// LO QUE NO HACE: relajar ninguna regla. Las dos horas tienen que ser POSTERIORES
// a la clase original, igual que en la reprogramación normal, así que
// `checkRecovery` (lib/recovery) sigue valiendo tal cual y no hubo que tocarlo:
// una clase perdida siempre es anterior a la hora que la repone.

import type { Cell } from '@/types';
import { baseCellOf } from '@/lib/cells';
import { dayNameFromIso, mondayIsoOfIso, fmtDateDMY, GRID_DAY_ORDER } from '@/lib/teacherClasses';
import { hourNum, hourText, nkName } from '@/lib/sessions';

/**
 * Rango de fechas que se acepta. Es el mismo del `check` de la base
 * (supabase-reschedule-split.sql): un año mal tipeado —0266, 2006— pasa el
 * formato pero no es una fecha de clase, y la auditoría de septiembre de 2026
 * encontró dos recuperaciones así.
 */
export const SPLIT_MIN_DATE = '2024-01-01';
export const SPLIT_MAX_DATE = '2030-12-31';

/**
 * ¿Esta clase se puede repartir en dos días? Solo las de 2 h exactas: es partirla
 * en 1 h + 1 h, y para eso tiene que valer justo dos. Una de 1 h no hay nada que
 * partir y una de 3 h no cabe en dos mitades iguales, así que el checkbox no
 * aparece — la regla vive acá y no en el JSX para que la fije un test.
 */
export function canSplitReschedule(durationHours: number): boolean {
  return Math.round(durationHours) === 2;
}

/** Una de las dos horas elegidas, tal como la devuelve el formulario. */
export interface SplitSlot {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:MM' | 'HH:00' | 'HH' — se normaliza a 'HH:00'. */
  time: string;
}

/** Celda del calendario a escribir. Sin key: el formato lo pone el llamador. */
export interface SplitCell {
  day: string;
  /** 'HH:00' */
  hour: string;
  cell: Cell;
}

/** Constancia de recuperación de 1 hora a insertar. */
export interface SplitRecoveryRecord {
  /** Fecha de la clase de recuperación. */
  date: string;
  /** 'HH:00' */
  hour: string;
  /** Fecha de la clase original que salda. */
  recoveryFor: string;
}

export interface SplitPlan {
  /** Todo lo que hay que escribir en el grid, en UNA sola pasada. */
  cells: SplitCell[];
  /** La constancia de la clase original. `lostHours` es el crédito que abre. */
  reprogramada: {
    originalDate: string;
    /** 'HH:00' */
    originalTime: string;
    /** Primera de las dos horas: es la que se muestra en el badge "Reprogramada → …". */
    newDate: string;
    /** 'HH:00' */
    newTime: string;
    lostHours: number;
  };
  /** Las dos recuperaciones de 1 hora, en orden. */
  recuperaciones: SplitRecoveryRecord[];
  /** El resumen que el profesor lee antes de confirmar. */
  summary: string;
  /** Aviso que NO bloquea (dos horas seguidas el mismo día). */
  warning?: string;
}

export type SplitResult =
  | { ok: true; plan: SplitPlan }
  | { ok: false; problems: string[]; warning?: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 'HH:MM' | 'HH' → 'HH:00'. '' si no parsea: el grid trabaja en horas enteras. */
export function splitHourText(time: string | undefined | null): string {
  const h = hourNum((time ?? '').split(':')[0]);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? hourText(h) : '';
}

/** 'YYYY-MM-DD' + 'HH:00' → clave ordenable. El orden ISO es el cronológico. */
const stamp = (date: string, hour: string): string => `${date} ${hour}`;

const ordinal = (i: number): string => (i === 0 ? 'primera' : 'segunda');

/**
 * ¿Esta celda impide poner una recuperación encima?
 *
 * Mira el estado CRUDO y no el de fondo, igual que `freeHoursFrom` en el
 * calendario del profesor: una recuperación de otro alumno también ocupa la hora,
 * aunque el horario recurrente de fondo esté libre. 'no_work' no ocupa — es el
 * profesor decidiendo dar una hora que normalmente no trabaja.
 */
function ocupada(cell: Cell | undefined): boolean {
  return !!cell && cell.state !== 'libre' && cell.state !== 'no_work';
}

/**
 * El resumen en texto, para que el profesor lea lo que va a pasar antes de
 * pulsar. Se calcula aparte del plan porque el modal lo muestra en cuanto las dos
 * horas están completas, incluso mientras alguna validación todavía falla.
 */
export function splitSummaryText(opts: {
  originalDate: string;
  durationHours: number;
  slots: SplitSlot[];
}): string {
  const [a, b] = opts.slots;
  const h1 = splitHourText(a?.time);
  const h2 = splitHourText(b?.time);
  if (!a?.date || !b?.date || !h1 || !h2) return '';
  return `La clase del ${fmtDateDMY(opts.originalDate)} (${opts.durationHours} h) se recupera `
    + `el ${fmtDateDMY(a.date)} a las ${h1} y el ${fmtDateDMY(b.date)} a las ${h2}.`;
}

/**
 * Valida las dos horas elegidas y devuelve TODO lo que hay que escribir, o la
 * lista de problemas en los términos del profesor.
 *
 * Nada se escribe hasta que esto dice `ok`: es lo que permite que la operación sea
 * de todo o nada sin depender de una transacción entre dos tablas.
 */
export function planRescheduleSplit(opts: {
  studentName: string;
  /** La clase que se mueve. `hour` es su hora de INICIO. */
  original: { date: string; hour: string; durationHours: number };
  /** Las dos horas elegidas, en el orden del formulario. */
  slots: SplitSlot[];
  /** Hoy, 'YYYY-MM-DD'. Entra por parámetro: esto no mira el reloj. */
  todayIso: string;
  /** Ocupación del calendario del profesor. */
  cellAt: (day: string, hour: string) => Cell | undefined;
  /** Motivo elegido en el modal, para el comentario de la constancia. */
  reasonLabel?: string;
}): SplitResult {
  const problems: string[] = [];
  const { original, slots, todayIso, cellAt } = opts;

  const origHour = splitHourText(original.hour);
  const duration = Math.max(1, Math.round(original.durationHours || 1));
  const origDay = dayNameFromIso(original.date);
  const origStart = hourNum(origHour);
  /** Las casillas del grid que ocupa la clase que se mueve: 'Martes 16:00', 'Martes 17:00'. */
  const casillasOriginal = new Set(
    Number.isFinite(origStart)
      ? Array.from({ length: duration }, (_, i) => `${origDay}|${hourText(origStart + i)}`)
      : [],
  );

  // Normalizadas una sola vez: todo lo de abajo trabaja con 'HH:00'.
  const elegidas = [0, 1].map(i => ({
    date: (slots[i]?.date ?? '').trim(),
    hour: splitHourText(slots[i]?.time),
  }));

  // ── 1) Están las dos, completas ────────────────────────────────────────────
  for (const [i, s] of elegidas.entries()) {
    if (!s.date || !s.hour) {
      problems.push(`Falta la fecha o la hora de la ${ordinal(i)} recuperación.`);
    } else if (!ISO.test(s.date)) {
      problems.push(`La fecha de la ${ordinal(i)} recuperación no es válida. Elegila con el calendario.`);
    } else if (s.date < SPLIT_MIN_DATE || s.date > SPLIT_MAX_DATE) {
      // El año mal tipeado: pasa el formato y no es una fecha de clase.
      problems.push(`La fecha de la ${ordinal(i)} recuperación (${s.date}) no parece correcta. Revisá el año.`);
    }
  }
  // Sin las dos horas bien formadas no se puede comparar nada más.
  if (problems.length > 0) return { ok: false, problems };

  const [a, b] = elegidas;
  const origen = stamp(original.date, origHour);

  // ── 2) Las dos, POSTERIORES a la clase original ────────────────────────────
  //
  // Es la misma regla que la reprogramación normal ("mover la clase hacia
  // adelante"), aplicada a cada hora por separado. Mantenerla es lo que deja
  // intacto a `checkRecovery`: la clase perdida siempre es anterior a la hora que
  // la repone, así que su regla 4 se cumple sola y no hubo que abrirle ninguna
  // excepción.
  for (const [i, s] of elegidas.entries()) {
    if (s.date < todayIso) {
      problems.push(`La ${ordinal(i)} recuperación ya pasó: elegí una fecha de hoy en adelante.`);
    } else if (stamp(s.date, s.hour) <= origen) {
      problems.push(
        `La ${ordinal(i)} recuperación tiene que ser posterior a la clase original `
        + `(${fmtDateDMY(original.date)} ${origHour}).`,
      );
    }
  }

  // ── 3) La segunda, posterior a la primera ──────────────────────────────────
  // Se avisa en vez de reordenarlas en silencio: el profesor las escribió en un
  // orden y tiene que ver que el sistema entiende otro.
  if (stamp(b.date, b.hour) === stamp(a.date, a.hour)) {
    problems.push('Las dos recuperaciones son el mismo día a la misma hora: elegí dos huecos distintos.');
  } else if (stamp(b.date, b.hour) < stamp(a.date, a.hour)) {
    problems.push('La segunda recuperación tiene que ser posterior a la primera.');
  }

  const dayA = dayNameFromIso(a.date);
  const dayB = dayNameFromIso(b.date);

  // ── 3 bis) EL CALENDARIO NO TIENE DOMINGOS ─────────────────────────────────
  //
  // El grid va de lunes a sábado (GRID_DAY_ORDER, espejo de `DAYS` en
  // VisualCalendar). Una celda 'Domingo_11:00' no la pinta nadie y `puntualDateOf`
  // no puede resolverle la fecha, así que la recuperación quedaría invisible en el
  // calendario y en "Mis clases" — el profesor no la vería y no la daría.
  for (const i of [0, 1]) {
    const day = i === 0 ? dayA : dayB;
    if (day && !GRID_DAY_ORDER.includes(day)) {
      problems.push(
        `La ${ordinal(i)} recuperación cae en ${day.toLowerCase()} y tu calendario va de lunes a sábado. `
        + 'Elegí otro día.',
      );
    }
  }

  // ── 4) EL MISMO HUECO DEL CALENDARIO EN SEMANAS DISTINTAS ──────────────────
  //
  // El grid tiene UNA celda por (día de la semana, hora): el martes a las 11:00 es
  // una sola casilla para todas las semanas, y la marca puntual guarda a qué
  // semana pertenece. Dos recuperaciones en el mismo día de la semana y a la misma
  // hora —el martes 16 y el martes 23— caen en esa única casilla, y la segunda
  // borra la primera: el calendario y "Mis clases" mostrarían una sola de las dos
  // horas.
  //
  // Las constancias sí sobrevivirían las dos (fechas distintas), así que el crédito
  // saldría bien y el profesor cobraría las 2 horas — pero perdería de vista una
  // clase que tiene que dar, y eso es peor que pedirle otro hueco.
  if (dayA && dayA === dayB && a.hour === b.hour) {
    problems.push(
      `Las dos recuperaciones caen en el mismo hueco del calendario (${dayA} a las ${a.hour}, `
      + 'en semanas distintas) y el calendario solo puede recordar una marca por hueco. '
      + 'Elegí otro día u otra hora para la segunda.',
    );
  }

  // ── 4 bis) LA CASILLA DE LA PROPIA CLASE QUE SE MUEVE ──────────────────────
  //
  // Una recuperación el martes 22 a las 16:00 usa la MISMA casilla del grid que la
  // clase del martes 15 a las 16:00 que se está moviendo. Al escribir, la
  // recuperación pisaría el tachado y la clase original volvería a parecer una
  // clase normal en pie.
  //
  // Normalmente no se llega acá —esa casilla está 'ocupado' y la corta el paso 5—,
  // pero sí cuando la clase que se mueve ya no figura en el calendario, que es
  // justo el caso en que nadie lo vería venir.
  for (const [i, s] of elegidas.entries()) {
    const day = i === 0 ? dayA : dayB;
    if (day && casillasOriginal.has(`${day}|${s.hour}`)) {
      problems.push(
        `La ${ordinal(i)} recuperación usa la misma casilla del calendario que la clase que estás moviendo `
        + `(${day} a las ${s.hour}). Elegí otro día u otra hora.`,
      );
    }
  }

  // ── 5) Los dos huecos, libres ──────────────────────────────────────────────
  for (const [i, s] of elegidas.entries()) {
    const day = i === 0 ? dayA : dayB;
    if (!day) continue;
    if (ocupada(cellAt(day, s.hour))) {
      problems.push(`El ${day} ${fmtDateDMY(s.date)} a las ${s.hour} ya está ocupado en tu calendario.`);
    }
  }

  // Dos horas seguidas el mismo día: se permite, pero se dice.
  const seguidas = a.date === b.date && hourNum(b.hour) === hourNum(a.hour) + 1;
  const warning = seguidas
    ? 'Son dos horas seguidas: podés destildar y reprogramar el bloque entero.'
    : undefined;

  if (problems.length > 0) return { ok: false, problems, warning };

  // ── El plan ────────────────────────────────────────────────────────────────
  const cells: SplitCell[] = [];

  // La clase ORIGINAL, tachada entera. Se recorren sus `duration` horas: una
  // sesión de 2 h ocupa dos celdas y dejar la segunda sin tachar la hacía parecer
  // una clase normal que seguía en pie.
  const origMonday = mondayIsoOfIso(original.date);
  for (let i = 0; i < duration; i++) {
    const hour = hourText(origStart + i);
    const prev = cellAt(origDay, hour);
    const base = prev ? baseCellOf(prev) : null;
    // Solo se tacha la hora que era de ESTE alumno: si la sesión de 2 h ya no
    // existe en el calendario, la segunda celda se deja como está (mismo cinturón
    // que la reprogramación normal).
    if (i > 0 && !(base && nkName(base.student) === nkName(opts.studentName))) continue;
    cells.push({
      day: origDay,
      hour,
      cell: {
        state: 'reprogramada',
        student: opts.studentName,
        weekDate: origMonday,
        baseState: base ? base.state : 'ocupado',
        baseStudent: base ? base.student : opts.studentName,
        // La primera de las dos: es la fecha que se muestra en el badge.
        rescheduledTo: a.date,
      },
    });
  }

  // Las DOS horas de recuperación. Cada celda lleva su propia semana y las dos
  // apuntan a la misma clase perdida, que es lo que hace que el saldo de horas
  // (lib/recoveryLedger) las sume: 2 horas repuestas, 0 pendientes.
  for (const [i, s] of elegidas.entries()) {
    const day = i === 0 ? dayA : dayB;
    const prev = cellAt(day, s.hour);
    const base = prev ? baseCellOf(prev) : null;
    cells.push({
      day,
      hour: s.hour,
      cell: {
        state: 'bloqueado',
        student: opts.studentName,
        weekDate: mondayIsoOfIso(s.date),
        baseState: base ? base.state : 'libre',
        baseStudent: base ? base.student : undefined,
        recoveryFor: original.date,
      },
    });
  }

  return {
    ok: true,
    plan: {
      cells,
      reprogramada: {
        originalDate: original.date,
        originalTime: origHour,
        newDate: a.date,
        newTime: a.hour,
        // El crédito que abre esta clase, sellado. Sin esto se re-deduciría del
        // calendario de hoy, que no guarda historia.
        lostHours: duration,
      },
      recuperaciones: elegidas.map(s => ({
        date: s.date,
        hour: s.hour,
        recoveryFor: original.date,
      })),
      summary: splitSummaryText({
        originalDate: original.date,
        durationHours: duration,
        slots: elegidas.map(s => ({ date: s.date, time: s.hour })),
      }),
      warning,
    },
  };
}

/**
 * Comentario de la constancia `reprogramada` cuando la clase se parte. El de la
 * reprogramación normal dice "Reprogramada para <fecha>", que con dos fechas sería
 * una media verdad; nadie lo parsea, así que puede decir lo que de verdad pasó.
 */
export function splitRescheduleComment(opts: {
  recuperaciones: SplitRecoveryRecord[];
  reasonLabel?: string;
}): string {
  const [a, b] = opts.recuperaciones;
  const cuando = `${a.date} ${a.hour} y ${b.date} ${b.hour}`;
  return `Reprogramada en dos horas: ${cuando}`
    + (opts.reasonLabel ? ` — Motivo: ${opts.reasonLabel}` : '');
}
