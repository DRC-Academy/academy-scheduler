import { describe, it, expect } from 'vitest';
import { decideStudentTest } from './studentTest';
import { pickCanonical, sessionExpired, type SessionSummary } from './canonical';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const s = (o: Partial<SessionSummary>): SessionSummary => ({
  token: 'tok', status: 'pending', expires_at: '2026-10-05T00:00:00Z',
  created_at: '2026-09-28T10:00:00Z', student_id: 'alu1', answered: 0, ...o,
});
const lead = (o: Partial<SessionSummary>) => s({ student_id: null, ...o });

describe('sessionExpired', () => {
  it('la prueba de un alumno no caduca nunca, ni por fecha ni por marca antigua', () => {
    expect(sessionExpired(s({ expires_at: '2026-01-01T00:00:00Z' }), NOW)).toBe(false);
    expect(sessionExpired(s({ status: 'expired' }), NOW)).toBe(false);
    expect(sessionExpired(s({ status: 'abandoned' }), NOW)).toBe(false);
  });
  it('la de un alumno vinculado solo por nombre (con profe, sin student_id) tampoco caduca', () => {
    const porNombre = { student_id: null, teacher_id: 'prof1' };
    expect(sessionExpired({ ...porNombre, expires_at: '2026-01-01T00:00:00Z' }, NOW)).toBe(false);
    expect(sessionExpired({ ...porNombre, status: 'expired' }, NOW)).toBe(false);
    expect(sessionExpired({ ...porNombre, status: 'abandoned' }, NOW)).toBe(false);
  });
  it('pickCanonical no descarta la prueba vieja de un alumno vinculado por nombre', () => {
    const vieja = s({ token: 'nom', student_id: null, teacher_id: 'prof1', expires_at: '2026-08-01T00:00:00Z', answered: 4 });
    expect(pickCanonical([vieja], NOW)).toEqual({ kind: 'open', token: 'nom', answered: 4 });
  });
  it('tras "Regenerar todo" la prueba vieja terminada NO cuenta: manda la nueva', () => {
    const vieja = s({ token: 'vieja', status: 'completed', created_at: '2026-09-25T08:00:00Z', superseded_at: '2026-09-30T10:00:00Z' });
    const nueva = s({ token: 'nueva', status: 'pending', created_at: '2026-09-30T10:00:00Z' });
    expect(pickCanonical([vieja, nueva], NOW)).toEqual({ kind: 'open', token: 'nueva', answered: 0 });
    expect(decideStudentTest([vieja, nueva], NOW)).toEqual({ kind: 'ready', token: 'nueva', started: false });
  });
  it('si todo quedó como historial, no hay prueba principal', () => {
    const vieja = s({ status: 'completed', superseded_at: '2026-09-30T10:00:00Z' });
    expect(pickCanonical([vieja], NOW)).toEqual({ kind: 'none' });
  });
  it('la de un lead caduca por fecha o por marca', () => {
    expect(sessionExpired(lead({ expires_at: '2026-09-28T08:00:00Z' }), NOW)).toBe(true);
    expect(sessionExpired(lead({ status: 'abandoned' }), NOW)).toBe(true);
    expect(sessionExpired(lead({}), NOW)).toBe(false);
  });
});

describe('pickCanonical', () => {
  it('la terminada manda sobre todo', () => {
    expect(pickCanonical([
      s({ token: 'fin', status: 'completed', created_at: '2026-09-01T00:00:00Z' }),
      s({ token: 'nueva', answered: 10 }),
    ], NOW)).toEqual({ kind: 'completed', token: 'fin' });
  });
  it('si no, la que tiene más respuestas, aunque sea vieja y esté marcada abandonada', () => {
    expect(pickCanonical([
      s({ token: 'vieja', status: 'abandoned', answered: 16, created_at: '2026-08-01T00:00:00Z', expires_at: '2026-08-08T00:00:00Z' }),
      s({ token: 'nueva', answered: 0, created_at: '2026-09-27T00:00:00Z' }),
    ], NOW)).toMatchObject({ kind: 'open', token: 'vieja', answered: 16 });
  });
  it('a igualdad de respuestas, la más reciente', () => {
    expect(pickCanonical([
      s({ token: 'a', created_at: '2026-09-20T00:00:00Z' }),
      s({ token: 'b', created_at: '2026-09-27T00:00:00Z' }),
    ], NOW)).toMatchObject({ token: 'b' });
  });
  it('lead caducado → ninguna', () => {
    expect(pickCanonical([lead({ expires_at: '2026-09-01T00:00:00Z' })], NOW)).toEqual({ kind: 'none' });
  });
});

describe('decideStudentTest', () => {
  it('sin sesiones → hay que crear una', () => {
    expect(decideStudentTest([], NOW)).toEqual({ kind: 'none' });
  });
  it('sin respuestas → empezar (aunque se haya abierto)', () => {
    expect(decideStudentTest([s({ token: 'a', status: 'in_progress' })], NOW))
      .toEqual({ kind: 'ready', token: 'a', started: false });
  });
  it('con respuestas → continuar', () => {
    expect(decideStudentTest([s({ status: 'in_progress', answered: 4 })], NOW))
      .toMatchObject({ kind: 'ready', started: true });
  });
  it('fecha pasada de un alumno → sigue siendo la suya (no se crea otra)', () => {
    expect(decideStudentTest([s({ token: 'a', expires_at: '2026-09-28T08:00:00Z' })], NOW))
      .toMatchObject({ kind: 'ready', token: 'a' });
  });
  it('terminada → completed', () => {
    expect(decideStudentTest([s({ status: 'completed' })], NOW)).toEqual({ kind: 'completed' });
  });
});
