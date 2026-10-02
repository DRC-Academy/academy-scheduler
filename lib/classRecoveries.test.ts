import { describe, expect, it } from 'vitest';
import {
  isRecoveryBetaTeacher, noticeMinutes, isLateNotice, wildcardOutcome, slotProblems,
  validateTeacherProposals, validateStudentProposals, canTransition, statusAfterNone,
  proposalsExpired, spainMonthOf, fechaLarga, claseDe, cuandoEs, slotHours,
  teacherProposalDays, teacherSlotProblems,
  PENALTY_START_DATE, type PriorCancellation,
} from '@/lib/classRecoveries';

/** Instante de una hora de pared española (CEST, +2, en octubre hasta el 25). */
const madrid = (iso: string, hh: number, mm = 0) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), hh - 2, mm);
const at = (iso: string, hh: number, mm = 0) => new Date(madrid(iso, hh, mm)).toISOString();
const late = (groupId: string, cancelledAt: string, status: PriorCancellation['status'] = 'esperando_alumno'): PriorCancellation =>
  ({ groupId, cancelledAt, late: true, status });
const libre = () => null;

describe('beta', () => {
  it('solo Sebastián (t1)', () => {
    expect(isRecoveryBetaTeacher('t1')).toBe(true);
    expect(isRecoveryBetaTeacher('t2')).toBe(false);
    expect(isRecoveryBetaTeacher(null)).toBe(false);
  });
});

describe('antelación (minutos exactos, hora de España)', () => {
  it('cuenta los minutos hasta el inicio', () => {
    expect(noticeMinutes({ date: '2026-10-20', hour: '17:00' }, madrid('2026-10-19', 16, 30))).toBe(24 * 60 + 30);
  });
  it('justo 24 h es CON antelación; 23:59 es sin', () => {
    expect(isLateNotice(noticeMinutes({ date: '2026-10-20', hour: '17:00' }, madrid('2026-10-19', 17)))).toBe(false);
    expect(isLateNotice(noticeMinutes({ date: '2026-10-20', hour: '17:00' }, madrid('2026-10-19', 17, 1)))).toBe(true);
  });
  it('el mes es el de España, no el UTC', () => {
    // 31/10 a las 23:30 UTC ya es el 1/11 a las 00:30 en Madrid (invierno, +1).
    expect(spainMonthOf(new Date(Date.UTC(2026, 9, 31, 23, 30)))).toBe('2026-11');
  });
});

