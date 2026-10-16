import { describe, it, expect } from 'vitest';
import { buildTestAccountFilter } from './testAccounts';

const teachers = [
  { id: 'p1', name: 'Seba' },
  { id: 'tx', name: 'Profe Prueba', isTest: true },
];
const students = [
  { id: 's1', name: 'Ana Real', email: 'ana@real.com' },
  { id: 's2', name: 'Alumno Prueba', email: 'prueba@test.com', isTest: true },
];
const f = buildTestAccountFilter(teachers, students);

describe('buildTestAccountFilter', () => {
  it('sale de la marca is_test, no de un id o nombre fijo', () => {
    expect(f.isTestTeacher('tx')).toBe(true);
    expect(f.isTestTeacher('p1')).toBe(false);
    expect(f.isTestTeacher('t1')).toBe(false);   // sin marca, t1 es uno más
    expect(f.isTestTeacher(null)).toBe(false);
  });

  it('una fila de un profesor de prueba se esconde aunque el alumno sea real', () => {
    expect(f.isTestRow({ teacherId: 'tx', studentId: 's1' })).toBe(true);
  });

  it('una fila de un alumno de prueba se esconde aunque el profesor sea real', () => {
    expect(f.isTestRow({ teacherId: 'p1', studentId: 's2' })).toBe(true);
    expect(f.isTestRow({ teacherId: 'p1', studentName: '  alumno prueba ' })).toBe(true);
  });

  it('el id manda: un homónimo real de un alumno de prueba no se esconde', () => {
    expect(f.isTestRow({ teacherId: 'p1', studentId: 's1', studentName: 'Alumno Prueba' })).toBe(false);
  });

  it('sin id de profesor cruza por nombre (registro de IA viejo)', () => {
    expect(f.isTestRow({ teacherName: 'PROFE PRUEBA' })).toBe(true);
    expect(f.isTestRow({ teacherName: 'Seba' })).toBe(false);
  });

  it('sin nada marcado no esconde nada', () => {
    const vacio = buildTestAccountFilter([{ id: 't1', name: 'Sebastian (test)' }], []);
    expect(vacio.empty).toBe(true);
    expect(vacio.isTestRow({ teacherId: 't1' })).toBe(false);
  });
});
