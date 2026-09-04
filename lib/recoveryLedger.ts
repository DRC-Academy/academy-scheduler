// ── Cuántas horas de una clase perdida quedan por recuperar ──────────────────
//
// POR QUÉ EXISTE. El vínculo entre una recuperación y la clase que salda es una
// FECHA y nada más (`cell.recoveryFor` en el grid, `class_records.recovery_for_date`
// en la base). Con clases de una hora alcanzaba: una clase perdida, una
// recuperación. Con las sesiones de 2 horas ya no, porque una clase perdida de
// 2 h se puede reponer de dos maneras:
//
//   A. JUNTA   — dos horas seguidas el mismo día: un bloque de 2 h, un transcript.
//   B. PARTIDA — 1 h un día y 1 h otro: dos clases de 1 h, un transcript cada una.
//
// En los dos casos el profesor cobra 2 horas y el alumno salda su clase. Lo que
// hacía falta para poder ofrecer la opción B era saber si una clase perdida está
// saldada ENTERA o a medias — y eso es contar horas, no contar recuperaciones.
//
// NO SE PERSISTE NADA. El saldo se recalcula a partir de datos que ya existen
// (las celdas del calendario, las constancias y la duración de la clase perdida),
// igual que la duración de una sesión o su `sessionId`. Una columna nueva podría
// quedar desincronizada del calendario, que es la fuente real; este saldo no.

import { dayNameFromIso, gridRunLength, type GridOccupancy } from '@/lib/teacherClasses';
import { countRecoveredHours, type ExistingRecovery } from '@/lib/recovery';
import type { ClassRecord } from '@/types';

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Tope de sensatez: ninguna clase dura más que esto. */
const MAX_HOURS = 6;

/**
 * Horas que valía la clase que se perdió. Sale de la misma fuente que la
 * duración en finanzas —el CALENDARIO— para que "la clase perdida era de 2 h" y
 * "esa fila cobra 2 h" no puedan contradecirse.
 *
 * Devuelve 1 cuando no hay calendario que lo respalde: es el caso normal (clase
 * de una hora) y también el prudente, porque una clase perdida que se cree de
 * 2 h abriría la puerta a recuperar una hora de más.
 */
export function lostClassHours(opts: {
  studentName: string;
  /** Fecha de la clase perdida, 'YYYY-MM-DD'. */
  lostDate: string;
  classRecords: ClassRecord[];
  /** Ocupación del calendario del profesor (lib/teacherClasses). */
  occupancy?: GridOccupancy;
}): number {
  const alumno = nk(opts.studentName);
  const day = dayNameFromIso(opts.lostDate);

  // La hora de la clase perdida la da su constancia (la falta, la reprogramación…).
  const hora = opts.classRecords.find(r =>
    nk(r.studentName) === alumno && r.classDate === opts.lostDate && !!r.classTime)?.classTime;

  if (hora) {
    const run = gridRunLength(opts.occupancy, opts.studentName, day, hora);
    return run && run > 0 ? Math.min(run, MAX_HOURS) : 1;
  }

  // Sin hora en la constancia: solo se puede afirmar la duración si ese día el
  // alumno tiene UN único bloque en el calendario. Con dos bloques sueltos no se
  // sabe cuál se perdió, y se asume una hora.
  const horas = opts.occupancy?.hours.get(`${alumno}|${day}`);
  if (!horas || horas.length === 0) return 1;
  const unicas = [...new Set(horas)].sort((a, b) => a - b);
  const contiguas = unicas.every((h, i) => i === 0 || h === unicas[i - 1] + 1);
  return contiguas ? Math.min(unicas.length, MAX_HOURS) : 1;
}

export interface RecoveryLedger {
  /** Horas que valía la clase perdida. */
  lostHours: number;
  /** Horas de recuperación ya marcadas para esa clase. */
  recoveredHours: number;
  /** Lo que falta por reponer. Nunca negativo. */
  pendingHours: number;
  /** Ya no queda nada por recuperar. */
  settled: boolean;
}

/**
 * El saldo completo de una clase perdida. Es lo que mira el modal para ofrecer
 * "juntas o partida" y lo que decide si una recuperación más está de sobra.
 */
export function recoveryLedgerOf(opts: {
  studentName: string;
  lostDate: string;
  classRecords: ClassRecord[];
  /** Recuperaciones que ya existen (celdas del calendario + constancias). */
  existing: ExistingRecovery[];
  occupancy?: GridOccupancy;
  /**
   * Celda que se está marcando AHORA: no cuenta como recuperación ya hecha. Sin
   * esto, revisar una celda ya marcada diría que sobra.
   */
  exclude?: { date: string; hour?: string };
}): RecoveryLedger {
  const lostHours = lostClassHours({
    studentName: opts.studentName, lostDate: opts.lostDate,
    classRecords: opts.classRecords, occupancy: opts.occupancy,
  });
  const recoveredHours = countRecoveredHours(opts.existing, opts.studentName, opts.lostDate, opts.exclude);
  const pendingHours = Math.max(0, lostHours - recoveredHours);
  return { lostHours, recoveredHours, pendingHours, settled: pendingHours === 0 };
}
