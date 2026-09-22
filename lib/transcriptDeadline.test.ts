// Plazo de 24 h del transcript: la regla única que comparten Mis clases, la
// ficha del alumno, Asistencias, Finanzas y el cron de avisos.
//
// Todo con el reloj fijo (`now` por parámetro) y horas de pared ESPAÑOLAS:
// septiembre de 2026 es horario de verano (UTC+2), así que las 19:00 de Madrid
// son las 17:00Z.
import { describe, it, expect } from 'vitest';
import {
  getTranscriptStatus, findTranscriptFor, classEndEpoch, hoursLeftLabel, countdownLabel, subjectToDeadline,
  transcriptDeadlineBadge, transcriptCell, uploadDelayLabel,
  TRANSCRIPT_DEADLINE_START_DATE, TRANSCRIPT_WARN_HOURS,
  type ClassTranscriptRef, type TranscriptExclusions,
} from '@/lib/transcriptDeadline';
import { calculateTeacherFinance } from '@/lib/finance';
import { EMPTY_GRID_OCCUPANCY } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog, FinanceRate, Student } from '@/types';

const H = 3_600_000;
/** Instante de una hora de pared de Madrid en verano (UTC+2). */
const madrid = (iso: string, hour: number, minute = 0) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), hour - 2, minute);

const ok: ClassTranscriptRef = { id: 'ca1', student_name: 'Ana', class_date: '2026-09-23', has_transcript: true, validation_status: 'ok' };

describe('getTranscriptStatus', () => {
  const base = { date: '2026-09-23', startHour: '18:00', durationHours: 1 };

  it('falta del alumno → no_aplica, sin plazo', () => {
    const r = getTranscriptStatus({ ...base, classType: 'falta_sin_aviso', now: madrid('2026-09-30', 12) });
    expect(r.status).toBe('no_aplica');
    expect(r.deadlineAt).toBeNull();
  });

  it('subido (validado o en revisión) → subido, aunque haya pasado el plazo', () => {
    const now = madrid('2026-09-30', 12);
    expect(getTranscriptStatus({ ...base, transcript: ok, now }).status).toBe('subido');
    expect(getTranscriptStatus({ ...base, transcript: { ...ok, validation_status: 'review' }, now }).status).toBe('subido');
  });

  it('rechazado sigue pendiente y el plazo le corre', () => {
    const r = getTranscriptStatus({ ...base, transcript: { ...ok, validation_status: 'rejected' }, now: madrid('2026-09-30', 12) });
    expect(r.status).toBe('vencido');
    expect(r.transcriptState).toBe('rejected');
  });

  it('clase anterior a la fecha de corte: pendiente para siempre, sin plazo', () => {
    const r = getTranscriptStatus({ ...base, date: '2026-09-21', now: madrid('2027-01-01', 12) });
    expect(r.status).toBe('pendiente');
    expect(r.subjectToDeadline).toBe(false);
    expect(r.deadlineAt).toBeNull();
    expect(r.hoursLeft).toBeNull();
  });

  it('el plazo son 24 h desde el FIN de la clase (18:00 → 19:00 → 19:00 del día siguiente)', () => {
    const r = getTranscriptStatus({ ...base, now: madrid('2026-09-23', 20) });
    expect(r.status).toBe('pendiente');
    expect(r.deadlineAt).toBe(madrid('2026-09-24', 19));
    expect(r.hoursLeft).toBeCloseTo(23, 5);
    expect(r.urgent).toBe(false);
  });

  it('una sesión de 2 h vence desde el final de la segunda hora', () => {
    const r = getTranscriptStatus({ ...base, durationHours: 2, now: madrid('2026-09-23', 20) });
    expect(r.deadlineAt).toBe(madrid('2026-09-24', 20));
  });

  it('por debajo de 6 h es urgente; pasado el plazo, vencido', () => {
    const urgente = getTranscriptStatus({ ...base, now: madrid('2026-09-24', 19) - 5 * H });
    expect(urgente.status).toBe('pendiente');
    expect(urgente.urgent).toBe(true);
    expect(urgente.hoursLeft).toBeLessThan(TRANSCRIPT_WARN_HOURS);

    const vencido = getTranscriptStatus({ ...base, now: madrid('2026-09-24', 19) + 60_000 });
    expect(vencido.status).toBe('vencido');
    expect(vencido.hoursLeft).toBeLessThan(0);
  });

  it('la reapertura del admin manda sobre el plazo derivado', () => {
    const reabierto = new Date(madrid('2026-09-26', 12)).toISOString();
    const r = getTranscriptStatus({ ...base, reopenedDeadlineAt: reabierto, now: madrid('2026-09-25', 12) });
    expect(r.status).toBe('pendiente');
    expect(r.reopened).toBe(true);
    expect(r.deadlineAt).toBe(madrid('2026-09-26', 12));
    // …y también puede volver a vencer.
    expect(getTranscriptStatus({ ...base, reopenedDeadlineAt: reabierto, now: madrid('2026-09-26', 13) }).status).toBe('vencido');
  });

  it('sin hora conocida se asume que la clase terminó a fin de día (nunca vence antes de tiempo)', () => {
    expect(classEndEpoch('2026-09-23', '', 1)).toBe(madrid('2026-09-24', 0));
    const r = getTranscriptStatus({ ...base, startHour: '', now: madrid('2026-09-24', 20) });
    expect(r.status).toBe('pendiente');
  });

  it('subjectToDeadline respeta la fecha de corte', () => {
    expect(subjectToDeadline(TRANSCRIPT_DEADLINE_START_DATE)).toBe(true);
    expect(subjectToDeadline('2026-09-21')).toBe(false);
    expect(subjectToDeadline('')).toBe(false);
  });
});

