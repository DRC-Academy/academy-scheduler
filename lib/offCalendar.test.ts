import { describe, it, expect } from 'vitest';
import type { Assignment, Grid } from '@/types';
import { findOffCalendar, removalText } from './offCalendar';

const asg = (p: Partial<Assignment> & { id: string; teacherId: string; studentName: string }): Assignment => ({
  teacherName: p.teacherId, teacherEmail: '', studentId: `s_${p.id}`, studentEmail: '', studentLevel: 'B1',
  slots: [], objetivo: '', plan: '', weeklyHours: 1, availability: '', notes: '', createdAt: '2026-07-01',
  status: 'active', ...p,
});

const grids = new Map<string, Grid>([
  ['t24', {
    'Martes_21:00': { state: 'ocupado', student: 'Zulena Rosero' },
    'Lunes_10:00':  { state: 'ocupado', student: 'Maria  Lopez' },
    'Viernes_21:00': { state: 'no_work' },
    'Jueves_09:00': { state: 'libre' },
    'Domingo_10:00': { state: 'ocupado', student: 'Oculta' },
  }],
  ['t9', { 'Lunes_18:00': { state: 'ocupado', student: 'Pedro' } }],
]);
const teacherNames = new Map([['t24', 'Liliana'], ['t9', 'Carmela']]);

function causeOf(a: Assignment) {
  return findOffCalendar({ assignments: [a], grids, teacherNames })[0]?.cause;
}

describe('findOffCalendar', () => {
  it('no lista a quien se ve en su calendario', () => {
    expect(causeOf(asg({ id: '1', teacherId: 't24', studentName: 'zulena rosero ' }))).toBeUndefined();
  });

  it('nombre escrito distinto en su calendario', () => {
    expect(causeOf(asg({ id: '2', teacherId: 't24', studentName: 'María López' })))
      .toEqual({ kind: 'nombre_distinto', gridNames: ['Maria  Lopez'] });
  });

  it('está con otro profesor', () => {
    expect(causeOf(asg({ id: '3', teacherId: 't24', studentName: 'Pedro' })))
      .toEqual({ kind: 'otro_profesor', others: [{ teacherId: 't9', teacherName: 'Carmela', gridName: 'Pedro' }] });
  });

  it('en una casilla que no se dibuja (domingo)', () => {
    expect(causeOf(asg({ id: '4', teacherId: 't24', studentName: 'Oculta' })))
      .toEqual({ kind: 'oculto', keys: ['Domingo_10:00'] });
  });

  it('sin horario: distingue "tuvo y se lo quitaron" (inactiva) de "nunca"', () => {
    expect(causeOf(asg({ id: '5', teacherId: 't24', studentName: 'Nadie', status: 'inactive' }))).toEqual({ kind: 'sin_horario', tuvo: true });
    expect(causeOf(asg({ id: '6', teacherId: 't24', studentName: 'Nadie' }))).toEqual({ kind: 'sin_horario', tuvo: false });
    expect(causeOf(asg({ id: '7', teacherId: 't77', studentName: 'Nadie' }))).toEqual({ kind: 'sin_calendario' });
  });

  it('excluye al profesor de prueba t1', () => {
    expect(causeOf(asg({ id: '8', teacherId: 't1', studentName: 'Prueba' }))).toBeUndefined();
  });

  it('el estado de cada horario de la ficha (caso María do Mar)', () => {
    const row = findOffCalendar({
      assignments: [asg({ id: '9', teacherId: 't24', studentName: 'María do Mar Campos Souto', slots: [
        { day: 'Martes', hour: '21:00' }, { day: 'Viernes', hour: '21:00' }, { day: 'Jueves', hour: '09:00' }, { day: 'Sábado', hour: '09:00' },
      ] })],
      grids, teacherNames,
    })[0];
    expect(row.slotStatus.map(s => s.state)).toEqual(['ocupado', 'no_work', 'libre', 'sin_casilla']);
    expect(row.slotStatus[0].occupant).toBe('Zulena Rosero');
  });
});

describe('removalText', () => {
  it('sin dato: casos viejos', () => {
    expect(removalText(asg({ id: 'x', teacherId: 't24', studentName: 'A', status: 'inactive' }))).toMatch(/No hay registro/);
  });
  it('quita manual con quién y cuándo (hora de España)', () => {
    expect(removalText(asg({
      id: 'y', teacherId: 't24', studentName: 'A', status: 'inactive',
      calendarRemovedAt: '2026-09-28T22:30:00Z', calendarRemovedManual: true, calendarRemovedBy: 'Carmela', calendarRemovedRole: 'teacher',
    }))).toBe('Lo quitó Carmela (profesor) del calendario el 29/09/2026.');
  });
});
