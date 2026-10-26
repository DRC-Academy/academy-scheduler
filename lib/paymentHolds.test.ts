// Pago pendiente (on-hold): una clase dentro de un episodio NO EXISTE.
import { describe, it, expect } from 'vitest';
import {
  isClassOnHold, holdSpansFor, openHoldFor, holdActionFor, shouldNotifyTeacher, suspendedNoticeDue,
  isOnHoldStatusNote, holdStartFromWoo, isInitialHold, noticeIdOf, SUSPENDED_EMAIL_GRACE_MIN,
  type PaymentHold,
} from '@/lib/paymentHolds';
import { periodIndex, existsForStudent, classExistsOn } from '@/lib/studentPeriod';
import { classesForDate, recoveriesForDate, gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { buildAttendanceRows } from '@/lib/attendance';
import { buildMissingJoinClasses } from '@/lib/reviewRequests';
import { spainWallClockToEpoch } from '@/lib/spainTime';
import { isPaymentHoldStatus, isAccessStatus } from '@/lib/subscriptionAccess';
import type { Assignment, Grid } from '@/types';

const T = 't_prof';
const asgn = (name: string, slots = [{ day: 'Miércoles', hour: '19:00' }, { day: 'Jueves', hour: '19:00' }]): Assignment => ({
  id: `a_${name}`, teacherId: T, teacherName: 'Florencia', teacherEmail: 'f@x.com',
  studentId: `s_${name}`, studentName: name, studentEmail: `${name.toLowerCase()}@x.com`,
  studentLevel: 'B1', slots, objetivo: '', plan: 'Inglés general', weeklyHours: 2,
  availability: '', notes: '', startDate: '2026-10-01', createdAt: '2026-10-01T00:00:00Z',
});

/** Episodio de Marisol: del jueves 22/10 a las 10:00 (España) al martes 27/10 a las 12:00. */
const hold = (over: Partial<PaymentHold> = {}): PaymentHold => ({
  id: 'hold_s_Marisol_1', studentId: 's_Marisol', studentEmail: 'marisol@x.com', studentName: 'Marisol',
  startedAt: new Date(spainWallClockToEpoch('2026-10-22', 10)).toISOString(),
  endedAt: new Date(spainWallClockToEpoch('2026-10-27', 12)).toISOString(),
  isInitial: false, endStatus: 'active', ...over,
});

describe('isClassOnHold — por el INICIO de la clase, hora de España', () => {
  const spans = holdSpansFor([hold()], { studentId: 's_Marisol' });
  it('la clase anterior al inicio del episodio existe (mismo día)', () => {
    expect(isClassOnHold(spans, '2026-10-22', 9)).toBe(false);
  });
  it('desde el inicio, bloqueada', () => {
    expect(isClassOnHold(spans, '2026-10-22', 10)).toBe(true);
    expect(isClassOnHold(spans, '2026-10-22', '19:00')).toBe(true);
    expect(isClassOnHold(spans, '2026-10-25', 19)).toBe(true);   // tras el cambio de hora (25/10)
  });
  it('el día que paga: antes de pagar bloqueada, después vuelve', () => {
    expect(isClassOnHold(spans, '2026-10-27', 11)).toBe(true);
    expect(isClassOnHold(spans, '2026-10-27', 12)).toBe(false);
    expect(isClassOnHold(spans, '2026-10-27', 19)).toBe(false);
  });
  it('un episodio abierto bloquea todo lo que viene', () => {
    const open = holdSpansFor([hold({ endedAt: null })], { studentName: 'marisol' });
    expect(isClassOnHold(open, '2026-12-31', 19)).toBe(true);
  });
});

describe('emparejar alumno y episodios', () => {
  it('por id, email o nombre (sin mayúsculas)', () => {
    expect(holdSpansFor([hold()], { studentId: 's_Marisol' })).toHaveLength(1);
    expect(holdSpansFor([hold()], { studentEmail: 'MARISOL@x.com ' })).toHaveLength(1);
    expect(holdSpansFor([hold()], { studentName: ' marisol' })).toHaveLength(1);
    expect(holdSpansFor([hold()], { studentName: 'Otra' })).toHaveLength(0);
  });
  it('openHoldFor solo devuelve el abierto', () => {
    expect(openHoldFor([hold()], { studentId: 's_Marisol' })).toBeNull();
    expect(openHoldFor([hold({ endedAt: null })], { studentId: 's_Marisol' })?.id).toBe('hold_s_Marisol_1');
  });
});

describe('el período del alumno aplica los episodios', () => {
  const asgs = [asgn('Marisol'), asgn('Otra')];
  const idx = periodIndex(asgs, [], T, [hold()]);
  it('con hora: la clase dentro del episodio no existe', () => {
    expect(existsForStudent(idx, 'Marisol', '2026-10-22', '19:00')).toBe(false);
    expect(existsForStudent(idx, 'Marisol', '2026-10-28', '19:00')).toBe(true);
    expect(existsForStudent(idx, 'Otra', '2026-10-22', '19:00')).toBe(true);
  });
  it('sin hora: el período de siempre (los episodios necesitan la hora)', () => {
    expect(existsForStudent(idx, 'Marisol', '2026-10-22')).toBe(true);
  });
  it('sin episodios, idéntico a antes', () => {
    const p = periodIndex(asgs, [], T).get('marisol')!;
    expect(p.holds).toBeUndefined();
    expect(classExistsOn(p, '2026-10-22', '19:00')).toBe(true);
  });
  it('classesForDate no proyecta la clase bloqueada', () => {
    expect(classesForDate(asgs, '2026-10-22', idx).map(c => c.studentName)).toEqual(['Otra']);
    expect(classesForDate(asgs, '2026-10-22').map(c => c.studentName).sort()).toEqual(['Marisol', 'Otra']);
  });
  it('recoveriesForDate tampoco (solo mira los episodios)', () => {
    // Celda de recuperación del jueves 22/10 (semana del lunes 19/10).
    const grid = { 'Jueves_16:00': { state: 'bloqueado', student: 'Marisol', weekDate: '2026-10-19' } } as unknown as Grid;
    expect(recoveriesForDate(grid, '2026-10-22', asgs)).toHaveLength(1);
    expect(recoveriesForDate(grid, '2026-10-22', asgs, idx)).toHaveLength(0);
  });
});

describe('asistencias y /revisiones no ven la clase bloqueada', () => {
  const asgs = [asgn('Marisol')];
  const teacher = { id: T, grid: {} } as never;
  it('buildAttendanceRows: sin "No ingresó" dentro del episodio', () => {
    const rows = buildAttendanceRows({
      assignments: asgs, joinLogs: [], teacherId: T,
      fromDate: '2026-10-21', toDate: '2026-10-29', todayIso: '2026-10-30', nowMinutes: 600,
      periodsByTeacher: { [T]: periodIndex(asgs, [], T, [hold()]) },
    });
    // Mié 21 (antes del episodio) y Mié 28 / Jue 29 (después): el jueves 22 no.
    expect(rows.map(r => r.date).sort()).toEqual(['2026-10-21', '2026-10-28', '2026-10-29']);
  });
  it('buildMissingJoinClasses: no se ofrece reclamar', () => {
    const base = {
      assignments: asgs, joinLogs: [], classRecords: [], requests: [], analyses: [],
      teacherId: T, fromDate: '2026-10-21', toDate: '2026-10-29', todayIso: '2026-10-30', nowMinutes: 600,
      gridOccupancy: gridOccupancyOfTeacher(teacher), onlyWithSignal: false,
    };
    const sin = buildMissingJoinClasses(base).map(c => c.date);
    const con = buildMissingJoinClasses({ ...base, holds: [hold()] }).map(c => c.date);
    expect(sin).toContain('2026-10-22');
    expect(con).not.toContain('2026-10-22');
    expect(con).toContain('2026-10-28');
  });
});

describe('transiciones', () => {
  it('abre en on-hold, cierra al salir, no toca si Woo no contesta', () => {
    expect(holdActionFor({ status: 'on-hold', active: false, hasOpenHold: false })).toBe('abrir');
    expect(holdActionFor({ status: 'on-hold', active: false, hasOpenHold: true })).toBe('nada');
    expect(holdActionFor({ status: 'active', active: true, hasOpenHold: true })).toBe('cerrar');
    expect(holdActionFor({ status: 'cancelled', active: false, hasOpenHold: true })).toBe('cerrar');
    expect(holdActionFor({ status: 'error', active: null, hasOpenHold: true })).toBe('nada');
    expect(holdActionFor({ status: 'active', active: true, hasOpenHold: false })).toBe('nada');
  });
  it('Pausa, pending-cancel, manual y Oritalk nunca son pago pendiente', () => {
    for (const s of ['paused', 'pending-cancel', 'manual_override', 'manual_active', 'oritalk', 'one_time_no_access']) {
      expect(isPaymentHoldStatus(s)).toBe(false);
    }
    expect(isPaymentHoldStatus('on-hold')).toBe(true);
  });
  it('la reactivación solo con un estado que da acceso', () => {
    expect(isAccessStatus('active')).toBe(true);
    expect(isAccessStatus('pending-cancel')).toBe(true);
    expect(isAccessStatus('oritalk')).toBe(true);
    expect(isAccessStatus('cancelled')).toBe(false);
    expect(isAccessStatus('paused')).toBe(false);
  });
});

describe('avisos', () => {
  it('el "suspendido" espera la gracia (renovaciones que entran a los segundos)', () => {
    const start = Date.parse('2026-11-02T10:00:00Z');
    const h = { startedAt: new Date(start).toISOString(), endedAt: null, isInitial: false };
    expect(suspendedNoticeDue(h, start + (SUSPENDED_EMAIL_GRACE_MIN - 1) * 60_000)).toBe(false);
    expect(suspendedNoticeDue(h, start + SUSPENDED_EMAIL_GRACE_MIN * 60_000)).toBe(true);
    expect(suspendedNoticeDue({ ...h, endedAt: new Date(start + 5000).toISOString() }, start + 3_600_000)).toBe(false);
    expect(suspendedNoticeDue({ ...h, isInitial: true }, start + 3_600_000)).toBe(false);
  });
  it('cuentas de prueba fuera, salvo Sebastian (t1)', () => {
    expect(shouldNotifyTeacher({ teacherId: 't24' })).toBe(true);
    expect(shouldNotifyTeacher({ teacherId: 't24', studentIsTest: true })).toBe(false);
    expect(shouldNotifyTeacher({ teacherId: 't9', teacherIsTest: true })).toBe(false);
    expect(shouldNotifyTeacher({ teacherId: 't1', teacherIsTest: true, studentIsTest: true })).toBe(true);
  });
  it('un id por episodio, profesor y tipo', () => {
    expect(noticeIdOf('hold_x', 't1', 'suspendido')).not.toBe(noticeIdOf('hold_x', 't1', 'reactivado'));
    expect(noticeIdOf('hold_x', 't1', 'suspendido')).toBe(noticeIdOf('hold_x', 't1', 'suspendido'));
  });
  it('episodios anteriores al arranque: iniciales (sin emails)', () => {
    expect(isInitialHold(Date.parse('2026-10-20T08:00:00Z'))).toBe(true);
    expect(isInitialHold(Date.parse('2026-11-01T08:00:00Z'))).toBe(false);
  });
});

describe('inicio real del episodio en WooCommerce', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  it('reconoce la nota del cambio a En espera (español e inglés)', () => {
    expect(isOnHoldStatusNote('El estado ha cambiado de Activa a En espera.')).toBe(true);
    expect(isOnHoldStatusNote('Status changed from Active to On hold.')).toBe(true);
    expect(isOnHoldStatusNote('El estado ha cambiado de En espera a Activa.')).toBe(false);
    expect(isOnHoldStatusNote('Pago de renovación fallido.')).toBe(false);
  });
  it('la nota más reciente manda; si no hay, el pedido de renovación fallido', () => {
    const notes = [
      { note: 'El estado ha cambiado de Activa a En espera.', date_created_gmt: '2026-09-20T08:00:00' },
      { note: 'El estado ha cambiado de Activa a En espera.', date_created_gmt: '2026-10-20T08:00:00' },
      { note: 'El estado ha cambiado de En espera a Activa.', date_created_gmt: '2026-09-21T08:00:00' },
    ];
    expect(holdStartFromWoo({ notes, nowMs: now })).toEqual({ ms: Date.parse('2026-10-20T08:00:00Z'), source: 'nota' });
    const orders = [
      { status: 'completed', date_created_gmt: '2026-09-20T08:00:00' },
      { status: 'failed', date_created_gmt: '2026-10-20T07:59:00' },
    ];
    expect(holdStartFromWoo({ orders, nowMs: now })).toEqual({ ms: Date.parse('2026-10-20T07:59:00Z'), source: 'pedido' });
    expect(holdStartFromWoo({ nowMs: now })).toBeNull();
  });
});