// ── La subida: cuándo llegó y si entró en las 24 h ───────────────────────────
// Es lo que mira el admin en la columna "Transcript" y en la pestaña Transcripts.
describe('getTranscriptStatus · la subida', () => {
  const base = { date: '2026-09-23', startHour: '18:00', durationHours: 1 };
  const ahora = madrid('2026-09-30', 12);
  // Clase 18:00–19:00 del 23/09 → vence el 24/09 a las 19:00 (hora de Madrid).
  const subidoA = (iso: string): ClassTranscriptRef => ({ ...ok, analyzed_at: iso });

  it('a tiempo: dentro de las 24 h, con su id y su fecha de subida', () => {
    const r = getTranscriptStatus({ ...base, transcript: subidoA(new Date(madrid('2026-09-23', 22)).toISOString()), now: ahora });
    expect(r.status).toBe('subido');
    expect(r.uploadedWithinDeadline).toBe(true);
    expect(r.analysisId).toBe('ca1');
    expect(r.deadlineAt).toBe(madrid('2026-09-24', 19));
    // El fin de la clase también viaja: de ahí sale la demora.
    expect(r.endsAt).toBe(madrid('2026-09-23', 19));
  });

  it('tarde: fuera de las 24 h', () => {
    const r = getTranscriptStatus({ ...base, transcript: subidoA(new Date(madrid('2026-09-25', 10)).toISOString()), now: ahora });
    expect(r.status).toBe('subido');
    expect(r.uploadedWithinDeadline).toBe(false);
  });

  it('justo en el límite cuenta como dentro', () => {
    const r = getTranscriptStatus({ ...base, transcript: subidoA(new Date(madrid('2026-09-24', 19)).toISOString()), now: ahora });
    expect(r.uploadedWithinDeadline).toBe(true);
  });

  it('sesión de 2 h: el plazo corre desde el final de la segunda hora', () => {
    // 18:00–20:00 → vence el 24/09 a las 20:00. Subir a las 19:30 del 24 es DENTRO.
    const r = getTranscriptStatus({
      ...base, durationHours: 2,
      transcript: subidoA(new Date(madrid('2026-09-24', 19, 30)).toISOString()), now: ahora,
    });
    expect(r.endsAt).toBe(madrid('2026-09-23', 20));
    expect(r.uploadedWithinDeadline).toBe(true);
  });

  it('clase anterior al 22/09: no se juzga hacia atrás (null, que no es "fuera")', () => {
    const r = getTranscriptStatus({
      ...base, date: '2026-09-15',
      transcript: subidoA(new Date(madrid('2026-09-20', 10)).toISOString()), now: ahora,
    });
    expect(r.status).toBe('subido');
    expect(r.subjectToDeadline).toBe(false);
    expect(r.deadlineAt).toBeNull();
    expect(r.uploadedWithinDeadline).toBeNull();
  });

  it('el plazo reabierto por el admin manda sobre las 24 h', () => {
    const reabierto = new Date(madrid('2026-09-27', 12)).toISOString();
    const r = getTranscriptStatus({
      ...base, reopenedDeadlineAt: reabierto,
      transcript: subidoA(new Date(madrid('2026-09-26', 9)).toISOString()), now: ahora,
    });
    expect(r.reopened).toBe(true);
    expect(r.uploadedWithinDeadline).toBe(true);   // tarde para las 24 h, a tiempo para el plazo reabierto
  });

  it('sin fecha de subida (fila vieja sin analyzed_at) no se inventa un veredicto', () => {
    const r = getTranscriptStatus({ ...base, transcript: ok, now: ahora });
    expect(r.status).toBe('subido');
    expect(r.uploadedAt).toBeNull();
    expect(r.uploadedWithinDeadline).toBeNull();
  });

  it('pendiente, vencido y no_aplica no traen subida', () => {
    for (const input of [
      { ...base, now: ahora },                                            // vencido
      { ...base, date: '2026-09-29', now: madrid('2026-09-29', 20) },     // pendiente
      { ...base, classType: 'falta_sin_aviso', now: ahora },              // no aplica
    ]) {
      const r = getTranscriptStatus(input);
      expect(r.uploadedAt).toBeNull();
      expect(r.uploadedWithinDeadline).toBeNull();
      expect(r.analysisId).toBeNull();
    }
  });
});

