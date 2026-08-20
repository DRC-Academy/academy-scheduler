import { describe, it, expect } from 'vitest';
import { testStateOf, type LevelTestInfo } from './levelTestClient';

// testStateOf decide el badge del admin y si getOrCreateTestLink reutiliza el
// enlace o genera uno nuevo. Tenía un `return 'pending'` final que se tragaba en
// silencio cualquier estado que no reconociera: un test abandonado habría
// aparecido como "Pendiente" sin error ninguno. De ahí estos tests.

const AYER = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const MANANA = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function sesion(over: Partial<LevelTestInfo> = {}): LevelTestInfo {
  return {
    id: 's1', token: 't1', status: 'in_progress',
    expires_at: MANANA, completed_at: null,
    student_id: null, student_name: 'Ana', candidate_name: 'Ana', candidate_email: 'a@b.c',
    cefr_level: null, overall_score: null, created_at: AYER,
    answered_count: 0,
    ...over,
  };
}

describe('testStateOf', () => {
  it('sin sesión, none', () => {
    expect(testStateOf(null)).toBe('none');
    expect(testStateOf(undefined)).toBe('none');
  });

  it('completado gana sobre la caducidad: el nivel ya está emitido', () => {
    const s = sesion({ status: 'completed', expires_at: AYER, cefr_level: 'B1', answered_count: 17 });
    expect(testStateOf(s)).toBe('completed');
  });

  it('vigente y empezado, in_progress', () => {
    expect(testStateOf(sesion({ status: 'in_progress', answered_count: 8 }))).toBe('in_progress');
  });

  it('vigente y sin empezar, pending', () => {
    expect(testStateOf(sesion({ status: 'pending' }))).toBe('pending');
  });

  it('el estado abandoned guardado se respeta', () => {
    expect(testStateOf(sesion({ status: 'abandoned', expires_at: AYER, answered_count: 9 }))).toBe('abandoned');
  });

  // El caso que motivó el cambio: la marca en la base es perezosa (se escribe al
  // abrir el enlace) y un enlace abandonado no se vuelve a abrir. Sin deducirlo,
  // estas sesiones se quedarían para siempre como "Expirado".
  it('caducado a medias y todavía sin marcar en la base: se deduce abandoned', () => {
    const s = sesion({ status: 'in_progress', expires_at: AYER, answered_count: 9, cefr_level: null });
    expect(testStateOf(s)).toBe('abandoned');
  });

  it('caducado sin abrirse nunca: expired, no abandoned', () => {
    const s = sesion({ status: 'pending', expires_at: AYER, answered_count: 0 });
    expect(testStateOf(s)).toBe('expired');
  });

  it('sin answered_count (SQL v2 sin correr) no inventa abandonos', () => {
    const s = sesion({ status: 'in_progress', expires_at: AYER, answered_count: undefined });
    expect(testStateOf(s)).toBe('expired');
  });
});
