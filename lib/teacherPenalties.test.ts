import { describe, expect, it } from 'vitest';
import {
  faltaEventId, absenceIdOfFaltaEvent, faltaApplies, countsForPenalties, eventMonthOf, spainMonthOfInstant,
  isCountedLateCancellation, teacherPenaltiesInMonth, faltaBellBody, FALTA_EVENT_TYPE, FALTA_PENALTY_EUROS,
  type CountableRecovery,
} from '@/lib/teacherPenalties';
import { absenceIdOf } from '@/lib/teacherAbsences';
import type { ScoringEvent } from '@/types';

const rec = (o: Partial<CountableRecovery> = {}): CountableRecovery => ({
  groupId: 'g1', teacherId: 't3', studentName: 'Ana', originalDate: '2026-10-26',
  cancelledAt: '2026-10-25T08:00:00Z', late: true, status: 'esperando_alumno', origin: 'profesor', ...o,
});
const ev = (o: Partial<ScoringEvent> = {}): ScoringEvent => ({
  id: 'e', teacherId: 't3', teacherName: 'Johny', eventType: FALTA_EVENT_TYPE, points: 0, euros: -10,
  note: 'Falta', createdAt: '2026-10-25T10:00:00Z', createdBy: 'sistema', appliesMonth: '2026-10', ...o,
});

describe('falta: importe e ids', () => {
  it('son 10 €', () => {
    expect(FALTA_PENALTY_EUROS).toBe(10);
  });

  it('el id del evento sale de la ausencia de la clase: detección y reclasificación coinciden', () => {
    const aus = absenceIdOf('t3', 'Alberto González', '2026-10-23', '18:00');
    expect(faltaEventId(aus)).toBe(`se_falta_prof_${aus}`);
    // La reclasificación llega con '18:00' o con 18: mismo id, mismo evento.
    expect(faltaEventId(absenceIdOf('t3', 'Alberto González', '2026-10-23', 18))).toBe(faltaEventId(aus));
    expect(absenceIdOfFaltaEvent(faltaEventId(aus))).toBe(aus);
    expect(absenceIdOfFaltaEvent('se_cancel_prof_grp_x')).toBeNull();
  });
});

describe('falta: cuándo se cobra', () => {
  it('solo clases desde el 22/10', () => {
    expect(faltaApplies({ classDate: '2026-10-21', isTestTeacher: false })).toBe(false);
    expect(faltaApplies({ classDate: '2026-10-22', isTestTeacher: false })).toBe(true);
  });
  it('nunca a una cuenta de prueba', () => {
    expect(faltaApplies({ classDate: '2026-11-02', isTestTeacher: true })).toBe(false);
  });
  it('las cancelaciones cuentan desde el 22/10', () => {
    expect(countsForPenalties('2026-10-21')).toBe(false);
    expect(countsForPenalties('2026-10-22')).toBe(true);
  });
});

describe('mes de cada multa (hora de España)', () => {
  it('manda el mes fijado: la falta del 31/10 confirmada después sigue en octubre', () => {
    expect(eventMonthOf({ createdAt: '2026-11-01T09:00:00Z', appliesMonth: '2026-10' })).toBe('2026-10');
  });
  it('sin mes fijado, el de createdAt en hora de España (no UTC)', () => {
    // 31/10 23:30 UTC = 1/11 00:30 en Madrid.
    expect(eventMonthOf({ createdAt: '2026-10-31T23:30:00Z' })).toBe('2026-11');
    expect(eventMonthOf({ createdAt: '2026-10-15T19:53:00Z' })).toBe('2026-10');
    expect(spainMonthOfInstant(undefined)).toBe('');
  });
});

describe('contadores del sistema único', () => {
  it('cancelación tardía: del profesor, sin anular y desde el 22/10', () => {
    expect(isCountedLateCancellation(rec())).toBe(true);
    expect(isCountedLateCancellation(rec({ late: false }))).toBe(false);
    expect(isCountedLateCancellation(rec({ status: 'anulada' }))).toBe(false);
    expect(isCountedLateCancellation(rec({ origin: 'admin_reclasificacion' }))).toBe(false);
    expect(isCountedLateCancellation(rec({ origin: 'ausencia' }))).toBe(false);
    expect(isCountedLateCancellation(rec({ cancelledAt: '2026-10-19T13:57:00Z' }))).toBe(false);
  });

  it('suma cancelaciones (una por grupo) y faltas sin revertir; los −5 € viejos no cuentan', () => {
    const items = teacherPenaltiesInMonth({
      teacherId: 't3', month: '2026-10',
      recoveries: [rec(), rec(), rec({ groupId: 'g2', teacherId: 't9' })],
      events: [
        ev(),
        ev({ reverted: true }),
        ev({ appliesMonth: '2026-11' }),
        ev({ eventType: 'falta_sin_aviso_penalizacion', euros: -5, appliesMonth: undefined }),
        ev({ eventType: 'cancelacion_profesor_penalizacion', euros: -5 }),   // ya contada por su cancelación
      ],
    });
    expect(items.map(i => i.kind)).toEqual(['cancelacion', 'falta']);
  });
});

describe('texto de la campanita', () => {
  it('es el pedido, con la fecha larga', () => {
    expect(faltaBellBody({ hour: '18:00', studentName: 'Alberto Gonzalez', classDate: '2026-10-23' }))
      .toBe('Se ha registrado una falta en tu clase de las 18:00 con Alberto Gonzalez del viernes 23 de octubre. Si es un error, contacta con coordinación.');
  });
});
