import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canTakeLevelTest, type AccessDeps } from './studentAccess';

// Dependencias falsas: cada test dice qué devuelve la base y qué dice Woo.
function deps(o: {
  assignment?: boolean | 'error';
  email?: string | null | 'error';
  woo?: { active: boolean | null; status: string } | 'down';
}): AccessDeps & { wooCalls: () => number } {
  let calls = 0;
  return {
    async hasActiveAssignment() {
      if (o.assignment === 'error') throw new Error('db');
      return o.assignment ?? false;
    },
    async loadEmail() {
      if (o.email === 'error') throw new Error('db');
      return o.email === undefined ? 'alumna@example.com' : o.email;
    },
    async checkSubscription() {
      calls++;
      if (o.woo === 'down' || !o.woo) throw new Error('woo');
      return o.woo;
    },
    wooCalls: () => calls,
  };
}

// Lo que check-subscription devuelve para cada estado (active + status).
const WOO: Array<[string, boolean | null]> = [
  ['active', true],
  ['pending-cancel', true],
  ['manual_override', true],
  ['manual_active', true],
  ['oritalk', true],
  ['scheduled', false],
  ['one_time_no_access', false],
  ['on-hold', false],
  ['pending', false],
  ['switched', false],        // estado que el mapa no conoce
  ['cancelled', false],
  ['expired', false],
  ['not_found', false],
  ['error', null],            // Woo no contestó
];

const BLOQUEA_SIN_ASIGNACION: Record<string, string> = {
  cancelled: 'woo_cancelled_no_assignment',
  expired:   'woo_expired_no_assignment',
  not_found: 'woo_not_found_no_assignment',
};

const MOTIVO_SI_PASA: Record<string, string> = {
  active: 'woo_active', 'pending-cancel': 'woo_active', manual_override: 'woo_active',
  manual_active: 'woo_active', oritalk: 'woo_active',
  scheduled: 'woo_scheduled', one_time_no_access: 'woo_one_time',
  'on-hold': 'woo_on_hold', pending: 'woo_pending', switched: 'woo_other',
  error: 'woo_unavailable',
};

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('canTakeLevelTest: con asignación activa pasa siempre', () => {
  it.each(WOO)('Woo %s → pasa por la asignación, sin preguntar a Woo', async (status, active) => {
    const d = deps({ assignment: true, woo: { active, status } });
    const r = await canTakeLevelTest('alu1', d);
    expect(r).toEqual({ allowed: true, reason: 'assignment_active', wooStatus: null });
    expect(d.wooCalls()).toBe(0);
  });
});

describe('canTakeLevelTest: sin asignación activa decide Woo', () => {
  it.each(WOO)('Woo %s', async (status, active) => {
    const r = await canTakeLevelTest('alu1', deps({ assignment: false, woo: { active, status } }));
    const bloqueo = BLOQUEA_SIN_ASIGNACION[status];
    if (bloqueo) {
      expect(r).toEqual({ allowed: false, reason: bloqueo, wooStatus: status });
    } else {
      expect(r).toEqual({ allowed: true, reason: MOTIVO_SI_PASA[status], wooStatus: status });
    }
  });

  it('los seis alumnos bloqueados el 29/09/2026 (scheduled y pago único) pasan', async () => {
    for (const status of ['scheduled', 'one_time_no_access']) {
      const r = await canTakeLevelTest('alu1', deps({ assignment: false, woo: { active: false, status } }));
      expect(r.allowed).toBe(true);
    }
  });
});

describe('canTakeLevelTest: sin email', () => {
  it('con asignación activa → pasa', async () => {
    const r = await canTakeLevelTest('alu1', deps({ assignment: true, email: null }));
    expect(r).toMatchObject({ allowed: true, reason: 'assignment_active' });
  });
  it('sin asignación activa → no pasa, y no se pregunta a Woo', async () => {
    const d = deps({ assignment: false, email: null });
    const r = await canTakeLevelTest('alu1', d);
    expect(r).toEqual({ allowed: false, reason: 'no_email_no_assignment', wooStatus: null });
    expect(d.wooCalls()).toBe(0);
  });
});

describe('canTakeLevelTest: ante un fallo nuestro, deja pasar', () => {
  it('Woo caído (lanza) sin asignación → pasa', async () => {
    const r = await canTakeLevelTest('alu1', deps({ assignment: false, woo: 'down' }));
    expect(r).toMatchObject({ allowed: true, reason: 'woo_unavailable' });
  });
  it('falla la lectura de asignaciones → pasa', async () => {
    const r = await canTakeLevelTest('alu1', deps({ assignment: 'error', woo: { active: false, status: 'cancelled' } }));
    expect(r).toMatchObject({ allowed: true, reason: 'db_error' });
  });
  it('falla la lectura del alumno → pasa', async () => {
    const r = await canTakeLevelTest('alu1', deps({ assignment: false, email: 'error', woo: { active: false, status: 'cancelled' } }));
    expect(r).toMatchObject({ allowed: true, reason: 'db_error' });
  });
});

describe('canTakeLevelTest: registro de bloqueos', () => {
  it('cada bloqueo deja student_id, estado de Woo y motivo en el log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await canTakeLevelTest('alu9', deps({ assignment: false, woo: { active: false, status: 'cancelled' } }));
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      studentId: 'alu9', wooStatus: 'cancelled', reason: 'woo_cancelled_no_assignment',
    });
  });
  it('un acceso permitido no deja aviso', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await canTakeLevelTest('alu9', deps({ assignment: false, woo: { active: false, status: 'scheduled' } }));
    expect(warn).not.toHaveBeenCalled();
  });
});
