// Cadencia del follow-up de la prueba de nivel (septiembre de 2026): un solo
// reloj desde el enlace, días 1, 2, 3 · 6, 9 · 16, 23… 65, trece envíos, y los
// cortes (prueba hecha, baja, "No enviar más").
import { describe, it, expect } from 'vitest';
import {
  nextReminderStep, buildPendingList, calendarDaysSince, etapaDe, stepLabel,
  FOLLOWUP_DAYS, MAX_FOLLOWUPS,
  type FormTokenRow, type StudentRow, type TestSessionRow, type FollowupRow,
} from '@/lib/formReminders';

// 10:00 de Madrid en verano = 08:00Z.
const dia = (n: number) => new Date(Date.UTC(2026, 8, 1 + n, 8, 0, 0)).getTime();
const iso = (n: number, h = 8) => new Date(Date.UTC(2026, 8, 1 + n, h, 0, 0)).toISOString();

describe('cadencia', () => {
  it('trece envíos en los días acordados', () => {
    expect(FOLLOWUP_DAYS).toEqual([1, 2, 3, 6, 9, 16, 23, 30, 37, 44, 51, 58, 65]);
    expect(MAX_FOLLOWUPS).toBe(13);
    expect(etapaDe(1)).toBe('recordatorio');
    expect(etapaDe(3)).toBe('recordatorio');
    expect(etapaDe(4)).toBe('espera');
    expect(etapaDe(5)).toBe('espera');
    expect(etapaDe(6)).toBe('semanal');
    expect(etapaDe(14)).toBe('semanal');
    expect(stepLabel(4)).toBe('4º envío');
  });

  it('cuenta días de calendario en España, no bloques de 24 h', () => {
    // Enlace a las 10:05 del día 0; cron a las 10:00 del día 1: ya es día 1.
    expect(calendarDaysSince(iso(0, 8.1), dia(1))).toBe(1);
    expect(calendarDaysSince(iso(0), dia(0))).toBe(0);
    expect(calendarDaysSince(null, dia(0))).toBe(-1);
  });

  it('alumno nuevo: día 0 nada, día 1 el primero, día 2 el segundo…', () => {
    expect(nextReminderStep({ count: 0, lastSent: null, baseDate: iso(0), now: dia(0) }).step).toBeNull();
    expect(nextReminderStep({ count: 0, lastSent: null, baseDate: iso(0), now: dia(1) }).step).toBe(1);
    expect(nextReminderStep({ count: 1, lastSent: iso(1), baseDate: iso(0), now: dia(2) }).step).toBe(2);
    expect(nextReminderStep({ count: 2, lastSent: iso(2), baseDate: iso(0), now: dia(3) }).step).toBe(3);
    // Día 4 y 5: nada. Día 6: el cuarto.
    expect(nextReminderStep({ count: 3, lastSent: iso(3), baseDate: iso(0), now: dia(4) })).toMatchObject({ step: null, skipReason: 'esperando_dias' });
    expect(nextReminderStep({ count: 3, lastSent: iso(3), baseDate: iso(0), now: dia(6) }).step).toBe(4);
    expect(nextReminderStep({ count: 4, lastSent: iso(6), baseDate: iso(0), now: dia(9) }).step).toBe(5);
    expect(nextReminderStep({ count: 5, lastSent: iso(9), baseDate: iso(0), now: dia(16) }).step).toBe(6);
    expect(nextReminderStep({ count: 12, lastSent: iso(58), baseDate: iso(0), now: dia(65) }).step).toBe(13);
  });

  it('el mismo día no salen dos (idempotencia por calendario)', () => {
    // Ya salió el 1º hoy: ni el 2º (es del día 2) ni una repetición.
    expect(nextReminderStep({ count: 1, lastSent: iso(1, 8), baseDate: iso(0), now: dia(1) + 3_600_000 }).step).toBeNull();
    // Rezagado con el 1º enviado hoy: el 2º ya cumpliría los días, pero no el hueco.
    expect(nextReminderStep({ count: 1, lastSent: iso(40, 8), baseDate: iso(0), now: dia(40) + 3_600_000 }))
      .toMatchObject({ step: null, skipReason: 'esperando_espaciado' });
  });

  it('rezagado: empieza por el primero y respeta el hueco de la serie desde el anterior', () => {
    // Enlace hace 40 días, cero envíos: hoy el 1º…
    expect(nextReminderStep({ count: 0, lastSent: null, baseDate: iso(0), now: dia(40) }).step).toBe(1);
    // …mañana el 2º, pasado el 3º, y el 4º tres días después del 3º.
    expect(nextReminderStep({ count: 1, lastSent: iso(40), baseDate: iso(0), now: dia(41) }).step).toBe(2);
    expect(nextReminderStep({ count: 3, lastSent: iso(42), baseDate: iso(0), now: dia(43) })).toMatchObject({ step: null, skipReason: 'esperando_espaciado' });
    expect(nextReminderStep({ count: 3, lastSent: iso(42), baseDate: iso(0), now: dia(45) }).step).toBe(4);
    // Semanales: siete días entre uno y otro.
    expect(nextReminderStep({ count: 6, lastSent: iso(55), baseDate: iso(0), now: dia(60) })).toMatchObject({ step: null });
    expect(nextReminderStep({ count: 6, lastSent: iso(55), baseDate: iso(0), now: dia(62) }).step).toBe(7);
  });

  it('tope de 13 y "No enviar más"', () => {
    expect(nextReminderStep({ count: 13, lastSent: iso(65), baseDate: iso(0), now: dia(80) })).toMatchObject({ step: null, skipReason: 'tope_alcanzado' });
    expect(nextReminderStep({ count: 2, lastSent: iso(2), baseDate: iso(0), now: dia(3), optOut: true })).toMatchObject({ step: null, skipReason: 'no_enviar' });
  });

  it('el enlace creado por el propio follow-up manda su primer correo el mismo día', () => {
    expect(nextReminderStep({ count: 0, lastSent: null, baseDate: iso(0), now: dia(0), primeroInmediato: true }).step).toBe(1);
  });
});