describe('uploadDelayLabel', () => {
  const fin = madrid('2026-09-23', 19);
  const mas = (ms: number) => new Date(fin + ms).toISOString();

  it('minutos, horas y días', () => {
    expect(uploadDelayLabel(fin, mas(40 * 60_000))).toBe('40 min');
    expect(uploadDelayLabel(fin, mas(3 * H + 20 * 60_000))).toBe('3 h 20 min');
    expect(uploadDelayLabel(fin, mas(2 * H))).toBe('2 h');
    expect(uploadDelayLabel(fin, mas(52 * H))).toBe('2 d 4 h');
    expect(uploadDelayLabel(fin, mas(48 * H))).toBe('2 d');
  });

  it('subido antes de que la clase terminara, o en el mismo minuto, no es "0 min"', () => {
    expect(uploadDelayLabel(fin, mas(-30 * 60_000))).toBe('En el momento');
    expect(uploadDelayLabel(fin, mas(20_000))).toBe('En el momento');
  });

  it('sin alguno de los dos extremos, vacío', () => {
    expect(uploadDelayLabel(null, mas(H))).toBe('');
    expect(uploadDelayLabel(fin, null)).toBe('');
  });
});

describe('transcriptCell', () => {
  const base = { date: '2026-09-23', startHour: '18:00', durationHours: 1 };
  const ahora = madrid('2026-09-30', 12);

  it('sin ingreso (undefined) → guion gris, no un reclamo', () => {
    const c = transcriptCell(undefined);
    expect(c.icon).toBe('—');
    expect(c.tone).toBe('muted');
  });

  it('validado verde, en revisión azul: subido no es lo mismo que pagable', () => {
    const subido = { ...ok, analyzed_at: new Date(madrid('2026-09-23', 22)).toISOString() };
    const v = transcriptCell(getTranscriptStatus({ ...base, transcript: subido, now: ahora }));
    expect(v.icon).toBe('✓');
    expect(v.color).toBe('#1E9E3A');
    expect(v.title).toContain('dentro de las 24 h');

    const rev = transcriptCell(getTranscriptStatus({ ...base, transcript: { ...subido, validation_status: 'review' }, now: ahora }));
    expect(rev.icon).toBe('✓');
    expect(rev.color).toBe('#2563eb');
    expect(rev.title).toContain('no es pagable');
  });

  it('vencido en rojo y falta sin aviso en gris', () => {
    expect(transcriptCell(getTranscriptStatus({ ...base, now: ahora })).icon).toBe('✗');
    expect(transcriptCell(getTranscriptStatus({ ...base, classType: 'falta_sin_aviso', now: ahora })).tone).toBe('muted');
  });
});

