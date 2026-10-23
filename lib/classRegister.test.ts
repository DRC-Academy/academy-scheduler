import { describe, expect, it } from 'vitest';
import {
  buildRegisterRows, filterRegisterRows, pdfRows, studentSummary, statusFromCancelRecord, pdfFileName,
  rangeHasApproxSchedule, ADMIN_RECLASSIFIED_PREFIX, joinedLabel,
  type RegisterJoinLog, type RegisterRecovery, type RegisterAbsence,
} from '@/lib/classRegister';
import { DECLARED_ABSENCE_COMMENT, TEACHER_CANCEL_COMMENT_PREFIX } from '@/lib/classStatus';
import { absenceIdOf } from '@/lib/teacherAbsences';
import { spainWallClockToEpoch } from '@/lib/spainTime';
import type { LogRow } from '@/lib/attendance';
import type { ClassTranscriptRef } from '@/lib/transcriptDeadline';
import type { ClassRecord } from '@/types';

const DIA = '2026-10-20';
const NOW = spainWallClockToEpoch('2026-10-22', 12);

const fila = (extra: Partial<LogRow> = {}): LogRow => ({
  id: `a1_${DIA}_18:00`, date: DIA, hour: '18:00', durationHours: 2, hoursLabel: '18:00 - 20:00',
  teacherId: 't9', teacherName: 'Laura', studentName: 'Ana Pérez', status: 'missed', hasLink: true, ...extra,
});
const clic = (extra: Partial<RegisterJoinLog> = {}): RegisterJoinLog => ({
  id: 'j1', teacherId: 't9', studentName: 'Ana Pérez', scheduledDate: DIA, scheduledTime: '19:00',
  clickedAt: '2026-10-20T15:58:00Z', ip: '1.2.3.4', ...extra,
});
const rec = (classType: ClassRecord['classType'], extra: Partial<ClassRecord> = {}): ClassRecord => ({
  id: 'cr1', teacherId: 't9', teacherName: 'Laura', studentName: 'Ana Pérez', classDate: DIA, classTime: '18:00',
  screenshotUrl: '', classType, createdAt: '2026-10-20T20:00:00Z', ...extra,
} as ClassRecord);

const run = (o: {
  rows?: LogRow[]; joins?: RegisterJoinLog[]; records?: ClassRecord[]; analyses?: ClassTranscriptRef[];
  absences?: RegisterAbsence[]; recoveries?: RegisterRecovery[]; now?: number;
}) => buildRegisterRows({
  attendance: o.rows ?? [fila()], joinLogs: o.joins ?? [], records: o.records ?? [], analyses: o.analyses ?? [],
  absences: o.absences ?? [], recoveries: o.recoveries ?? [], nowMs: o.now ?? NOW,
});

describe('estado de cada clase', () => {
  it('con clic: realizada, con la hora y la IP del primer ingreso de la sesión', () => {
    const [r] = run({ rows: [fila({ status: 'on_time', joinedAt: '2026-10-20T15:58:00Z' })], joins: [clic(), clic({ id: 'j2', clickedAt: '2026-10-20T16:30:00Z', ip: '9.9.9.9' })] });
    expect(r).toMatchObject({ status: 'realizada', joinedAt: '2026-10-20T15:58:00Z', ip: '1.2.3.4', hasTranscript: false });
  });
  it('sin clic pero con transcript: también realizada', () => {
    const tx = { id: 'ca1', teacher_id: 't9', student_name: 'Ana Pérez', class_date: DIA, has_transcript: true } as ClassTranscriptRef;
    expect(run({ analyses: [tx] })[0]).toMatchObject({ status: 'realizada', hasTranscript: true, joinedAt: null });
  });
  it('un transcript rechazado no cuenta', () => {
    const tx = { id: 'ca1', teacher_id: 't9', student_name: 'Ana Pérez', class_date: DIA, has_transcript: true, validation_status: 'rejected' } as ClassTranscriptRef;
    expect(run({ analyses: [tx] })[0].status).toBe('sin_registro');
  });
  it('recuperada: por constancia de recuperación, por recuperación confirmada o por clase movida', () => {
    const conClic = fila({ status: 'on_time', joinedAt: '2026-10-20T15:58:00Z' });
    expect(run({ rows: [conClic], records: [rec('recuperacion')] })[0].status).toBe('recuperada');
    expect(run({ rows: [conClic], recoveries: [{ teacherId: 't9', studentName: 'ana pérez', chosenDate: DIA, chosenHour: '18:00', status: 'confirmada' }] })[0].status).toBe('recuperada');
    expect(run({ rows: [{ ...conClic, rescheduledFrom: '2026-10-15' }] })[0].status).toBe('recuperada');
  });
  it('reprogramada sin ingreso, con la fecha de destino', () => {
    expect(run({ rows: [fila({ status: 'rescheduled', rescheduledTo: '2026-10-23' })] })[0]).toMatchObject({ status: 'reprogramada', rescheduledTo: '2026-10-23' });
  });
  it('la constancia manda sobre el clic (el profe estuvo, el alumno no)', () => {
    const conClic = fila({ status: 'on_time', joinedAt: '2026-10-20T15:58:00Z' });
    expect(run({ rows: [conClic], records: [rec('falta_sin_aviso')] })[0].status).toBe('alumno_no_conecto');
    expect(run({ records: [rec('cancelacion_hora')] })[0].status).toBe('cancelada_alumno_tarde');
    expect(run({ records: [rec('falta_con_aviso')] })[0].status).toBe('cancelada_alumno_aviso');
  });
  it('una constancia revertida no cuenta', () => {
    expect(run({ records: [rec('falta_sin_aviso', { revertedAt: '2026-10-21T10:00:00Z' })] })[0].status).toBe('sin_registro');
  });
  it('posible ausencia sin confirmar, salvo anulada', () => {
    const id = absenceIdOf('t9', 'Ana Pérez', DIA, 18);
    expect(run({ absences: [{ id, status: 'posible_ausencia' }] })[0].status).toBe('posible_ausencia');
    expect(run({ absences: [{ id, status: 'posible_ausencia', annulledAt: '2026-10-21' }] })[0].status).toBe('sin_registro');
  });
  it('una clase que aún no terminó y sin ingreso no sale', () => {
    expect(run({ now: spainWallClockToEpoch(DIA, 19, 30) })).toHaveLength(0);
  });
});