describe('buildPendingList (un solo reloj)', () => {
  const token = (o: Partial<FormTokenRow>): FormTokenRow => ({
    id: 'ft1', token: 'tok1', student_id: 's1', student_name: 'Laura', student_email: 'Laura@X.com ',
    teacher_id: 'p1', teacher_name: 'Seba', assignment_id: null, plan: null, level: null,
    status: 'pending', created_at: iso(0), completed_at: null, expires_at: iso(30),
    form_reminder_count: 0, form_reminder_last_sent: null, test_reminder_count: 0, test_reminder_last_sent: null,
    reminder_variant: null, ...o,
  });
  const students: StudentRow[] = [{ id: 's1', name: 'Laura', email: 'laura@x.com' }];
  const sinSesiones: TestSessionRow[] = [];

  it('formulario pendiente → le falta todo; el reloj es el enlace', () => {
    const [e] = buildPendingList({ tokens: [token({})], students, sessions: sinSesiones, dropouts: [], now: dia(1), followups: [] });
    expect(e.sequence).toBe('formulario');
    expect(e.baseDate).toBe(iso(0));
    expect(e.days).toBe(1);
    expect(e.step).toBe(1);
    expect(e.email).toBe('laura@x.com');
  });

  it('formulario hecho sin prueba → solo la prueba, MISMO reloj y MISMO contador', () => {
    const followups: FollowupRow[] = [
      { student_id: 's1', numero_envio: 1, sent_at: iso(1), status: 'sent' },
      { student_id: 's1', numero_envio: 2, sent_at: iso(2), status: 'sent' },
    ];
    const [e] = buildPendingList({
      tokens: [token({ status: 'completed', completed_at: iso(2) })],
      students, sessions: sinSesiones, dropouts: [], now: dia(3), followups,
    });
    expect(e.sequence).toBe('test');
    expect(e.baseDate).toBe(iso(0));
    expect(e.count).toBe(2);
    expect(e.step).toBe(3);
  });

  it('prueba completada → fuera; baja → fuera; opt-out → dentro pero sin envío', () => {
    expect(buildPendingList({
      tokens: [token({})], students, dropouts: [], now: dia(1), followups: [],
      sessions: [{ student_id: 's1', student_name: 'Laura', candidate_name: 'Laura', status: 'completed' }],
    })).toHaveLength(0);
    expect(buildPendingList({
      tokens: [token({})], students, sessions: sinSesiones, now: dia(1), followups: [],
      dropouts: [{ student_id: 's1', student_name: 'Laura' }],
    })).toHaveLength(0);
    const [e] = buildPendingList({
      tokens: [token({})], sessions: sinSesiones, dropouts: [], now: dia(1), followups: [],
      students: [{ id: 's1', name: 'Laura', email: 'laura@x.com', followup_opt_out: true }],
    });
    expect(e.step).toBeNull();
    expect(e.skipReason).toBe('no_enviar');
  });

  it('el email de students manda; el de la assignment queda como alternativo si difiere', () => {
    const [e] = buildPendingList({
      tokens: [token({})], students, sessions: sinSesiones, dropouts: [], now: dia(1), followups: [],
      assignments: [{ student_id: 's1', student_name: 'Laura', student_email: 'OTRO@x.com' }],
    });
    expect(e.email).toBe('laura@x.com');
    expect(e.emailAlt).toBe('otro@x.com');
  });

  it('sin la tabla de envíos cae a los contadores espejo del token', () => {
    const [e] = buildPendingList({
      tokens: [token({ form_reminder_count: 2, form_reminder_last_sent: iso(2) })],
      students, sessions: sinSesiones, dropouts: [], now: dia(3),
    });
    expect(e.count).toBe(2);
    expect(e.step).toBe(3);
  });
});