describe('findTranscriptFor', () => {
  const args = { teacherId: 't1', studentName: 'Ana', dateIso: '2026-09-23' };

  it('primero el vinculado por join_log_id, aunque tenga otra fecha', () => {
    const linked: ClassTranscriptRef = { id: 'x', student_name: 'Ana', class_date: '2026-09-25', has_transcript: true, join_log_id: 'j1' };
    const sameDay: ClassTranscriptRef = { id: 'y', student_name: 'Ana', class_date: '2026-09-23', has_transcript: true };
    expect(findTranscriptFor([sameDay, linked], { ...args, joinLogIds: ['j1'] })?.id).toBe('x');
  });

  it('después, la fecha exacta; uno vinculado a OTRO ingreso no cuenta', () => {
    const otra: ClassTranscriptRef = { id: 'z', student_name: 'Ana', class_date: '2026-09-23', has_transcript: true, join_log_id: 'j9' };
    expect(findTranscriptFor([otra], { ...args, joinLogIds: ['j1'] })).toBeUndefined();
    expect(findTranscriptFor([otra], args)?.id).toBe('z');   // sin ingresos conocidos, vale
  });

  it('±1 día solo para clases anteriores al plazo', () => {
    const vecino = (date: string): ClassTranscriptRef => ({ id: 'v', student_name: 'Ana', class_date: date, has_transcript: true });
    expect(findTranscriptFor([vecino('2026-09-24')], args)).toBeUndefined();
    expect(findTranscriptFor([vecino('2026-09-02')], { ...args, dateIso: '2026-09-01' })?.id).toBe('v');
  });

  it('respeta profesor, nombre normalizado y filas sin texto', () => {
    const ajeno: ClassTranscriptRef = { id: 'a', teacher_id: 't2', student_name: 'Ana', class_date: '2026-09-23', has_transcript: true };
    const vacio: ClassTranscriptRef = { id: 'b', student_name: 'ANA ', class_date: '2026-09-23', has_transcript: false };
    const bueno: ClassTranscriptRef = { id: 'c', student_name: ' ana', class_date: '2026-09-23', has_transcript: true };
    expect(findTranscriptFor([ajeno, vacio, bueno], args)?.id).toBe('c');
  });

  it('un transcript excluido no cubre dos clases (por id o por referencia)', () => {
    const used: TranscriptExclusions = new Set();
    const t: ClassTranscriptRef = { student_name: 'Ana', class_date: '2026-09-01', has_transcript: true };
    expect(findTranscriptFor([t], { ...args, dateIso: '2026-09-01', exclude: used })).toBe(t);
    expect(findTranscriptFor([t], { ...args, dateIso: '2026-09-02', exclude: used })).toBeUndefined();
  });
});

describe('etiquetas', () => {
  it('hoursLeftLabel', () => {
    expect(hoursLeftLabel(14.7)).toBe('Quedan 14 h');
    expect(hoursLeftLabel(1.2)).toBe('Queda 1 h');
    expect(hoursLeftLabel(0.5)).toBe('Quedan 30 min');
    expect(hoursLeftLabel(-1)).toBe('Plazo vencido');
    expect(hoursLeftLabel(null)).toBe('');
  });

  it('el badge de vencida es rojo y dice lo mismo en todas las vistas', () => {
    const r = getTranscriptStatus({ date: '2026-09-23', startHour: '18:00', durationHours: 1, now: madrid('2026-09-30', 12) });
    const b = transcriptDeadlineBadge(r);
    expect(b.tone).toBe('expired');
    expect(b.label).toBe('Vencida — no validada');
  });
});

