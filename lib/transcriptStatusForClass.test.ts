// "Cuando un transcript se sube, TODO el sistema lo considera subido": la regla
// común (transcriptStatusForClass) que usan el pop-up de Mis clases, la ficha,
// la campanita y el email, y el estado local que la app actualiza al guardar.
//
// Octubre de 2026 es horario de verano en Madrid hasta el 25 (UTC+2).
import { describe, it, expect } from 'vitest';
import {
  transcriptStatusForClass, transcriptStatusNeedsTeacher, studentLostRecordFor,
  type ClassRecordRef, type ClassTranscriptRef,
} from '@/lib/transcriptDeadline';
import { pendingClassesFor } from '@/lib/pendingClasses';
import {
  mergeLocalTranscripts, upsertTranscript, savedTranscriptRow, type LocalTranscript,
} from '@/lib/transcriptSaved';
import type { ClassJoinLog } from '@/types';
import type { ClassAnalysisRow } from '@/lib/aiTypes';

const madrid = (iso: string, hour: number) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), hour - 2);

const T = 't9';
const DIA = '2026-10-14';
const base = { teacherId: T, studentName: 'Ana Pérez', date: DIA, startHour: '18:00', durationHours: 1 };
const tarde = madrid('2026-10-16', 12);   // el plazo (15/10 19:00) ya pasó

const tx = (over: Partial<ClassTranscriptRef> = {}): ClassTranscriptRef =>
  ({ id: 'ca1', teacher_id: T, student_name: 'Ana Pérez', class_date: DIA, has_transcript: true, validation_status: 'ok', ...over });
const falta = (over: Partial<ClassRecordRef> = {}): ClassRecordRef =>
  ({ teacherId: T, studentName: 'Ana Pérez', classDate: DIA, classTime: '18:00', classType: 'falta_sin_aviso', ...over });

describe('transcriptStatusForClass — la regla común', () => {
  it('sin transcript y con el plazo pasado → vencido: el profesor tiene que subirlo', () => {
    const r = transcriptStatusForClass({ ...base, analyses: [], now: tarde });
    expect(r.status).toBe('vencido');
    expect(transcriptStatusNeedsTeacher(r)).toBe(true);
  });

  it('con el transcript vinculado a su ingreso → subido, aunque lleve OTRA fecha', () => {
    const r = transcriptStatusForClass({
      ...base, analyses: [tx({ class_date: '2026-10-15', join_log_id: 'jl1' })], joinLogIds: ['jl1'], now: tarde,
    });
    expect(r.status).toBe('subido');
    expect(transcriptStatusNeedsTeacher(r)).toBe(false);
  });

  it('en revisión del equipo también es subido: no se le vuelve a pedir', () => {
    const r = transcriptStatusForClass({ ...base, analyses: [tx({ validation_status: 'review' })], now: tarde });
    expect(r.status).toBe('subido');
    expect(transcriptStatusNeedsTeacher(r)).toBe(false);
  });

  it('rechazado → hay que subir el correcto', () => {
    const r = transcriptStatusForClass({ ...base, analyses: [tx({ validation_status: 'rejected' })], now: tarde });
    expect(transcriptStatusNeedsTeacher(r)).toBe(true);
  });

  it('falta sin aviso del alumno → no_aplica: NUNCA pide transcript', () => {
    const r = transcriptStatusForClass({ ...base, analyses: [], records: [falta()], now: tarde });
    expect(r.status).toBe('no_aplica');
    expect(transcriptStatusNeedsTeacher(r)).toBe(false);
  });

  it('cancelación sobre la hora del alumno → no_aplica', () => {
    const r = transcriptStatusForClass({ ...base, analyses: [], records: [falta({ classType: 'cancelacion_hora' })], now: tarde });
    expect(r.status).toBe('no_aplica');
  });

  it('la falta de OTRA hora del mismo día no tapa esta clase', () => {
    const r = transcriptStatusForClass({ ...base, analyses: [], records: [falta({ classTime: '12:00' })], now: tarde });
    expect(r.status).toBe('vencido');
  });

  it('la falta revertida por el admin vuelve a pedir transcript', () => {
    const r = transcriptStatusForClass({ ...base, analyses: [], records: [falta({ classType: 'falta_sin_aviso_revertida' })], now: tarde });
    expect(r.status).toBe('vencido');
  });

  it('sesión de 2 h: una falta registrada a la segunda hora cuenta para la sesión', () => {
    const r = transcriptStatusForClass({
      ...base, durationHours: 2, analyses: [], records: [falta({ classTime: '19:00' })], now: tarde,
    });
    expect(r.status).toBe('no_aplica');
  });

  it('sesión de 2 h con UN transcript → subida entera', () => {
    const r = transcriptStatusForClass({
      ...base, durationHours: 2, analyses: [tx({ join_log_id: 'jl2' })], joinLogIds: ['jl1', 'jl2'], now: tarde,
    });
    expect(r.status).toBe('subido');
  });

  it('studentLostRecordFor no mira otras fechas ni otros profesores', () => {
    expect(studentLostRecordFor([falta({ classDate: '2026-10-15' })], base)).toBeUndefined();
    expect(studentLostRecordFor([falta({ teacherId: 'otro' })], base)).toBeUndefined();
    expect(studentLostRecordFor([falta({ studentName: '  ana pérez ' })], base)).toBeDefined();
  });
});