describe('cancelada_por_profesor: cancelación o falta, según quién la registró', () => {
  it('reclasificada por el admin o declarada por el profe → el profe no se conectó', () => {
    expect(statusFromCancelRecord({ classType: 'cancelada_por_profesor', comment: `${ADMIN_RECLASSIFIED_PREFIX} Facundo` })).toBe('profesor_no_conecto');
    expect(statusFromCancelRecord({ classType: 'cancelada_por_profesor', comment: DECLARED_ABSENCE_COMMENT })).toBe('profesor_no_conecto');
  });
  it('"No puedo dar esta clase" o el botón viejo → cancelada por el profe', () => {
    expect(statusFromCancelRecord({ classType: 'cancelada_por_profesor', comment: `${TEACHER_CANCEL_COMMENT_PREFIX} — médico` })).toBe('cancelada_profesor');
    expect(statusFromCancelRecord({ classType: 'cancelada_por_profesor', comment: 'Me surgió un imprevisto' })).toBe('cancelada_profesor');
    expect(statusFromCancelRecord({ classType: 'cancelada_con_preaviso', comment: '' })).toBe('cancelada_profesor');
  });
});

describe('filtros, PDF y resumen', () => {
  const rows = run({
    rows: [
      fila({ status: 'on_time', joinedAt: '2026-10-20T15:58:00Z' }),
      fila({ id: 'x2', date: '2026-10-21', studentName: 'Bruno' }),
      fila({ id: 'x3', date: '2026-10-21', studentName: 'Carla', teacherId: 't2', teacherName: 'Sol' }),
    ],
    records: [rec('falta_sin_aviso', { studentName: 'Carla', teacherId: 't2', classDate: '2026-10-21' })],
  });
  it('filtra por alumno (sin mayúsculas), profe, estado y fechas', () => {
    expect(filterRegisterRows(rows, { desde: DIA, hasta: DIA }).map(r => r.studentName)).toEqual(['Ana Pérez']);
    expect(filterRegisterRows(rows, { desde: DIA, hasta: '2026-10-21', alumno: 'ana pérez' })).toHaveLength(1);
    expect(filterRegisterRows(rows, { desde: DIA, hasta: '2026-10-21', profe: 't2' }).map(r => r.studentName)).toEqual(['Carla']);
    expect(filterRegisterRows(rows, { desde: DIA, hasta: '2026-10-21', estado: 'sin_registro' }).map(r => r.studentName)).toEqual(['Bruno']);
  });
  it('el PDF no lleva "sin registro" ni "posible ausencia"', () => {
    expect(pdfRows(rows).map(r => r.status)).toEqual(['realizada', 'alumno_no_conecto']);
  });
  it('resumen del alumno', () => {
    expect(studentSummary(pdfRows(rows))).toMatchObject({ total: 2, realizadas: 1, dadasPorRealizadas: 1, canceladasProfe: 0 });
  });
  it('nombre del archivo y aviso de horario aproximado', () => {
    expect(pdfFileName('Ana Pérez', '2026-10-01', '2026-10-22')).toBe('registro-ana-perez-2026-10-01-2026-10-22.pdf');
    expect(pdfFileName(null, '2026-10-01', '2026-10-22')).toBe('registro-todos-2026-10-01-2026-10-22.pdf');
    expect(rangeHasApproxSchedule('2026-09-27')).toBe(true);
    expect(rangeHasApproxSchedule('2026-09-28')).toBe(false);
  });
});

describe('una clase, una fila', () => {
  it('dos asignaciones del mismo alumno con el mismo profe no duplican la clase', () => {
    const dup = run({ rows: [fila({ id: 'a1' }), fila({ id: 'a2', status: 'on_time', joinedAt: '2026-10-20T15:58:00Z' })] });
    expect(dup).toHaveLength(1);
    expect(dup[0].status).toBe('realizada');
  });
});

describe('hora del ingreso', () => {
  it('solo la hora si fue el mismo día; con la fecha si fue otro', () => {
    expect(joinedLabel('2026-10-20T15:58:00Z', '2026-10-20')).toBe('17:58');
    expect(joinedLabel('2026-10-20T23:30:00Z', '2026-10-20')).toBe('21/10 01:30');
    expect(joinedLabel(null, '2026-10-20')).toBe('');
  });
});