describe('comodines', () => {
  const NOV = (d: number, h = 10) => at(`2026-11-${String(d).padStart(2, '0')}`, h);

  it('1.ª y 2.ª: gastan comodín, sin multa; 3.ª: multa', () => {
    const p1 = wildcardOutcome({ prior: [], cancelledAt: NOV(2), late: true });
    expect(p1).toMatchObject({ position: 1, usedWildcard: true, wildcardsLeft: 1, penaltyApplies: false, penaltyEuros: 0 });
    const p2 = wildcardOutcome({ prior: [late('g1', NOV(2))], cancelledAt: NOV(3), late: true });
    expect(p2).toMatchObject({ position: 2, usedWildcard: true, wildcardsLeft: 0, penaltyApplies: false });
    const p3 = wildcardOutcome({ prior: [late('g1', NOV(2)), late('g2', NOV(3))], cancelledAt: NOV(4), late: true });
    expect(p3).toMatchObject({ position: 3, usedWildcard: false, penaltyApplies: true, chargeNow: true, penaltyEuros: -5 });
  });

  it('con más de 24 h: gratis y no gasta comodín', () => {
    const r = wildcardOutcome({ prior: [late('g1', NOV(2)), late('g2', NOV(3))], cancelledAt: NOV(4), late: false });
    expect(r).toMatchObject({ position: null, usedWildcard: false, penaltyEuros: 0, wildcardsLeft: 0 });
  });

  it('el cambio de mes reinicia los comodines', () => {
    const prior = [late('g1', at('2026-10-30', 10)), late('g2', at('2026-10-31', 10))];
    expect(wildcardOutcome({ prior, cancelledAt: NOV(1), late: true })).toMatchObject({ position: 1, penaltyApplies: false });
  });

  it('una cancelación anulada no cuenta', () => {
    const prior = [late('g1', NOV(2), 'anulada'), late('g2', NOV(3))];
    expect(wildcardOutcome({ prior, cancelledAt: NOV(4), late: true })).toMatchObject({ position: 2, penaltyApplies: false });
  });

  it('las dos partes de una sesión partida son UNA cancelación', () => {
    const prior = [late('g1', NOV(2)), late('g1', NOV(2))];
    expect(wildcardOutcome({ prior, cancelledAt: NOV(3), late: true })).toMatchObject({ position: 2 });
  });

  it('guardada: su posición sale del orden, aunque otra llegue a la vez', () => {
    const prior = [late('g1', NOV(2)), late('gA', NOV(5)), late('gB', NOV(5))];
    expect(wildcardOutcome({ prior, groupId: 'gA', cancelledAt: NOV(5), late: true }).position).toBe(2);
    expect(wildcardOutcome({ prior, groupId: 'gB', cancelledAt: NOV(5), late: true }).position).toBe(3);
  });

  it(`antes del ${PENALTY_START_DATE}: avisa pero no cobra`, () => {
    const prior = [late('g1', at('2026-10-02', 10)), late('g2', at('2026-10-03', 10))];
    const antes = wildcardOutcome({ prior, cancelledAt: at('2026-10-14', 23, 30), late: true });
    expect(antes).toMatchObject({ penaltyApplies: true, chargeNow: false, wouldHavePenalty: true, penaltyEuros: 0 });
    const desde = wildcardOutcome({ prior, cancelledAt: at('2026-10-15', 0, 10), late: true });
    expect(desde).toMatchObject({ penaltyApplies: true, chargeNow: true, wouldHavePenalty: false, penaltyEuros: -5 });
  });
});