describe('ficha del alumno — clases pendientes de transcript', () => {
  const log = (id: string, date: string, time: string): ClassJoinLog =>
    ({ id, teacherId: T, teacherName: 'Prof', studentName: 'Ana Pérez', scheduledDate: date, scheduledTime: time } as ClassJoinLog);

  it('una falta sin aviso con ingreso (el profe entró, el alumno no vino) NO aparece como pendiente', () => {
    const pending = pendingClassesFor({
      studentName: 'Ana Pérez', teacherId: T,
      joinLogs: [log('jl1', DIA, '18:00'), log('jl2', '2026-10-15', '18:00')],
      analyses: [], records: [falta()], now: tarde,
    });
    expect(pending.map(p => p.date)).toEqual(['2026-10-15']);
  });

  it('doble clic en "Ingresar" = una sola clase pendiente, y un transcript la cierra', () => {
    const joinLogs = [log('jl1', DIA, '18:00'), log('jl1b', DIA, '18:00')];
    expect(pendingClassesFor({ studentName: 'Ana Pérez', teacherId: T, joinLogs, analyses: [], now: tarde })).toHaveLength(1);
    const conTx = pendingClassesFor({
      studentName: 'Ana Pérez', teacherId: T, joinLogs,
      analyses: [tx({ join_log_id: 'jl1b' }) as unknown as ClassAnalysisRow], now: tarde,
    });
    expect(conTx).toHaveLength(0);
  });
});

describe('estado local al guardar un transcript', () => {
  const row = savedTranscriptRow({ id: 'ca9', teacherId: T, studentName: 'Ana Pérez', classDate: DIA, joinLogId: 'jl1', decision: 'ok', now: 1000 });

  it('la fila guardada cuenta como subida para la regla común al instante', () => {
    const analyses = upsertTranscript<ClassTranscriptRef>([], row);
    const r = transcriptStatusForClass({ ...base, analyses, joinLogIds: ['jl1'], now: tarde });
    expect(r.status).toBe('subido');
  });

  it('una validación que no es "ok" queda en revisión (subido, no pagable)', () => {
    expect(savedTranscriptRow({ id: 'x', studentName: 'A', decision: 'review' }).validation_status).toBe('review');
    expect(savedTranscriptRow({ id: 'x', studentName: 'A' }).validation_status).toBe('review');
  });

  it('un reemplazo actualiza la fila por id y conserva alumno y fecha', () => {
    const old = tx({ id: 'ca9', validation_status: 'rejected', class_date: '2026-10-13', student_name: 'Ana Pérez' });
    const out = upsertTranscript([old], savedTranscriptRow({ id: 'ca9', studentName: 'otro', classDate: '2099-01-01', decision: 'ok' }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ validation_status: 'ok', class_date: '2026-10-13', student_name: 'Ana Pérez' });
  });

  it('una carga que salió ANTES de guardar no borra el transcript recién guardado', () => {
    const local = new Map<string, LocalTranscript>([['ca9', { row, at: 2000 }]]);
    const merged = mergeLocalTranscripts<ClassTranscriptRef>([tx({ id: 'ca1' })], local, 1500);
    expect(merged.map(r => r.id).sort()).toEqual(['ca1', 'ca9']);
    expect(local.size).toBe(1);   // sigue esperando a una carga que lo traiga
  });

  it('una carga que salió DESPUÉS de guardar ya lo trae: se suelta el local', () => {
    const local = new Map<string, LocalTranscript>([['ca9', { row, at: 2000 }]]);
    const fetched = [tx({ id: 'ca9' })];
    expect(mergeLocalTranscripts<ClassTranscriptRef>(fetched, local, 2500)).toBe(fetched);
    expect(local.size).toBe(0);
  });

  it('carga vieja con la fila ANTES del reemplazo (rechazada) → manda lo guardado', () => {
    const local = new Map<string, LocalTranscript>([['ca9', { row, at: 2000 }]]);
    const merged = mergeLocalTranscripts<ClassTranscriptRef>([tx({ id: 'ca9', validation_status: 'rejected' })], local, 1500);
    expect(merged).toHaveLength(1);
    expect(merged[0].validation_status).toBe('ok');
  });
});
