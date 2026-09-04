// ── Quién tiene derecho a recuperar una clase ────────────────────────────────
//
// POR QUÉ EXISTE. Hasta ahora no había ninguna comprobación: el modal de "En
// recuperación" pedía una fecha en un `<input type="date">` sin tope y la
// guardaba tal cual. La auditoría de agosto de 2026 sobre 187 recuperaciones dio
// esto:
//
//     12  válidas — la clase se había perdido con derecho a recuperarla
//      7  el alumno había faltado SIN avisar ese día (no daba derecho)
//     15  ese día se dio clase normalmente (no había nada que recuperar)
//     54  ninguna clase registrada en esa fecha
//     37  fecha POSTERIOR a la propia recuperación, o el mismo día
//      2  año de cinco cifras ("82026-05-03")
//     60  sin fecha
//
// Doce de 187. Y dos recuperaciones distintas llegaron a apuntar a la misma
// clase perdida (Paula Tatiana, 18 y 20 de agosto, ambas al día 11), cobrándola
// dos veces.
//
// LAS REGLAS DE NEGOCIO, tal como las fijó la academia:
//
//   1. Falta SIN aviso → el profesor cobra y el alumno PIERDE la clase. No se
//      recupera. La cancelación sobre la hora se trata igual: se le cobra al
//      alumno, así que no puede además conservar el derecho — saldría ganando
//      por cancelar tarde.
//   2. Falta CON aviso, cancelación con preaviso, clase reprogramada y clase
//      cancelada por el profesor → el alumno SÍ tiene derecho a recuperarla.
//   3. Una clase perdida se recupera hasta completar SUS horas: una clase de
//      1 h admite una recuperación; una de 2 h admite dos horas, juntas el mismo
//      día o partidas en dos días (ver lib/recoveryLedger).
//   4. No se puede recuperar una clase que todavía no se dio.
//
// LA SALIDA. Cuando no hay registro en esa fecha el modal NO se limita a
// bloquear: ofrece registrar ahí mismo la falta con aviso y seguir. Bloquear sin
// dar salida es lo que garantiza que el hábito no cambie — y las 54 sin registro
// dicen que el aviso del alumno hoy se da por WhatsApp y no llega al sistema.

import type { ClassJoinLog, ClassRecord, ClassRecordType } from '@/types';

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** La clase no se dio y no se le cobró al alumno: conserva el derecho. */
export const RECUPERABLES: ReadonlySet<ClassRecordType> = new Set<ClassRecordType>([
  'falta_con_aviso',
  'cancelada_con_preaviso',
  'cancelada_por_profesor',
  'reprogramada',
]);

/** Se le cobró al alumno: la clase se consumió y no se recupera. */
export const NO_RECUPERABLES: ReadonlySet<ClassRecordType> = new Set<ClassRecordType>([
  'falta_sin_aviso',
  'cancelacion_hora',
]);

export type RecoveryRejectKind =
  | 'formato'         // la fecha no es una fecha
  | 'futura'          // igual o posterior a la propia recuperación
  | 'ya_recuperada'   // otra recuperación ya salda esa clase
  | 'sin_derecho'     // faltó sin avisar o canceló sobre la hora
  | 'clase_dada'      // ese día hubo clase
  | 'sin_registro';   // no consta nada — acá va la salida

export interface RecoveryVerdict {
  ok: boolean;
  kind?: RecoveryRejectKind;
  /** Una línea, la que se lee primero. */
  title: string;
  /** Por qué, en los términos del profesor. */
  detail: string;
  /**
   * Solo en 'sin_registro'. El modal ofrece registrar la falta con aviso de esa
   * fecha y continuar; no mueve dinero (una falta avisada se ignora en el
   * cálculo del pago, ver lib/finance.ts).
   */
  offerRegister?: boolean;
}