describe('calculateTeacherFinance con el plazo', () => {
  const T = 't1';
  const asg: Assignment = {
    id: 'a1', teacherId: T, teacherName: 'Profe', studentId: 's1', studentName: 'Ana', studentEmail: 'ana@x.com',
    studentLevel: 'B1', plan: 'Inglés general', weeklyHours: 1, slots: [{ day: 'Miércoles', hour: '18:00' }],
    createdAt: '2026-01-01', startDate: '2026-01-01',
  } as unknown as Assignment;
  const rates: FinanceRate[] = [
    { id: 'r1', planType: 'general', tier: 'antiguo', rate: 10 },
    { id: 'r2', planType: 'general', tier: 'nuevo', rate: 8 },
  ] as FinanceRate[];
  const students: Student[] = [];
  const log = (over: Partial<ClassJoinLog>): ClassJoinLog => ({
    id: 'j1', teacherId: T, teacherName: 'Profe', studentName: 'Ana', scheduledDate: '2026-09-23',
    scheduledTime: '18:00', clickedAt: '2026-09-23T16:00:00Z', punctuality: 'on_time', ...over,
  });
  const calc = (joinLogs: ClassJoinLog[], analyses: ClassTranscriptRef[], now: number) => calculateTeacherFinance({
    teacherId: T, teacherName: 'Profe', monthYear: '2026-09', assignments: [asg], joinLogs, classRecords: [],
    classAnalyses: analyses.map(a => ({ ...a, teacher_id: T })), rates, scoringEvents: [], students, manualApprovals: [],
    payment: null, teacherBonuses: [], gridOccupancy: EMPTY_GRID_OCCUPANCY, now,
  });

  it('sin transcript y dentro del plazo → a_revisar con la cuenta regresiva', () => {
    const r = calc([log({})], [], madrid('2026-09-23', 20));
    expect(r.rows[0].status).toBe('a_revisar');
    expect(r.rows[0].deadline.status).toBe('pendiente');
    expect(r.totalVencidas).toBe(0);
  });

  it('sin transcript y pasado el plazo → vencida: no suma al total pero sí al cupo', () => {
    const r = calc([log({})], [], madrid('2026-09-30', 12));
    expect(r.rows[0].status).toBe('vencida');
    expect(r.rows[0].joinLogId).toBe('j1');
    expect(r.totalPagable).toBe(0);
    expect(r.montoPagable).toBe(0);
    expect(r.totalVencidas).toBe(1);
    expect(r.montoVencidas).toBe(10);
    expect(r.totalARevisar).toBe(0);
    expect(r.studentQuota[0].used).toBe(1);
  });

  it('con transcript validado → pagable aunque se haya subido tarde', () => {
    const r = calc([log({})], [{ ...ok, join_log_id: 'j1' }], madrid('2026-09-30', 12));
    expect(r.rows[0].status).toBe('pagable');
  });

  it('con el plazo reabierto por el admin vuelve a a_revisar', () => {
    const reabierto = new Date(madrid('2026-10-01', 12)).toISOString();
    const r = calc([log({ transcriptDeadlineAt: reabierto })], [], madrid('2026-09-30', 12));
    expect(r.rows[0].status).toBe('a_revisar');
    expect(r.rows[0].deadline.reopened).toBe(true);
  });

  it('las clases anteriores al 22/09/2026 nunca vencen', () => {
    const r = calc([log({ scheduledDate: '2026-09-10' })], [], madrid('2026-12-01', 12));
    expect(r.rows[0].status).toBe('a_revisar');
  });
});

describe('countdownLabel (botón)', () => {
  it('horas y minutos, redondeando hacia arriba el minuto', () => {
    expect(countdownLabel(13.7)).toBe('13 h 42 min');
    expect(countdownLabel(2)).toBe('2 h');
    expect(countdownLabel(0.5)).toBe('30 min');
    expect(countdownLabel(0.001)).toBe('1 min');
    expect(countdownLabel(-1)).toBe('Vencido');
    expect(countdownLabel(null)).toBe('');
  });

  it('el badge puede ir sin la cuenta atrás cuando el botón ya la lleva', () => {
    const r = getTranscriptStatus({ date: '2026-09-23', startHour: '18:00', durationHours: 1, now: madrid('2026-09-23', 20) });
    expect(transcriptDeadlineBadge(r).label).toBe('Falta el transcript · Quedan 23 h');
    expect(transcriptDeadlineBadge(r, { countdown: false }).label).toBe('Falta el transcript');
  });
});
