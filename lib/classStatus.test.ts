import { describe, expect, it } from 'vitest';
import {
  findUnmarkedClasses, classStatusOf, statusFromRecord, statusDates, statusIdOf,
  CLASS_STATUS_START_DATE, TEACHER_CANCEL_COMMENT_PREFIX, DECLARED_ABSENCE_COMMENT,
  type StatusRecord, type StatusJoinLog, type StatusAbsence, type StatusReview,
} from '@/lib/classStatus';
import { absenceIdOf, type TeacherScheduleInput } from '@/lib/teacherAbsences';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { periodIndex } from '@/lib/studentPeriod';
import { spainWallClockToEpoch } from '@/lib/spainTime';
import type { ClassTranscriptRef } from '@/lib/transcriptDeadline';
import type { Assignment, Grid } from '@/types';

const MARTES = '2026-10-27';
const H = 3_600_000;
/** Final de la sesión de Ana (18:00–20:00, hora de España). */
const FIN = spainWallClockToEpoch(MARTES, 20);

function asg(name: string, slots: Array<{ day: string; hour: string }>): Assignment {
  return {
    id: `a_${name}`, teacherId: 't9', teacherName: 'Laura', teacherEmail: '', studentId: `s_${name}`,
    studentName: name, studentEmail: 'ana@x.com', studentLevel: 'B1',
    slots, objetivo: '', plan: '', weeklyHours: slots.length, availability: '', notes: '',
    startDate: '2026-09-01', createdAt: '2026-09-01T10:00:00Z', status: 'active',
  };
}

function profe(grid: Grid, assignments: Assignment[]): TeacherScheduleInput {
  const upcomingClasses = Object.entries(grid)
    .filter(([, c]) => c.state === 'ocupado' && c.student)
    .map(([k, c]) => { const i = k.lastIndexOf('_'); return { id: k, studentName: c.student!, day: k.slice(0, i), time: k.slice(i + 1), duration: 1, type: 'Clase' }; });
  return {
    teacherId: 't9', teacherName: 'Laura', assignments, grid,
    occupancy: gridOccupancyOfTeacher({ upcomingClasses }),
    periods: periodIndex(assignments, [], 't9'),
  };
}

const GRID: Grid = {
  'Martes_18:00': { state: 'ocupado', student: 'Ana Pérez' },
  'Martes_19:00': { state: 'ocupado', student: 'Ana Pérez' },
};
const ANA = asg('Ana Pérez', [{ day: 'Martes', hour: '18:00' }, { day: 'Martes', hour: '19:00' }]);

const run = (o: {
  now: number; minHours?: number; records?: StatusRecord[]; logs?: StatusJoinLog[];
  analyses?: ClassTranscriptRef[]; absences?: StatusAbsence[]; reviews?: StatusReview[]; dates?: string[];
}) => findUnmarkedClasses({
  teachers: [profe(GRID, [ANA])],
  records: o.records ?? [], joinLogs: o.logs ?? [], analyses: o.analyses ?? [],
  absences: o.absences ?? [], reviews: o.reviews ?? [],
  dates: o.dates ?? [MARTES], nowMs: o.now, minHoursAfterEnd: o.minHours ?? 24,
});

const rec = (classType: StatusRecord['classType'], extra: Partial<StatusRecord> = {}): StatusRecord =>
  ({ id: 'cr1', teacherId: 't9', studentName: 'Ana Pérez', classDate: MARTES, classTime: '18:00', classType, ...extra });

describe('cuándo una clase queda sin estado', () => {
  it('la sesión de 2 h es UNA clase y cuenta desde su final', () => {
    expect(run({ now: FIN + 24 * H - 1 })).toHaveLength(0);
    const r = run({ now: FIN + 24 * H });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ studentName: 'Ana Pérez', date: MARTES, hour: '18:00', durationHours: 2, hasJoin: false, hoursSinceEnd: 24 });
    expect(r[0].id).toBe(statusIdOf('t9', 'Ana Pérez', MARTES, 18));
  });
  it('con 0 horas sale en cuanto termina (lo que ve el profesor)', () => {
    expect(run({ now: FIN - 1, minHours: 0 })).toHaveLength(0);
    expect(run({ now: FIN, minHours: 0 })).toHaveLength(1);
  });
  it('las clases anteriores al corte no se miran nunca', () => {
    expect(run({ now: spainWallClockToEpoch('2026-10-21', 20) + 30 * H, dates: ['2026-10-20'] })).toHaveLength(0);
  });
  it('el ingreso solo no es estado, pero se anota', () => {
    const r = run({ now: FIN + 24 * H, logs: [{ id: 'j1', teacherId: 't9', studentName: 'Ana Pérez', scheduledDate: MARTES, scheduledTime: '19:00' }] });
    expect(r).toHaveLength(1);
    expect(r[0].hasJoin).toBe(true);
  });
});