/** Una recuperación que ya existe, para no saldar dos veces la misma clase. */
export interface ExistingRecovery {
  studentName: string;
  /** Fecha de la clase de recuperación. */
  date: string;
  /**
   * Hora de la celda, 'HH:00'. Es lo que permite contar DOS horas de
   * recuperación el mismo día (una clase perdida de 2 h repuesta en un bloque)
   * sin contar dos veces la misma hora, que llega por dos vías: la celda del
   * calendario y su constancia en class_records.
   */
  hour?: string | null;
  /** Clase perdida que salda. */
  recoveryFor?: string | null;
}

/**
 * Horas de recuperación ya marcadas para una clase perdida. Cuenta HORAS, no
 * registros: la misma hora llega por dos vías (la celda del calendario y su
 * constancia) y contarla dos veces daría por saldada media clase.
 *
 * `exclude` es la celda que se está marcando ahora mismo, que todavía no es una
 * recuperación hecha. Sin hora excluye la fecha entera (comportamiento de
 * siempre: revisar una recuperación ya marcada no puede leerse como duplicado).
 */
export function countRecoveredHours(
  existing: ExistingRecovery[],
  studentName: string,
  lostDate: string,
  exclude?: { date: string; hour?: string | null },
): number {
  const alumno = nk(studentName);
  const excludeHour = hourKey(exclude?.hour);
  const horas = new Set<string>();
  for (const e of existing) {
    if (nk(e.studentName) !== alumno || e.recoveryFor !== lostDate) continue;
    const key = hourKey(e.hour);
    if (exclude && e.date === exclude.date && (excludeHour === 'x' || key === 'x' || key === excludeHour)) continue;
    horas.add(`${e.date}|${key}`);
  }
  return horas.size;
}

/** 'HH:00' → '17'. 'x' cuando no se sabe la hora. */
const hourKey = (hour: string | null | undefined): string => {
  const h = parseInt((hour ?? '').trim(), 10);
  return Number.isFinite(h) ? String(h) : 'x';
};

const ES = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
};

const TIPO_ES: Partial<Record<ClassRecordType, string>> = {
  falta_sin_aviso: 'faltó sin avisar',
  cancelacion_hora: 'canceló sobre la hora',
};

/**
 * ¿Se puede recuperar la clase de `lostDate` en la clase de `recoveryDate`?
 *
 * Pura: no lee la base ni el reloj. Todo lo que necesita entra por parámetro,
 * para que el modal del profesor y cualquier revisión posterior den el mismo
 * veredicto sobre el mismo caso.
 */