describe('fechas propuestas', () => {
  const now = madrid('2026-10-19', 12);   // lunes 19/10 a las 12:00
  const original = { date: '2026-10-20', hour: '17:00' };

  it('vale una fecha futura dentro de 7 días, incluso ANTES de la clase original', () => {
    expect(slotProblems({ date: '2026-10-19', hour: '18:00', hours: 1 }, { nowMs: now, occupied: libre, original })).toEqual([]);
  });
  it('rechaza el pasado, más allá de 7 días y los domingos', () => {
    expect(slotProblems({ date: '2026-10-19', hour: '11:00', hours: 1 }, { nowMs: now, occupied: libre })[0]).toMatch(/ya pasó/);
    expect(slotProblems({ date: '2026-10-27', hour: '10:00', hours: 1 }, { nowMs: now, occupied: libre })[0]).toMatch(/próximos 7 días/);
    expect(slotProblems({ date: '2026-10-25', hour: '10:00', hours: 1 }, { nowMs: now, occupied: libre })[0]).toMatch(/domingos/);
  });
  it('rechaza un hueco ocupado (también la segunda hora de una sesión de 2 h)', () => {
    const occupied = (d: string, h: string) => (h === '19:00' ? 'Ocupado por Ana' : null);
    expect(slotProblems({ date: '2026-10-21', hour: '18:00', hours: 2 }, { nowMs: now, occupied })).toEqual(['Ocupado por Ana']);
  });
  it('dos obligatorias y distintas; con "ya lo acordé", una', () => {
    const a = { date: '2026-10-21', hour: '17:00', hours: 1 };
    expect(validateTeacherProposals([a], { agreedDirectly: false, nowMs: now, occupied: libre, original }).ok).toBe(false);
    expect(validateTeacherProposals([a, a], { agreedDirectly: false, nowMs: now, occupied: libre, original }).general).toContain('Las dos fechas propuestas son iguales.');
    expect(validateTeacherProposals([a, { ...a, hour: '18:00' }], { agreedDirectly: false, nowMs: now, occupied: libre, original }).ok).toBe(true);
    expect(validateTeacherProposals([a], { agreedDirectly: true, nowMs: now, occupied: libre, original }).ok).toBe(true);
  });
  it('el profesor no puede proponer hoy: desde mañana', () => {
    const hoy = { date: '2026-10-19', hour: '18:00', hours: 1 };
    const r = validateTeacherProposals([hoy, { date: '2026-10-21', hour: '17:00', hours: 1 }], { agreedDirectly: false, nowMs: now, occupied: libre, original });
    expect(r.ok).toBe(false);
    expect(r.perSlot[0]).toEqual(['Tiene que ser a partir de mañana.']);
    expect(r.perSlot[1]).toEqual([]);
    // Una hora de hoy que ya pasó dice solo eso.
    expect(teacherSlotProblems({ date: '2026-10-19', hour: '11:00', hours: 1 }, { nowMs: now, occupied: libre })).toEqual([expect.stringMatching(/ya pasó/)]);
  });
  it('días que puede proponer el profesor: mañana y los 7 días, sin domingos', () => {
    // Lunes 19/10 → martes 20 a lunes 26, sin el domingo 25.
    expect(teacherProposalDays(now)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-26']);
    // De noche en España sigue siendo el mismo día.
    expect(teacherProposalDays(madrid('2026-10-19', 23))[0]).toBe('2026-10-20');
  });
  it('horarios del alumno: 1 a 3, futuros, en 7 días, nota corta', () => {
    expect(validateStudentProposals([{ date: '2026-10-22', hour: '18:00' }], 'ok', now)).toEqual([]);
    expect(validateStudentProposals([], null, now)).not.toEqual([]);
    expect(validateStudentProposals(Array(4).fill({ date: '2026-10-22', hour: '18:00' }), null, now).join(' ')).toMatch(/máximo 3/);
    expect(validateStudentProposals([{ date: '2026-10-22', hour: '18:00' }], 'x'.repeat(501), now).join(' ')).toMatch(/500/);
  });
  it('la espera vence cuando pasaron TODAS las fechas', () => {
    const s = [{ date: '2026-10-19', hour: '10:00', hours: 1 }, { date: '2026-10-19', hour: '18:00', hours: 1 }];
    expect(proposalsExpired(s, now)).toBe(false);
    expect(proposalsExpired(s, madrid('2026-10-19', 18, 1))).toBe(true);
  });
  it('una sesión de 2 h ocupa dos horas', () => {
    expect(slotHours({ date: '2026-10-21', hour: '9:00', hours: 2 })).toEqual([
      { date: '2026-10-21', hour: '09:00' }, { date: '2026-10-21', hour: '10:00' },
    ]);
  });
});

describe('estados', () => {
  it('transiciones permitidas', () => {
    expect(canTransition('esperando_alumno', 'confirmada')).toBe(true);
    expect(canTransition('alumno_propuso', 'esperando_alumno')).toBe(true);
    expect(canTransition('confirmada', 'esperando_alumno')).toBe(false);
    expect(canTransition('anulada', 'confirmada')).toBe(false);
    expect(canTransition('sin_acuerdo', 'anulada')).toBe(true);
  });
  it('"ninguna": a la 2.ª ronda ya no hay más vueltas', () => {
    expect(statusAfterNone(1)).toBe('alumno_propuso');
    expect(statusAfterNone(2)).toBe('sin_acuerdo');
  });
});

describe('textos', () => {
  it('fechas en español', () => {
    expect(fechaLarga('2026-10-12')).toBe('lunes 12 de octubre');
    expect(claseDe('2026-10-20', '2026-10-19')).toBe('la clase de mañana');
    expect(claseDe('2026-10-19', '2026-10-19')).toBe('la clase de hoy');
    expect(claseDe('2026-10-22', '2026-10-19')).toBe('la clase del jueves 22 de octubre');
    expect(cuandoEs({ date: '2026-10-12', hour: '17' })).toBe('el lunes 12 de octubre a las 17:00');
  });
});