describe('lo que le da estado', () => {
  const now = FIN + 30 * H;
  const tx = (validation_status?: string): ClassTranscriptRef =>
    ({ id: 'ca1', teacher_id: 't9', student_name: 'Ana Pérez', class_date: MARTES, has_transcript: true, validation_status } as ClassTranscriptRef);

  it('el transcript subido (validado o en revisión), pero no el rechazado', () => {
    expect(run({ now, analyses: [tx()] })).toHaveLength(0);
    expect(run({ now, analyses: [tx('review')] })).toHaveLength(0);
    expect(run({ now, analyses: [tx('rejected')] })).toHaveLength(1);
  });
  it('cualquier constancia de la sesión, y solo de esa sesión', () => {
    for (const t of ['falta_sin_aviso', 'cancelacion_hora', 'falta_con_aviso', 'cancelada_con_preaviso', 'cancelada_por_profesor'] as const) {
      expect(run({ now, records: [rec(t)] })).toHaveLength(0);
    }
    expect(run({ now, records: [rec('reprogramada', { rescheduledTo: '2026-10-29' })] })).toHaveLength(0);
    expect(run({ now, records: [rec('falta_sin_aviso', { classTime: '16:00' })] })).toHaveLength(1);
  });
  it('la posible ausencia detectada, salvo anulada o "llegó tarde"', () => {
    const id = absenceIdOf('t9', 'Ana Pérez', MARTES, 18);
    expect(run({ now, absences: [{ id, status: 'posible_ausencia' }] })).toHaveLength(0);
    expect(run({ now, absences: [{ id, status: 'posible_ausencia', annulledAt: '2026-10-28T10:00:00Z' }] })).toHaveLength(1);
    expect(run({ now, absences: [{ id, status: 'llego_tarde' }] })).toHaveLength(1);
  });
  it('una revisión pendiente o aprobada, pero no la rechazada', () => {
    const rv = (status: string): StatusReview => ({ teacherId: 't9', studentName: 'Ana Pérez', classDate: MARTES, classTime: '18:00', status, requestedType: 'falta_con_aviso' });
    expect(run({ now, reviews: [rv('pendiente')] })).toHaveLength(0);
    expect(run({ now, reviews: [rv('aprobada')] })).toHaveLength(0);
    expect(run({ now, reviews: [rv('rechazada')] })).toHaveLength(1);
  });
});

describe('qué estado es', () => {
  const base = { isRecovery: false, transcriptState: 'none' as const, rescheduled: false, record: null, absenceDetected: false, reviewType: null };
  it('transcript → realizada, o recuperada en una recuperación', () => {
    expect(classStatusOf({ ...base, transcriptState: 'ok' })).toBe('realizada');
    expect(classStatusOf({ ...base, transcriptState: 'review', isRecovery: true })).toBe('recuperada');
  });
  it('la cancelación del profesor se distingue de su falta por el comentario', () => {
    expect(statusFromRecord({ classType: 'cancelada_por_profesor', comment: `${TEACHER_CANCEL_COMMENT_PREFIX} — médico` })).toBe('cancelada_profesor');
    expect(statusFromRecord({ classType: 'cancelada_por_profesor', comment: DECLARED_ABSENCE_COMMENT })).toBe('profesor_ausente');
    expect(statusFromRecord({ classType: 'cancelada_por_profesor', comment: 'Solicitud de revisión aprobada por admin' })).toBe('profesor_ausente');
    expect(statusFromRecord({ classType: 'cancelada_con_preaviso', comment: '' })).toBe('cancelada_profesor');
  });
  it('las del alumno', () => {
    expect(statusFromRecord({ classType: 'falta_con_aviso' })).toBe('cancelada_alumno_antelacion');
    expect(statusFromRecord({ classType: 'cancelacion_hora' })).toBe('cancelada_alumno_tarde');
    expect(statusFromRecord({ classType: 'falta_sin_aviso' })).toBe('alumno_no_conecto');
    expect(classStatusOf({ ...base, rescheduled: true })).toBe('cancelada_alumno_antelacion');
  });
  it('la ausencia detectada y la revisión declarada', () => {
    expect(classStatusOf({ ...base, absenceDetected: true })).toBe('profesor_ausente');
    expect(classStatusOf({ ...base, reviewType: 'normal' })).toBe('realizada');
    expect(classStatusOf(base)).toBeNull();
  });
});

describe('fechas', () => {
  it('desde hace N días, nunca antes del corte', () => {
    expect(statusDates(spainWallClockToEpoch('2026-10-28', 12), 4)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
    expect(statusDates(spainWallClockToEpoch('2026-10-24', 12), 4)[0]).toBe(CLASS_STATUS_START_DATE);
  });
});