export function checkRecovery(opts: {
  studentName: string;
  /** Fecha de la clase de recuperación (la celda que se está marcando). */
  recoveryDate: string;
  /** Hora de esa celda, 'HH:00'. Sin ella se excluye la fecha entera. */
  recoveryHour?: string;
  /** Fecha de la clase perdida que se quiere saldar. */
  lostDate: string;
  classRecords: ClassRecord[];
  joinLogs: ClassJoinLog[];
  /** Recuperaciones que ya existen (celdas del calendario y class_records). */
  existing: ExistingRecovery[];
  /**
   * Horas que valía la clase perdida (1 por defecto). Lo calcula el llamador con
   * `lostClassHours` (lib/recoveryLedger), que es quien tiene el calendario: una
   * clase de 2 h admite dos horas de recuperación, juntas o partidas.
   */
  lostHours?: number;
}): RecoveryVerdict {
  const { studentName, recoveryDate, lostDate } = opts;
  const alumno = nk(studentName);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(lostDate)) {
    return {
      ok: false, kind: 'formato',
      title: 'Esa fecha no es válida.',
      detail: 'Escribila con el selector del calendario, en formato día/mes/año.',
    };
  }

  // 4. No se recupera lo que todavía no se perdió.
  if (lostDate >= recoveryDate) {
    return {
      ok: false, kind: 'futura',
      title: lostDate === recoveryDate
        ? 'Esa es la fecha de esta misma clase.'
        : 'Esa clase todavía no se dio.',
      detail: `La recuperación es del ${ES(recoveryDate)}: solo puede saldar una clase anterior.`,
    };
  }

  // 3. Una clase perdida se repone hasta completar SUS horas.
  const lostHours = Math.max(1, Math.round(opts.lostHours ?? 1));
  const hechas = countRecoveredHours(opts.existing, studentName, lostDate,
    { date: recoveryDate, hour: opts.recoveryHour });
  if (hechas >= lostHours) {
    const fechas = [...new Set(opts.existing
      .filter(e => nk(e.studentName) === alumno && e.recoveryFor === lostDate)
      .map(e => ES(e.date)))];
    return {
      ok: false, kind: 'ya_recuperada',
      title: lostHours > 1 ? `Esa clase ya está recuperada entera.` : 'Esa clase ya se recuperó.',
      detail: lostHours > 1
        ? `Era una clase de ${lostHours} horas y ya tiene sus ${lostHours} horas repuestas (${fechas.join(' y ')}).`
        : `La recuperó la clase del ${fechas[0] ?? ES(recoveryDate)}. Cada clase perdida se recupera una sola vez.`,
    };
  }

  // 1 y 2. Qué pasó ese día.
  const delDia = opts.classRecords.filter(r =>
    nk(r.studentName) === alumno && r.classDate === lostDate);

  const sinDerecho = delDia.find(r => NO_RECUPERABLES.has((r.classType ?? 'normal') as ClassRecordType));
  if (sinDerecho) {
    const qué = TIPO_ES[(sinDerecho.classType ?? 'normal') as ClassRecordType] ?? 'no avisó';
    return {
      ok: false, kind: 'sin_derecho',
      title: 'Esa clase no se puede recuperar.',
      detail: `El ${ES(lostDate)} el alumno ${qué}: esa clase se le cobró y no se repone.`,
    };
  }

  const conDerecho = delDia.some(r => RECUPERABLES.has((r.classType ?? 'normal') as ClassRecordType));
  if (conDerecho) return { ok: true, title: '', detail: '' };

  // Quedan los registros que SÍ son clase dada, y los ingresos.
  const hubo = delDia.length > 0
    || opts.joinLogs.some(l => nk(l.studentName) === alumno && l.scheduledDate === lostDate);
  if (hubo) {
    return {
      ok: false, kind: 'clase_dada',
      title: 'Esa clase se dio normalmente.',
      detail: `El ${ES(lostDate)} hay clase registrada con este alumno: no hay nada que recuperar.`,
    };
  }

  // LA SALIDA: no consta nada. Puede ser un aviso que se dio por WhatsApp y
  // nunca se registró — el caso más común de agosto (54 de 187).
  return {
    ok: false, kind: 'sin_registro',
    title: 'No hay ninguna clase registrada ese día.',
    detail: `No consta nada del ${ES(lostDate)}. Si el alumno avisó de que no venía, registralo ahora y seguimos con la recuperación.`,
    offerRegister: true,
  };
}

/**
 * Las recuperaciones que ya existen para ese alumno, de las dos vías por las que
 * se crean: las celdas 'bloqueado' del calendario y los `class_records` de tipo
 * recuperación. Las dos, porque las dos guardan la fecha saldada por separado.
 */
export function existingRecoveriesOf(opts: {
  studentName: string;
  classRecords: ClassRecord[];
  /** Celdas de recuperación del calendario, ya resueltas a su fecha real. */
  recoveryCells: Array<{ studentName: string; date: string; hour?: string; recoveryFor?: string }>;
}): ExistingRecovery[] {
  const alumno = nk(opts.studentName);
  const out: ExistingRecovery[] = [];
  for (const c of opts.recoveryCells) {
    if (nk(c.studentName) !== alumno || !c.recoveryFor) continue;
    out.push({ studentName: c.studentName, date: c.date, hour: c.hour, recoveryFor: c.recoveryFor });
  }
  for (const r of opts.classRecords) {
    if (nk(r.studentName) !== alumno || !r.recoveryForDate) continue;
    // Con la hora: la celda del calendario y su constancia son LA MISMA hora de
    // recuperación, y `countRecoveredHours` las funde por (fecha, hora).
    out.push({ studentName: r.studentName, date: r.classDate, hour: r.classTime, recoveryFor: r.recoveryForDate });
  }
  return out;
}
